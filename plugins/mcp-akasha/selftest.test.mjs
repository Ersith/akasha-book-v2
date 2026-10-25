// @akasha-book/mcp 自测：Bundle Patch 契约（STORE 硬门）+ 注册桥端到端（桩 ctx + 真实 MCP 服务器）
// 运行：node selftest.test.mjs（退出码 0 = 全过）；不碰真实 profile、不读任何密钥、不写真实库。
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// OSS tree and the local sibling akasha layout both resolve to the actual core root.
const CORE_CANDIDATES = [
  process.env.AKASHA_CORE,
  join(HERE, '..', '..', 'core'),
  join(HERE, '..', 'core'),
  join(HERE, '..', 'akasha'),
  join(HERE, '..', 'akasha', 'core'),
].filter(Boolean);
const CORE = CORE_CANDIDATES.find((d) => existsSync(join(d, 'lib.mjs')) && existsSync(join(d, 'mcp.mjs')));
assert.ok(CORE, '找不到 akasha 核心 lib.mjs/mcp.mjs；候选：' + CORE_CANDIDATES.join(' | '));

// —— ④-1 源树链接守卫：复制之前的一次性 reparse 检测（只读、绝不跟进）——
// 事故（2026-10-16）：核心目录内一颗 junction（…/derived/akasha → <AKASHA_DIR>）被下面那段
//   全量 cpSync 跟进 ⇒ 无限自嵌套 ⇒ 临时副本涨到 GB 级 ⇒ Windows errno 112「磁盘已满」（42s 崩）；
//   <LOCAL_PATH> 留下 62.5GB / 163 万文件残骸（D 盘一度只剩 1.41GB）。
// 白名单复制（batch7-B）已让深层链接不再被触碰；本守卫再补一道：复制**之前**扫一遍源树，命中
//   「指向 Core 内 / 包含 Core / 就是 Core」的链接（自嵌套类）⇒ 立即报错退出，一个字节都不复制。
// 代价：dirent 扫描 + 逐目录 realpath 交叉校验，实测 ≈0.5s / 1 万条目 / 3.4 千目录（不读文件内容）。
//   AKASHA_LINK_GUARD=strict ⇒ 连「非自嵌套链接」也判红（默认只判自嵌套类：派生副本里的
//   node_modules junction 属正常布局，只点名不拦）。
const LINK_GUARD_STRICT = process.env.AKASHA_LINK_GUARD === 'strict';
const COPY_WHITELIST = ['lib.mjs', 'json-redaction.mjs', 'mcp.mjs', 'session.mjs', 'sleep.mjs', 'loop-detect.mjs', 'akasha.mjs', 'init-example.mjs', 'companion.mjs', 'adapters.mjs'];

