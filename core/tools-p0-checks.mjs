// p0 检查执行器：并行 + 输入哈希缓存（2026-10-17，用户「门控太慢」）
//
// 设计取舍（为什么不是"无脑跳过"）：
//   · **缓存键＝真实输入的内容哈希**（核心库/工具/data/被探测的已装版本/node 版本），不是 mtime；
//   · 命中缓存时报告里**明写 `PASS(cached)`**，并在收尾行报出命中数；`--no-cache` 强制全跑；
//   · TTL（默认 6h）——超龄一律重跑，避免"环境变了但输入哈希没变"长期蒙混。
// 这条路径与今天审计出的"假绿"家族的区别：**它显式声明自己是缓存**，且键是内容而非时间。

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** 收集"这些检查到底依赖什么"的内容哈希（便宜、可复算）
 *  @param {{includeData?: boolean}} opt  `includeData:false` 时**不读 data/**——`test.mjs` 全套 mkdtemp 沙箱、
 *         不读真库（实测 117/126/295… 行都是 mkdtempSync）⇒ 写库不该让它重跑 118s。
 *         反之 `check` 读真库、`health-check` 会 cpSync 六库进沙箱 ⇒ 它们必须用含数据的键。 */
export function inputsKey(akashaDir, profilePkgPath, opt = {}) {
  const includeData = opt.includeData !== false;
  const h = createHash('sha256');
  h.update('node:' + process.version + '\n');
  // 核心库与工具（*.mjs / *.js，深度 2，跳过 data/logs/gate-out）
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) {
        if (/^(data|logs|gate-out|node_modules|_scratch|snap)$/.test(e.name)) continue;
        walk(join(dir, e.name), depth + 1);
      } else if (/\.(mjs|js|cjs)$/.test(e.name)) {
        try { h.update(join(dir, e.name) + ':' + sha(readFileSync(join(dir, e.name))) + '\n'); } catch { /* skip */ }
      }
    }
  };
  walk(akashaDir, 0);
  // 2026-10-17 复核 P2-d：`akasha/tests/*.json(l)` 是 test.mjs ⑤ 硬编码读的夹具（断言 ≥8 题），
  // 上面那趟 walk 只收代码扩展名 ⇒ 必须单独补。
  try {
    const testsDir = join(akashaDir, 'tests');
    for (const f of readdirSync(testsDir).sort()) {
      if (!/\.json(l)?$/.test(f)) continue;
      try { h.update('tests/' + f + ':' + sha(readFileSync(join(testsDir, f))) + '\n'); } catch { /* skip */ }
    }
  } catch { /* skip */ }
  // 数据面：data/*.jsonl（2026-10-17 复核 P2-b：negative 等也要进键）
  // 但**排除每回合被会话插件写入的输出件**（session.jsonl / session-meta.json）——
  // 它们若进键，键会每回合翻，缓存等于没有（实测 session.jsonl 19:21:58 刚被写）。
  const VOLATILE = new Set(['session.jsonl', 'session-meta.json', 'hooks.jsonl', 'idempotency.jsonl']);
  if (includeData) try {
    const dataDir = join(akashaDir, 'data');
    for (const f of readdirSync(dataDir).sort()) {
      if (!/\.json(l)?$/.test(f) || VOLATILE.has(f)) continue;
      try { h.update('data/' + f + ':' + sha(readFileSync(join(dataDir, f))) + '\n'); } catch { /* skip */ }
    }
  } catch { /* skip */ }
  // 同级 dsh-* 包的**代码**（2026-10-17 复核 P1-a：`test.mjs` 直接 import 了 `dsh-akasha-gate/index.js`，
  // 只给版本串是不够的——隔离克隆实测：改 fenceUsage ⇒ 旧键不变、结果 276-0 → 275-1 ⇒ 旧绿盖真红）。
  // 成本实测 ≈ +13ms（120 文件 / 1.7MB）。
  try {
    const root = join(akashaDir, '..');
    for (const d of readdirSync(root).sort()) {
      if (!/^dsh-/.test(d)) continue;
      const base = join(root, d);
      const walkPkg = (dir, depth) => {
        if (depth > 2) return;
        let ents = [];
        try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (e.isDirectory()) {
            // 2026-10-18（GPT③ ⑧ / 深层依赖缓存）：`dist` 不再跳过——发布件/装载件若从 dist 读，
            //   漏它＝改深层依赖后缓存仍 PASS（旧口令"dist 是构建产物"只在"没人从 dist 装载"时成立）。
            if (/^(node_modules|\.git|lib\/types)$/.test(e.name)) continue;
            walkPkg(join(dir, e.name), depth + 1);
          } else if (/\.(mjs|cjs|js|json|yml|yaml)$/.test(e.name)) {
            // 2026-10-17 复核 P2-d：`yml` 必须收——`dsh-mcp-akasha/cordis.patch.yml` 被 selftest 断言内容、
            // 被 health-check spawn，漏了它等于漏了一个真输入。
            try { h.update(d + '/' + e.name + ':' + sha(readFileSync(join(dir, e.name))) + '\n'); } catch { /* skip */ }
          }
        }
      };
      walkPkg(base, 0);
    }
  } catch { /* skip */ }
  // 环境白名单（2026-10-17 复核 P2-a）：只纳入会改变 p0 结果的少数变量
  for (const k of ['AKASHA_ROOT', 'AKASHA_DIR', 'AKASHA_LOGS', 'NODE_ENV']) {
    if (process.env[k] !== undefined) h.update('env:' + k + '=' + process.env[k] + '\n');
  }
  // 已装 @akasha-book/* 的版本声明 + **主文件内容**（复核：只有版本串时，安装副本被改而版本不变 ⇒ 旧绿盖住）
  try {
    const j = JSON.parse(readFileSync(profilePkgPath, 'utf8'));
    for (const k of Object.keys(j.dependencies || {}).sort()) {
      if (/^@local\//.test(k)) h.update(k + '=' + j.dependencies[k] + '\n');
    }
    // 2026-10-17 P2-e（复核提的"只哈希三个主文件"）：改成**整包目录**哈希（深度≤3，跳过 node_modules）。
    //   原口径会漏掉 mcp-rea/artez/cyberstrike 的 server.mjs 这类非主入口文件。
    const nm = join(profilePkgPath, '..', 'node_modules');
    const walkPkgDir = (k) => {
      const rootDir = join(nm, k);
      const seen = [];
      const walk = (dir, depth) => {
        if (depth > 3) return;
        let ents = [];
        try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(join(dir, e.name), depth + 1); }
          else if (/\.(mjs|cjs|js|json|yml|yaml)$/.test(e.name)) seen.push(join(dir, e.name));
        }
      };
      walk(rootDir, 0);
      for (const abs of seen) {
        try { h.update('installed/' + k + '/' + relative(nm, abs).replace(/\\/g, '/') + ':' + sha(readFileSync(abs)) + '\n'); } catch { /* skip */ }
      }
    };
    for (const k of Object.keys(j.dependencies || {}).sort()) {
      if (!/^@local\//.test(k)) continue;
      walkPkgDir(k);
    }
  } catch { /* skip */ }
  return h.digest('hex').slice(0, 32);
}

