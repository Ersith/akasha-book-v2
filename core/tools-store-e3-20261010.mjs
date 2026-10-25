// akasha/tools/store-e3-20261010.mjs —— DSH STORE 一致性验收（E3）：一次性 Profile 装/启/卸
// 设计要点（安全第一）：
//   ① **插件源先复制到临时目录**，再以 file: 安装 —— 防 pnpm remove 目录依赖时清空源目录（AGENTS §1.11 事故）；
//   ② 全部在临时 DSH_HOME / AGENTS_HOME / npm cache 内进行，**绝不触碰真实 profile**；
//   ③ 只读断言：install → dump-config 含入口；cold start → HTTP 就绪；remove → dump-config 回到基线。
// 用法：node store-e3-20261010.mjs --only akasha-gate   （省略 --only 则跑五个）
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = process.argv.includes('--cli')
  ? process.argv[process.argv.indexOf('--cli') + 1]
  : '<DSH_INSTALL>';
const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const OUT = '<LOCAL_PATH>\\_scratch\\store-e3';
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

const PLUGINS = [
  { dir: 'akasha-gate', pkg: '@akasha-book/gate' },
  { dir: 'akasha-hooks', pkg: '@akasha-book/hooks' },
  { dir: 'akasha-session', pkg: '@akasha-book/session' },
  { dir: 'akasha-sleep', pkg: '@akasha-book/sleep' },
  { dir: 'mcp-akasha', pkg: '@akasha-book/mcp' },
].filter((p) => !only || p.dir === only);

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const now = () => new Date().toISOString();

async function run(args, env, cwd) {
  const r = await execFileAsync(process.execPath, [CLI, ...args], { cwd, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  return r.stdout;
}

const results = [];
for (const p of PLUGINS) {
  const root = await mkdtemp(join(tmpdir(), 'akasha-e3-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/(TOKEN|SECRET|PASSWORD|API_KEY|AUTH|CREDENTIAL)/i.test(k)));
  Object.assign(env, {
    DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
    npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, '.npmrc'),
    npm_config_registry: 'https://registry.npmjs.org/', CI: 'true',
  });
  const stages = {};
  let child = null;
  try {
    // ① 复制插件源到临时目录（file: 安装的隔离副本）
    const pkgDir = join(root, 'pkg');
    await mkdir(pkgDir, { recursive: true });
    await cp(join(OSS, 'plugins', p.dir), pkgDir, { recursive: true });
    stages.copy = 'ok';

    // ② 基线：从官方随包模板创建 profile（CLI 语义：profile 需由模板创建；基线＝模板组合）
    const baseline = await run(['--profile', 'e3', '--from-default-profile', 'web', '--dump-config'], env, root);
    stages.dumpConfigBaseline = 'ok（由 shipped web 模板创建）';

    // ③ 安装（同时创建 profile）
    await run(['plugin', '--profile', 'e3', 'add', 'file:' + pkgDir], env, root);
    const afterInstall = await run(['--profile', 'e3', '--dump-config'], env, root);
    if (!afterInstall.includes(p.pkg)) throw Object.assign(new Error('install 后 dump-config 未见 ' + p.pkg), { codes: ['ENTRY-MISSING'] });
    stages.install = 'ok';

    // ④ 冷启动 + HTTP 就绪（撞 Windows 保留端口 EACCES 时换端口重试，最多 3 次）
    let ready = false;
    let lastErr = '';
    for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
      const port = await freePort();
      const base = `http://127.0.0.1:${port}`;
      child = (await import('node:child_process')).spawn(process.execPath, [CLI, '--profile', 'e3', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      // 输出仅用于诊断（宿主非 TTY 时 stdout 全缓冲，冷启动是否成功要看端口/日志而非输出）
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      for (let i = 0; i < 120; i++) {
        try { const r = await fetch(base + '/', { signal: AbortSignal.timeout(3000) }); if (r.status < 500) { ready = true; break; } } catch { /* 未就绪 */ }
        if (child.exitCode !== null) break;
        await new Promise((d) => setTimeout(d, 500));
      }
      if (!ready) {
        // 读启动日志判定是否端口类失败（EACCES/EADDRINUSE → 换端口重试）
        let logTail = '';
        try {
          const logsDir = join(root, 'home', 'logs');
          const { readdirSync } = await import('node:fs');
          const f = readdirSync(logsDir).filter((x) => x.startsWith('startup-')).sort().pop();
          if (f) logTail = String((await import('node:fs')).readFileSync(join(logsDir, f), 'utf8')).slice(0, 4000);
        } catch { /* 无日志 */ }
        lastErr = `attempt${attempt} exit=${child.exitCode} port=${port}` + (logTail.includes('EACCES') ? '（EACCES：Windows 保留端口，换端口重试）' : logTail.includes('EADDRINUSE') ? '（EADDRINUSE，换端口重试）' : '（非端口类失败）');
        if (child && child.exitCode === null) { try { child.kill('SIGTERM'); } catch { /* ignore */ } }
        child = null;
        if (!/EACCES|EADDRINUSE/.test(logTail)) break; // 非端口问题不重试
      }
    }
    if (!ready) throw Object.assign(new Error('冷启动未就绪：' + lastErr), { codes: ['START-TIMEOUT'] });
    stages.coldStart = 'ok';
    child.kill('SIGTERM');
    await new Promise((d) => { const t = setTimeout(d, 10000); child.once('exit', () => { clearTimeout(t); d(); }); });
    child = null;
    stages.stopHost = 'ok';

    // ⑤ 卸载 + 组成还原（dump-config 必须逐字回到基线）
    await run(['plugin', '--profile', 'e3', 'remove', p.pkg], env, root);
    let afterRemove = '';
    try { afterRemove = await run(['--profile', 'e3', '--dump-config'], env, root); }
    catch (e) { afterRemove = ''; stages.afterRemove = 'dump-config 失败：' + String(e.message).slice(0, 120); }
    if (afterRemove.includes(p.pkg)) throw Object.assign(new Error('remove 后 dump-config 仍见 ' + p.pkg), { codes: ['ENTRY-LEFT'] });
    if (afterRemove.trim() !== baseline.trim()) throw Object.assign(new Error('remove 后配置未逐字回到基线（组成未还原）'), { codes: ['COMPOSITION-DRIFT'] });
    stages.uninstall = 'ok';

    // ⑥ 版本读回
    const version = (await run(['--version'], env, root)).trim();
    results.push({ plugin: p.dir, pkg: p.pkg, status: 'passed', dshVersion: version, stages, at: now(), root });
    console.log(`  ✓ ${p.dir}  passed（dsh ${version}；install→start→uninstall→composition 还原）`);
  } catch (e) {
    results.push({ plugin: p.dir, pkg: p.pkg, status: 'failed', stage: Object.keys(stages).pop() ?? 'init', codes: e.codes ?? [], reason: String(e.message).slice(0, 200), stages, at: now(), root });
    console.log(`  ✗ ${p.dir}  failed：${String(e.message).slice(0, 160)}`);
  } finally {
    if (child && child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
  }
}

await mkdir(OUT, { recursive: true });
const summary = join(OUT, `e3-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(summary, JSON.stringify({ cli: CLI, at: now(), results: results.map((r) => ({ ...r, root: r.root })) }, null, 1), 'utf8');
console.log('  报告: ' + summary);