// 内联最小示例库（MIX#4·2026-10-17）：源 core 没有 init-example.mjs 时，用它就地播种数据面，
//   让「注册桥端到端」段默认执行而不是整段 SKIP。字段形状取自 init-example.mjs 的同名字段，
//   写入走核心自有 CLI（`add --store <s> --data <json>`，见 `akasha.mjs help`）⇒ 经过与生产同源的校验。
const SEED_EXAMPLE = [
  { store: 'canon', data: { id: 'canon-fixture-seed', claim: '自足夹具最小示例库：由 dsh-mcp-akasha/selftest.test.mjs 内联播种（不依赖 core 的 init-example.mjs）。', source: { type: '复现', ref: 'selftest.test.mjs（内联播种）' }, last_reviewed: '2026-10-17' } },
  { store: 'mirror', data: { id: 'mirror-fixture-seed', story: '示例：夹具自足播种', situation: '夹具缺少 init-example.mjs', behavior: '由 selftest 内联播种最小示例库', outcome: '守卫段不再整段 SKIP', social_reaction: '覆盖度恢复', emotion: '踏实' } },
  { store: 'orphan', data: { id: 'orphan-fixture-seed', summary: '夹具自足播种的孤案示例', observed: '夹具缺失示例初始化脚本', hypothesis: '内联最小示例库即可恢复本段', would_confirm: '本段断言全绿', would_refute: '本段仍被跳过', severity: '低', created: '2026-10-17' } },
  { store: 'pricing', data: { id: 'price-fixture-seed', behavior: '夹具自足播种的定价示例', valence: -1, severity_default: 3, note: '示例' } },
  { store: 'lexicon', data: { id: 'lex-fixture-seed', term: '自足夹具', trigger: '夹具缺少 core 自带示例脚本', behavior: '内联最小示例库', resolution: '不再因缺 init-example 而整段 SKIP', source: '示例' } },
];
const normPath = (p) => String(p).replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// —— ④-0 回退告警（批次11 · VERIFY-H2 §5-①）：堵"全绿但测错树"的**其它调用方** ——
// 缺陷形态：候选链第一项是 AKASHA_CORE，但它**只有 lib.mjs+mcp.mjs 都在才被选中**；不满足就继续往下找，
//   最坏落到仓布局里的真核（`join(HERE,'..','akasha')`）——全程**一声不响**（批次10 实测：残缺 core-min
//   ⇒ 守卫扫到 11163 条目＝真核，且 `all assertions passed`）。
// 真暴露面＝`akasha/tools/family-sweep.mjs` §5：它**继承 process.env** 跑本文件 ⇒ shell 里残留一个坏/
//   过期的 AKASHA_CORE，扫描器照报 ✓ 全绿，实际测的是真核。health-check §C 另有显式传值 + fail-closed 前置校验。
// 口径（三态）：合法（选中了指定值）静默；非法（发生了回退）**告警但照常跑**（默认不硬失败——继承环境的调用方
//   会因别人 shell 里的历史变量整片变红，误伤面大于收益）；CI 想 fail-closed 就带 `AKASHA_CORE_STRICT=1`。
if (process.env.AKASHA_CORE && CORE && normPath(CORE) !== normPath(process.env.AKASHA_CORE)) {
  const _msg = '⚠ 指定的 AKASHA_CORE 不可用（缺 lib.mjs/mcp.mjs）——已回退到 ' + CORE + '；静默回退会「测错树」，请核对。';
  if (process.env.AKASHA_CORE_STRICT === '1') { console.error(_msg); process.exit(1); }
  console.warn(_msg);
}
function scanSourceLinks(root, mustCheck = [], cap = 60000) {
  let rootReal = root; try { rootReal = realpathSync(root); } catch { /* 读不到就用字面路径 */ }
  const r = normPath(rootReal);
  const selfNesting = (p) => { const t = normPath(p); return t === r || t.startsWith(r + '/') || r.startsWith(t + '/'); };
  const fatal = [], warn = [], seen = new Set();
  let entries = 0, dirs = 0, capped = false;
  const t0 = Date.now();
  // probe：链接判定 —— lstat/readlink 为主，realpath 兜底（部分 node 版本对 junction 的 lstat 失明）；
  //   返回 descend=false 者一律不下钻，保证扫描自身永不进入链接（否则守卫自己就会自嵌套）。
  const probe = (p) => {
    let st; try { st = lstatSync(p); } catch { return null; }                      // 不在/不可读 ⇒ 跳过
    if (st.isSymbolicLink()) {
      let t = null; try { t = readlinkSync(p); } catch { /* 保留 null */ }
      let real = null; try { real = realpathSync(p); } catch { /* 断链 */ }
      return { link: t, real, descend: false };
    }
    if (!st.isDirectory()) return { link: null, real: null, descend: false };      // 普通文件：无复制放大面
    dirs += 1;
    let real = null; try { real = realpathSync(p); } catch { /* 读不到 */ }
    // 与「按 rootReal 推出的应有路径」比（而非与字面 p 比）：root 自己就是链接时不误报
    const expect = join(rootReal, relative(root, p));
    if (!real || normPath(real) !== normPath(expect)) return { link: real, real, descend: false };  // junction 盲区兜底
    return { link: null, real, descend: true };
  };
  const note = (p, info) => {
    if (seen.has(normPath(p))) return;
    seen.add(normPath(p));
    const abs = info.link ? (isAbsolute(info.link) ? info.link : resolve(dirname(p), info.link)) : null;
    const target = info.real || abs || '(未解析)';
    (selfNesting(target) ? fatal : warn).push({ path: p, target });
  };
  for (const rel of mustCheck) {                                                   // ① 将被复制的条目：优先必查
    const p = join(root, rel); const info = probe(p);
    if (info && info.link) note(p, info);
  }
  (function walk(dir) {                                                            // ② 全树只读扫（不跟进链接）
    if (capped) return;
    let es; try { es = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (++entries > cap) { capped = true; return; }
      const p = join(dir, e.name);
      const info = probe(p);
      if (!info) continue;
      if (info.link) note(p, info);
      if (info.descend) walk(p);
    }
  })(root);
  return { rootReal, fatal, warn, entries, dirs, capped, cap, ms: Date.now() - t0 };
}