/** 单个检查：spawn 异步，收集 stdout/stderr，返回 {ok,out,ms} */
export function runOne(cmdline, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let child;
    try {
      child = spawn(cmdline[0], cmdline.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, out: String(e?.message ?? e), ms: 0 });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* skip */ } }, timeoutMs);
    const push = (b) => { out += b.toString(); if (out.length > (1 << 26)) out = out.slice(-(1 << 24)); };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: out + String(e?.message ?? e), ms: Date.now() - t0 }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, ms: Date.now() - t0, code, signal });
    });
  });
}

/**
 * 执行全部检查。
 * @param {{specs: Array<{name:string,cmdline:string[],timeoutMs:number}>, cwd:string,
 *          cacheFile:string, allowCache:boolean, ttlMs:number}} opt
 */
export async function runChecks(opt) {
  const { specs, cwd, cacheFile, allowCache, ttlMs } = opt;
  // 永远不缓存的项（2026-10-17 复核 P1-b）：它们便宜（0.1–0.3s）且语义要求"每次都真跑"——
  // review-lag 是账本（缓存它等于自己蒙自己），family-sweep 是漂移探测器，selftest 是冻结面守卫。
  const NEVER_CACHE = new Set(['全家扫描 family-sweep', '审核面滞后 review-lag', '判据自测 selftest']);
  let cache = {};
  if (allowCache) { try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* 无缓存 */ } }
  const PROF = join(process.env.DSH_HOME || join(cwd, '..', 'official-home'), 'profiles', 'desktop', 'package.json');
  // 2026-10-17：**取消"按检查分叉"**。它在两轮复核里被打穿两次（①键不含 sibling `dsh-*` 代码 ⇒ 改 fenceUsage 得 275-1 而键不变；
  //   ②`test.mjs` 其实读真库 ⇒ 删/截断 canon 会让它红而代码键不变）。分叉带来的收益（写库只重跑 check+health）抵不上假绿风险。
  //   现只用**一把键**（含数据）。代价：写一次库后 test 要重跑（约 110s）；提速的正路是让 test 的那几组改读沙箱快照，另开一道。
  const keyBase = inputsKey(cwd, PROF, { includeData: true });
  // 已知检查名（复核建议）：名字对不上就 console.warn —— 这样"改名 ⇒ 静默降级"至少可见。
  const KNOWN_SPECS = new Set(['主套件 test.mjs', '库校验 check', '体检 health-check', '全家扫描 family-sweep', '判据自测 selftest', '审核面滞后 review-lag']);
  for (const s of specs) if (!KNOWN_SPECS.has(s.name)) console.warn('⚠ p0-checks：未知检查名 "' + s.name + '"（NEVER_CACHE/缓存口径可能对它无效——改名后请同步这里）');

  const results = [];
  const tasks = [];
  for (const s of specs) {
    const k = keyBase;
    const hit = allowCache && !NEVER_CACHE.has(s.name) && cache[s.name] && cache[s.name].key === k && (Date.now() - Date.parse(cache[s.name].at || 0)) < ttlMs;
    if (hit) {
      results.push({ name: s.name, ok: true, out: `[cached] 输入哈希未变（key ${k.slice(0, 8)}），上次通过于 ${cache[s.name].at}` + (cache[s.name].tail ? ` / 上次关键行：${cache[s.name].tail}` : ''), ms: 0, cached: true });
      continue;
    }
    tasks.push(runOne(s.cmdline, cwd, s.timeoutMs).then((r) => { results.push({ name: s.name, ...r, cached: false }); }));
  }
  await Promise.all(tasks);

  // 按 specs 顺序回排，并写缓存（只缓存 PASS，且记 tail）
  const ordered = specs.map((s) => results.find((r) => r.name === s.name)).filter(Boolean);
  const next = {};
  for (const r of ordered) {
    if (r.cached) { try { next[r.name] = cache[r.name]; } catch { /* skip */ } continue; }
    if (r.ok) {
      if (NEVER_CACHE.has(r.name)) continue;
      const tail = r.out.trim().split(/\r?\n/).slice(-4).join(' / ').slice(0, 400);
      next[r.name] = { key: keyBase, at: new Date().toISOString(), tail };
    }
  }
  try { mkdirSync(join(cacheFile, '..'), { recursive: true }); writeFileSync(cacheFile, JSON.stringify(next, null, 2), 'utf8'); } catch { /* skip */ }
  return ordered;
}