const PATCH = join(HERE, 'cordis.patch.yml');
const patch = readFileSync(PATCH, 'utf8');
const packageName = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).name;

// —— ① Bundle Patch 契约（STORE 硬门：入口 ID 自有、不以 name 引用官方命名空间、不 disable/replace）——
assert.ok(/id:\s*mcp-akasha/.test(patch), '入口 id 为插件自有 ID：mcp-akasha');
assert.ok(!/\bname:\s*['"]?@deepseek-ai\//i.test(patch), 'Bundle Patch 不得以 name 引用 @deepseek-ai/* 官方包（SUBMISSION_PATCH_PROTECTED）');
const patchNames = [...patch.matchAll(/^\s*name:\s*(?:'([^']+)'|"([^"]+)"|([^\s#]+))\s*(?:#.*)?$/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
assert.equal(typeof packageName, 'string', 'package.json 必须声明自有包名');
assert.deepEqual(patchNames, [packageName], 'Patch 必须且仅引用本插件 package.json 的准确包名');
assert.ok(!/^\s*(remove|disable|patch):/m.test(patch), 'Bundle Patch 只使用 insert；不得出现 remove/disable/patch 行');

// —— ② 命令以数组给出，不做 shell 字符串拼接（fail closed：避免注入面）——
assert.ok(/args:\s*\[/.test(patch), 'args 必须为数组（不拼接 shell 字符串）');
assert.ok(!/command:\s*['"][^'"]*[;&|]/.test(patch), 'command 不得含 shell 元字符（; & |）');

// —— ③ 纯函数：公开名规范化（与官方同类规则：非法字符→_；改写或超长 → 截断 + 12 位哈希）——
const { apply, publicToolName, renderText, findPlaceholders, assertNoPlaceholders } = await import('./index.js');

// 兜底（2026-10-16 加；2026-10-17 修）：任何未捕获拒绝 ⇒ **先清理 SCRATCH 再退出**，杜绝"进程被掀翻、
// finally 没跑到"造成的 dsh-temp 残骸（实测历史残骸成因正是这个；9 个残留 62.5GB/163 万文件）。
// ⚠ 2026-10-17 独立复核查出原版**结构性失效**：handler 在模块顶层，而当时的 `const SCRATCH` 在下方
//   `else` 块内 ⇒ 词法作用域取不到 ⇒ `rmSync` 抛 ReferenceError 被 `catch{}` 吞掉 ⇒ **清理是空操作，
//   却照打"已尽力清理"**（比不做更糟）。修法＝`let SCRATCH = null` 提到这里（仍惰性创建，见下），
//   并在此判空后再清。
let SCRATCH = null;
process.on('unhandledRejection', (e) => {
  try { if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  console.error('未处理拒绝（已尽力清理 SCRATCH）：' + (e?.message ?? e));
  process.exit(1);
});
assert.equal(publicToolName('akasha', 'akasha_check'), 'mcp__akasha__akasha_check', '常规名不改写');
assert.match(publicToolName('akasha', 'a b/c'), /^mcp__akasha__a_b_c_[0-9a-f]{12}$/, '名被改写时加 12 位哈希后缀（与官方同类规则一致）');
{
  const long = publicToolName('akasha', 'x'.repeat(120));
  assert.ok(long.length <= 64, '超长名截断到 ≤64（实际 ' + long.length + '）');
  assert.match(long, /_[0-9a-f]{12}$/, '超长名带 12 位哈希后缀');
}
assert.equal(renderText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }]), 'a\n[image]', '非文本块降级为占位符（不丢值）');

// —— ③b 占位符守卫（2026-10-19 发布面 P0）：`args: ['<AKASHA_DIR>/mcp.mjs']` 照抄 ⇒ spawn 失败、23 工具静默消失 ——
assert.equal(findPlaceholders({ args: ['<AKASHA_DIR>/mcp.mjs'] }).length, 1, 'args 数组里的占位符必须被识别');
assert.equal(findPlaceholders({ args: ['node', '/opt/akasha/mcp.mjs'] }).length, 0, '正常路径不得误报');
assert.throws(() => assertNoPlaceholders({ args: ['<AKASHA_DIR>/mcp.mjs'] }), /未替换的占位符 <AKASHA_DIR>/, '占位符配置必须抛错');
await assert.rejects(apply({ logger: { info() {} } }, { args: ['<AKASHA_DIR>/mcp.mjs'] }), /未替换的占位符/, 'apply 阶段必须 fail closed（不得降级为 0 工具）');

// —— ④ 注册桥端到端：临时 core 副本 + 真实 MCP 服务器（stdio）→ 注册 → 真调一个工具 ——
//   前提门（2026-10-17 批次10 MIX#4 改）：**运行时所必需的核心件必须在所选 core 根存在**
//   （= mcp.mjs 的静态导入闭包，grep 实测：mcp→lib/session/sleep，lib→json-redaction）。
//   旧门是「必须存在 init-example.mjs」——把完整性代理挂在**示例脚本**上，于是任何裁剪掉该脚本的
//   core 根（复核夹具、OSS 树）都会让整段 SKIP（含 21/32 条断言），批次9 复核正是这样把守卫段
//   跳过去了（差点漏检）。现在示例库**自足**：源有 init-example 就用它；没有就用文件内联的
//   最小示例库就地播种（只用核心自有 CLI 面 `add --store/--data`，不碰 lib.mjs 内部 API）。
let skipCount = 0;
const REQUIRED_CORE = ['lib.mjs', 'json-redaction.mjs', 'mcp.mjs', 'session.mjs', 'sleep.mjs', 'akasha.mjs', 'init-example.mjs', 'companion.mjs', 'adapters.mjs'];
const missingCore = REQUIRED_CORE.filter((f) => !existsSync(join(CORE, f)));
const INIT_EXAMPLE = existsSync(join(CORE, 'init-example.mjs')) ? join(CORE, 'init-example.mjs') : null;
if (missingCore.length) {
  skipCount += 1;
  console.log('');
  console.log('  ⚠⚠ SKIP 注册桥端到端 —— core 根缺运行时必需件：' + missingCore.join(' | '));
  console.log('     CORE = ' + CORE);
  console.log('     覆盖度损失：本段含 21/32 条断言（含真起 MCP 服务器 + 真调工具），跳过即等于套件只剩 11 条断言');
  console.log('     这不是放水而是缺口：把 CORE（AKASHA_CORE / 候选链）指到完整核心，或补齐上面列出的文件。');
  console.log('');
} else {
SCRATCH = mkdtempSync(join(tmpdir(), 'mcp-akasha-selftest-'));   // 2026-10-17：由 const 改赋值（SCRATCH 已在顶层 let 声明）
try {
  const coreCopy = join(SCRATCH, 'core');
  // PATCH(batch7-B)：白名单复制——原实现 `cpSync(CORE, coreCopy, {recursive:true})` 把 Core 整锅复制
  //   （含 gate-out/ 审计产物海 138MB+/5600+ 文件、真库 data/ 130MB + 86MB 会话数据），Windows 下对
  //   「小文件海」递归复制 >260s 未完成（对照：data 大文件 330ms ⇒ 慢因＝小文件海）。
  //   本测试需要的只是「可运行的核心」：8 个 .mjs + 空六库（由 init-example 播种）+ tools/review-lag.mjs。
  // PATCH(batch9-A)：动手复制之前先过链接守卫（见文件上方 scanSourceLinks）——自嵌套链接 ⇒ 当场红。
  {
    const g = scanSourceLinks(CORE, [...COPY_WHITELIST, 'tools', 'tools/review-lag.mjs', 'data']);
    const hits = LINK_GUARD_STRICT ? g.fatal.concat(g.warn) : g.fatal;
    if (hits.length) {
      console.error('');
      console.error('  ✗ 源树链接守卫（batch9-A）：' + CORE + ' 内存在' + (LINK_GUARD_STRICT ? '' : '指向自身/包含自身的') + '链接 —— 全量复制会靠它自嵌套（原事故＝errno 112 磁盘满）。已中止，未复制任何文件：');
      for (const h of hits.slice(0, 10)) console.error('      · ' + h.path + '\n        → ' + h.target);
      if (hits.length > 10) console.error('      … 另有 ' + (hits.length - 10) + ' 条');
      console.error('      你是建了 junction 吗？拆除（只删链接、不删目标）：cmd /c rmdir "<上面的那条路径>"');
      console.error('      事故存档：canon-junction-disk-incident-20261016（errno 112 / D 盘 62.5GB 残骸）。');
      console.error('');
      throw new Error('源树链接守卫：Core 含 ' + hits.length + ' 条' + (LINK_GUARD_STRICT ? '' : '自嵌套') + '链接，拒绝复制（防 errno 112 复发）');
    }
    if (g.warn.length) console.log('  · 链接守卫：' + g.warn.length + ' 条非自嵌套链接（不跟进、不进副本，仅点名）：' + g.warn.slice(0, 2).map((h) => h.path).join(' | '));
    console.log('  · 链接守卫：源树 ' + g.entries + ' 条目 / ' + g.dirs + ' 目录 / ' + g.ms + 'ms' + (g.capped ? '（达上限 ' + g.cap + ' 未扫完）' : '') + '；自嵌套链接 0 条');
  }
  mkdirSync(coreCopy, { recursive: true });
  for (const f of COPY_WHITELIST) {
    const s = join(CORE, f);
    if (existsSync(s)) cpSync(s, join(coreCopy, f));
  }
  mkdirSync(join(coreCopy, 'data'), { recursive: true });
  for (const s of ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier']) writeFileSync(join(coreCopy, 'data', s + '.jsonl'), '');
  mkdirSync(join(coreCopy, 'tools'), { recursive: true });
  if (existsSync(join(CORE, 'tools', 'review-lag.mjs'))) cpSync(join(CORE, 'tools', 'review-lag.mjs'), join(coreCopy, 'tools', 'review-lag.mjs'));
  // 初始化示例库（数据面）：源有 init-example.mjs ⇒ 用它（原口径不变）；
  //   没有 ⇒ 内联最小示例库自足播种（MIX#4：本段不再因缺该脚本而整段 SKIP）。
  if (INIT_EXAMPLE) {
    execFileSync(process.execPath, [join(coreCopy, 'init-example.mjs')], { cwd: coreCopy, stdio: 'pipe', timeout: 60000 });
  } else if (existsSync(join(coreCopy, 'akasha.mjs'))) {
    for (const { store, data } of SEED_EXAMPLE) {
      execFileSync(process.execPath, [join(coreCopy, 'akasha.mjs'), 'add', '--store', store, '--data', JSON.stringify(data)], { cwd: coreCopy, stdio: 'pipe', timeout: 60000 });
    }
    console.log('  · 自足夹具（MIX#4）：源 core 无 init-example.mjs ⇒ 内联最小示例库播种 ' + SEED_EXAMPLE.length + ' 条（' + [...new Set(SEED_EXAMPLE.map((r) => r.store))].join('/') + '）');
  } else {
    console.log('  · 自足夹具（MIX#4）：源 core 既无 init-example.mjs 又无 akasha.mjs ⇒ 不播种（空六库仍可校验）');
  }

  const registered = new Map();
  const logs = [];
  let disposer = null;
  const ctx = {
    tools: { register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); } },
    logger: { info: (m) => logs.push(String(m)), error: (m) => logs.push('ERROR ' + String(m)) },
    effect(fn) { disposer = fn(); },
  };
  await apply(ctx, {
    serverName: 'akasha',
    transport: 'stdio',
    command: process.execPath,
    args: [join(coreCopy, 'mcp.mjs')],
    startupTimeoutMs: 30000,
    toolCallTimeoutMs: 60000,
    failOnStartupError: true,
  });
  // ↑ 2026-10-16 修（残骸真因）：原为裸 `apply(...)`＝不 await ⇒ 一旦 reject 即 unhandledRejection
  //   ⇒ 进程直接终止 ⇒ **跳过文件尾 finally 的 rmSync(SCRATCH)** ⇒ 在 dsh-temp 留下成GB残骸
  //   （实测 9 个残留 62.5GB/163 万文件，D 盘一度只剩 1.41GB）。加 await 后：失败会正常抛进 try，
  //   走 finally 清理并以非零码报错（它本就该成功）。

  for (let i = 0; i < 60 && registered.size === 0; i++) await new Promise((r) => setTimeout(r, 500));
  assert.ok(registered.size > 0, '应从真实 MCP 服务器注册到工具（实际 ' + registered.size + ' 个；日志：' + logs.slice(-2).join(' | ') + '）');
  const names = [...registered.keys()];
  assert.ok(names.every((n) => n.startsWith('mcp__akasha__')), '全部工具名前缀为 mcp__akasha__');
  const sample = registered.get('mcp__akasha__akasha_check');
  assert.ok(sample, '注册表里应含 mcp__akasha__akasha_check（实际：' + names.slice(0, 4).join(', ') + '）');
  assert.equal(typeof sample.execute, 'function', 'execute 存在');
  assert.equal(typeof sample.output?.render, 'function', 'output.render 存在');
  assert.equal(sample.parameters?.type, 'object', 'parameters 为 JSON schema');

  // 真调一次：akasha_check（示例库口径，应通过）
  const result = await sample.execute({}, { signal: undefined });
  assert.ok(Array.isArray(result.content) && result.content.length > 0, '工具返回 content 数组');
  const text = renderText(result.content);
  assert.ok(text.length > 0, '工具返回可渲染文本');
  assert.ok(/OK|canon/.test(text), 'akasha_check 在示例库上返回 OK（实际文本前缀：' + text.slice(0, 80).replace(/\n/g, ' ') + '）');
  console.log('端到端：注册 ' + registered.size + ' 个工具；akasha_check 实调返回：' + text.slice(0, 100).replace(/\n/g, ' '));

  // 取消信号：已 abort 的调用必须立即拒绝，而不是照跑到超时
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(sample.execute({}, { signal: aborted.signal }), /已取消/, 'abort 信号 → 立即拒绝');

  // 注册中途失败 → 必须**回滚已注册部分**（防"半注册 + 日志说谎"）
  {
    const partial = new Map();
    let calls = 0;
    const poisonCtx = {
      tools: { register(definition) { calls += 1; if (calls === 3) throw new Error('poison'); partial.set(definition.name, definition); return () => partial.delete(definition.name); } },
      logger: { info: () => {}, error: () => {} },
      effect: () => {},
    };
    await assert.rejects(
      apply(poisonCtx, { serverName: 'akasha', transport: 'stdio', command: process.execPath, args: [join(coreCopy, 'mcp.mjs')], startupTimeoutMs: 30000, failOnStartupError: true }),
      /已回滚全部注册/,
      '注册中途失败 → 抛回滚错误',
    );
    assert.equal(partial.size, 0, '回滚后不得残留任何注册（实际 ' + partial.size + ' 个）');
  }

  // 对外安装体验回归：用户机器上未必有 `node` 在 PATH ⇒ 必须自动回退到宿主自带 node
  {
    const reg = new Map();
    const logs = [];
    const ctx = {
      tools: { register(definition) { reg.set(definition.name, definition); return () => reg.delete(definition.name); } },
      logger: { info: (m) => logs.push(String(m)), error: (m) => logs.push('ERROR ' + String(m)) },
      effect: () => {},
    };
    await apply(ctx, {
      serverName: 'akasha', transport: 'stdio', command: 'node', args: [join(coreCopy, 'mcp.mjs')],
      startupTimeoutMs: 30000, toolCallTimeoutMs: 30000, failOnStartupError: false, env: { PATH: '' },
    });
    for (let i = 0; i < 40 && reg.size === 0; i++) await new Promise((r) => setTimeout(r, 500));
    assert.ok(logs.some((l) => /回退到宿主自带 node/.test(l)), '应记录 node 回退日志（实际日志：' + logs.slice(-2).join(' | ').slice(0, 140) + '）');
    assert.ok(reg.size > 0, '回退后仍应注册到工具（实际 ' + reg.size + ' 个）');
    console.log('node 回退：注册 ' + reg.size + ' 个工具');
  }

  // 失败闭合：malformed 配置（缺 command）必须显式拒绝，而不是静默无工具（apply 是 async → 用 rejects）
  await assert.rejects(apply({ tools: { register: () => () => {} }, logger: {} }, { command: '' }), /command/, '缺 command → fail closed（显式拒绝）');

  // 清理：调用插件注册的 disposer（会杀掉 MCP 子进程），避免事件循环不归零
  if (typeof disposer === 'function') disposer();
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

// —— ④b 回归：子进程秒退（无效路径）时**不得**因 EPIPE / 未处理拒绝打死宿主 ——
// 这是 E3 抓到的真实故障：子进程死后写 stdin 会以异步 'error' 事件抛 EPIPE，未挂处理即未捕获异常。
{
  const logs = [];
  const softCtx = { tools: { register: () => () => {} }, logger: { info: (m) => logs.push(String(m)), error: (m) => logs.push('ERROR ' + String(m)) }, effect: () => {} };
  await apply(softCtx, {
    serverName: 'akasha', transport: 'stdio', command: process.execPath,
    args: [join(SCRATCH, 'definitely-missing-server.mjs')],
    startupTimeoutMs: 5000, toolCallTimeoutMs: 5000, failOnStartupError: false,
  });
  await new Promise((r) => setTimeout(r, 2000)); // 给 spawn/EPIPE 冒头的时间
  assert.ok(logs.some((l) => l.startsWith('ERROR')), '软失败路径：必须留降级日志（fail-soft，绝不静默）');

  const hardCtx = { tools: { register: () => () => {} }, logger: { info: () => {}, error: () => {} }, effect: () => {} };
  await assert.rejects(
    apply(hardCtx, {
      serverName: 'akasha', transport: 'stdio', command: process.execPath,
      args: [join(SCRATCH, 'definitely-missing-server.mjs')],
      startupTimeoutMs: 5000, toolCallTimeoutMs: 5000, failOnStartupError: true,
    }),
    '硬失败路径：failOnStartupError=true → apply 必须 reject（而不是未处理拒绝）',
  );
}

// —— ⑤ MCP 服务端：malformed JSON-RPC 不得导致非零退出（stdio 容错）——
{
  const serverPath = join(CORE, 'mcp.mjs');
  if (existsSync(serverPath)) {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; try { child.kill(); } catch { /* 已退出 */ } resolve(v); } };
      const timer = setTimeout(() => done({ code: null }), 10000);
      child.on('error', () => { clearTimeout(timer); done({ code: 'spawn-error' }); });
      child.on('exit', (code) => { clearTimeout(timer); done({ code }); });
      const send = (s) => { try { child.stdin.write(s); } catch { /* stdin 关闭 */ } };
      // 畸形但各种形状：null / 数字 / 字符串 / 数组 / 无 method 的对象 / 非法 JSON
      // —— 每一个都必须回 JSON-RPC 错误（-32600 / -32700），而**不能**让服务器崩掉。
      send('null\n');
      send('123\n');
      send('"just a string"\n');
      send('[]\n');
      send('{}\n');
      send('{ this is not json }\n');
      send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'no/such-method', params: {} }) + '\n');
      // 存活探针在块外做（见下方 liveness 断言）
    });
    assert.ok(result.code === null || result.code === 0, 'malformed JSON-RPC 不得导致非零退出（实际 exit=' + result.code + '）');
  }
}

// —— ⑤b 加固回归：畸形输入后服务器**仍活着**（形状校验 + 存活探针）——
{
  const serverPath = join(CORE, 'mcp.mjs');
  if (existsSync(serverPath)) {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let buffer = ''; const responses = [];
      child.stdout.on('data', (d) => {
        buffer += String(d);
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1); if (line) { try { responses.push(JSON.parse(line)); } catch { /* 忽略 */ } } }
      });
      child.stderr.on('data', () => {});
      const send = (s) => { try { child.stdin.write(s + '\n'); } catch { /* stdin 关闭 */ } };
      send('null'); send('123'); send('"str"'); send('[]'); send('{}'); send('{ bad }');
      setTimeout(() => {
        send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }));
        setTimeout(() => {
          const alive = child.exitCode === null;
          const list = responses.find((r) => r.id === 99);
          const errors = responses.filter((r) => r.error).length;
          try { child.kill(); } catch { /* 已退出 */ }
          resolve({ alive, tools: list?.result?.tools?.length ?? 0, errors });
        }, 900);
      }, 700);
    });
    assert.ok(result.errors >= 6, '六种畸形形状都须回 JSON-RPC 错误（实际 ' + result.errors + '）');
    assert.ok(result.alive, '畸形输入后服务器必须仍然存活');
    assert.ok(result.tools > 0, '存活探针：tools/list 仍可用（实际 ' + result.tools + ' 个工具）');
    console.log('加固回归：畸形输入 ' + result.errors + ' 个错误响应；服务器存活；tools/list=' + result.tools);
  }
}
}   // ← 前提门（init-example.mjs 存在性）的 else 结束

console.log('selftest: ' + (skipCount ? '**部分通过**（' + skipCount + ' 段被 SKIP，覆盖度受损，见上方告警）' : 'all assertions passed'));
// MCP 子进程（即使已 kill）可能让事件循环不归零 → 全部用例跑完显式退出（与 akasha-session 自测同口径）。
process.exit(0);
