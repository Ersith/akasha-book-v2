#!/usr/bin/env node
// akasha doctor —— 记忆完整性巡检 v0（2026-10-18）
//
// 形状参照 `openviking-server doctor`（三态 PASS/WARN/FAIL/SKIP + 每项 Fix + 单项异常不拖垮整轮）；
// 重建判据参照 Hindsight 的 reprocess + 基线对照（不每次全库重建）。
//
// 只读红线：本工具**不写六库**。唯一写操作是 `--baseline`（写 gate-out/session-baseline.json，原子写）。
//
// 判据（2026-10-18 定；同日独立审核 P1/P2/P3 返工后）：
//   · 原始层：会话档案逐份可读（readSessionArchive 结构判定：frameFails / frameTruncated）；
//     活跃档案（mtime < 120s）半写尾帧只记 WARN，不当坏档。
//   · 派生层：六库 + 会话索引逐行可解析。
//   · 单调性：每会话 lastSeq / conclusions 不回退（**不用 segments**——含 node 段，随树重建波动）。
//   · 重建性（**分层判据**）：
//       - 重建 maxSeq < 基线 lastSeq ⇒ **FAIL**（档案尾部真的没到水位 = 真丢尾）
//       - 重建 maxSeq ≥ 基线、但 conclusions 少 ⇒ **WARN**（append-only 台账累积 / 档案压缩 / 抽取器漂移，
//         不是丢数据；实测 7fe8ec84：档案完好而单次重建结论少 12，旧判据会假 FAIL）
//       - 重建未写出台账 ⇒ WARN（不比较，疑似 no-op；段内 seq 与台账 maxSeq 口径不同，不得互相 fallback）
import {
  readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync, statfsSync,
} from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DATA, ROOT, parseJsonl, writeFileAtomic } from './lib.mjs';
import { resolvePorts, healthOf } from './companion.mjs';
import { SESSION_DEFAULTS, readSessionArchive, normalizeSid } from './session.mjs';

const AKASHA_DIR = dirname(DATA);
const GATE_OUT = join(AKASHA_DIR, 'gate-out');
const BASELINE_FILE = join(GATE_OUT, 'session-baseline.json');
const LIB_NAMES = ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'];
const LIVE_MS = 120000;
/** 内容层指纹：排序后的结论 id 集合（id 含内容指纹）→ sha1-16。 */
const sha16 = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
/** 路径同一性（审核 R2a）：resolve + win32 小写；正/反斜杠、大小写、尾斜杠都不该算「另一个库根」。 */
const samePath = (a, b) => {
  if (!a || !b) return false;
  try {
    const ra = resolve(String(a)); const rb = resolve(String(b));
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch { return String(a) === String(b); }
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v !== undefined && v !== '' && !String(v).startsWith('--') ? v : d;
};
const intOpt = (f, d) => {
  const raw = opt(f, undefined);
  // 审核 R6：旗标出现但没给值 ⇒ 明确报错，别静默回落（--archives 静默变全量最坑）
  if (raw === undefined) {
    if (argv.includes(f)) { console.error(`用法错误：${f} 需要一个值（非负整数）`); process.exit(2); }
    return d;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`用法错误：${f} 需要非负整数（收到 ${JSON.stringify(raw)}）`);
    process.exit(2);
  }
  return n;
};
const JSON_OUT = has('--json');
const WRITE_BASELINE = has('--baseline');
const FORCE_BASELINE = has('--force-baseline');
const SKIP_ARCHIVES = has('--no-archives');
const ARCHIVES_LIMIT = intOpt('--archives', 0);
const REBUILD_N = intOpt('--rebuild', 0);

const rows = [];
const run = (label, fn) => {
  let r;
  try { r = fn(); } catch (e) {
    r = { status: 'fail', detail: '检查抛错：' + String(e?.message ?? e).slice(0, 160), fix: '先修检查本身（单项异常不应拖垮整轮）' };
  }
  rows.push({ label, status: String(r.status), detail: String(r.detail ?? ''), fix: r.fix ? String(r.fix) : '' });
};
const listZstd = (root, maxDepth = 5) => {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.zstd')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
};
const sessionsRoot = process.env.AKASHA_SESSIONS_ROOT || SESSION_DEFAULTS.sessionsRoot;
// 2026-10-19（独立审核 P1-10）：会话层三件（session.jsonl / session-meta.json / 会话档案根）全缺时，
//   台账 / 覆盖差异 / 基线对比 属于「本部署没有这一层」⇒ SKIP，不再报 WARN；
//   同时汇总行不得再把 WARN 写成「全过」，`--strict` 提供「警告即非零」档位。
const SESSION_LAYER = existsSync(SESSION_DEFAULTS.storeFile) && existsSync(SESSION_DEFAULTS.metaFile) && existsSync(sessionsRoot);
const STRICT = has('--strict');
const readMeta = () => {
  try { return JSON.parse(readFileSync(SESSION_DEFAULTS.metaFile, 'utf8')).sessions ?? {}; } catch { return null; }
};
// 台账键历史上两种形态（裸 uuid / session- 前缀），**且可能双键并存且值不同**（旧账是子集）⇒
// 归一后合并取 max，避免旧账覆盖新账造成假回退（2026-10-18 实测 d6c6c428：裸 14079 / 前缀 3888）。
const readMetaNorm = () => {
  const m = readMeta();
  if (!m) return null;
  const out = new Map();
  for (const [k, v] of Object.entries(m)) {
    const sid = normalizeSid(k);
    const cur = out.get(sid);
    if (!cur) { out.set(sid, v); continue; }
    out.set(sid, {
      ...cur,
      lastSeq: Math.max(cur.lastSeq ?? 0, v.lastSeq ?? 0),
      conclusions: Math.max(cur.conclusions ?? 0, v.conclusions ?? 0),
      segments: Math.max(cur.segments ?? 0, v.segments ?? 0),
      // 双键孪生时 source 必须跟「lastSeq 更大」的那条走（审核中-2）：
      // 若取先出现的键而 lastSeq 取 max，会拼出「旧 source + 新 lastSeq」⇒ R7 重建旧档 ⇒ 假 FAIL「真丢尾」。
      source: (v.lastSeq ?? 0) > (cur.lastSeq ?? 0) ? (v.source ?? cur.source) : (cur.source ?? v.source),
    });
  }
  return out;
};
/** 台账原始键里的「双形态孪生」会话（同一归一 id 出现多个原始键）。 */
const twinKeySids = () => {
  const m = readMeta();
  if (!m) return [];
  const seen = new Map();
  for (const k of Object.keys(m)) {
    const n = normalizeSid(k);
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([sid]) => sid);
};

// ── 1. 数据根 ──
run('数据根', () => {
  if (!existsSync(DATA)) return { status: 'fail', detail: DATA + ' 不存在', fix: '检查 AKASHA_ROOT；缺根时拒绝静默建空库' };
  try { readdirSync(DATA); } catch (e) { return { status: 'fail', detail: '不可读：' + String(e.message).slice(0, 80), fix: '权限 / 挂载' }; }
  return { status: 'pass', detail: DATA };
});

// ── 1.5 配套端口（只读契约）──
run('配套端口', () => {
  try {
    const ports = resolvePorts();
    const h = healthOf(ports);
    const degraded = h.filter((x) => x.mode === 'degraded' || x.ok === false || x.ok === null);
    if (degraded.length) return { status: 'warn', detail: degraded.map((x) => x.kind + '=' + x.driver).join('；') + '（未注入 adapter hooks；MCP/CLI 各自接入）', fix: '端口配置只在注入了 hooks 的进程内生效；见 COMPANION.md §3.1' };
    return { status: 'pass', detail: h.map((x) => x.kind + '=' + x.mode).join('；') };
  } catch (e) { return { status: 'warn', detail: '读取失败：' + e.message }; }
});

// ── 2. 六库 ──
run('六库', () => {
  const bad = []; const parts = [];
  for (const n of LIB_NAMES) {
    const f = join(DATA, n + '.jsonl');
    if (!existsSync(f)) { bad.push(n + ' 缺失'); continue; }
    let text; try { text = readFileSync(f, 'utf8'); } catch { bad.push(n + ' 不可读'); continue; }
    const { records, errors } = parseJsonl(text);
    parts.push(n + '=' + records.length);
    if (errors.length) bad.push(`${n} 坏行${errors.length}（首行 ${errors[0]?.line ?? '?'}）`);
  }
  if (bad.length) return { status: 'fail', detail: parts.concat(bad).join(' · '), fix: '先备份再修坏行（或按修订链重放）' };
  return { status: 'pass', detail: parts.join(' ') };
});

// ── 2.5 损坏隔离件（2026-10-19 P1-5）──
run('损坏隔离件', () => {
  const dirs = [...new Set([DATA, dirname(SESSION_DEFAULTS.storeFile)])].filter((d) => { try { return existsSync(d); } catch { return false; } });
  const found = [];
  for (const d of dirs) {
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const f of names) if (f.includes('.corrupt-')) found.push(join(d, f));
  }
  if (!found.length) return { status: 'pass', detail: '无 .corrupt-*（写前尾部检查未发现坏尾）' };
  return { status: 'warn', detail: `发现 ${found.length} 个隔离件（最近：${basename(found[found.length - 1])}）`, fix: '确认坏尾已在 .corrupt-* 中留档后人工清理；不要直接删主文件' };
});

// ── 3. 会话索引 ──
run('会话索引', () => {
  const f = SESSION_DEFAULTS.storeFile;
  if (!existsSync(f)) {
    // 2026-10-18：OSS/纯六库部署**故意不带会话层数据**（会话档案是本地隐私）——
    //   三件（session.jsonl / session-meta.json / 会话档案根）都缺 ⇒ SKIP；缺其一 ⇒ 仍是真问题。
    const metaMissing = readMetaNorm() === null;
    // 2026-10-19（H 复审）：**没有 session.jsonl 且没有台账＝本部署没启用会话层 ⇒ SKIP**，
    //   不再要求「档案根也不存在」——用户机器的 ~/.dsh/sessions 可能恰好存在，会把纯六库部署误判 FAIL。
    if (metaMissing) return { status: 'skip', detail: '本部署未启用会话层（无 session.jsonl / 台账）', fix: '需要时：node akasha.mjs session index <档案> --full' };
    return { status: 'fail', detail: 'session.jsonl 缺失：' + f, fix: 'node akasha.mjs session index <档案> --full' };
  }
  const { records, errors } = parseJsonl(readFileSync(f, 'utf8'));
  const sids = new Set(); const kinds = new Map();
  for (const r of records) {
    if (r.session) sids.add(normalizeSid(r.session));
    kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
  }
  const k = [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([x, n]) => x + '=' + n).join(' ');
  if (errors.length) return { status: 'fail', detail: `${records.length} 行，坏行 ${errors.length}（首行 ${errors[0]?.line ?? '?'}）`, fix: '定位坏行修复/重新索引该会话' };
  return { status: records.length ? 'pass' : 'warn', detail: `${records.length} 行 / ${sids.size} 会话 / ${k}` };
});

// ── 4. 索引台账 ──
run('索引台账', () => {
  if (!SESSION_LAYER) return { status: 'skip', detail: '本部署未启用会话层（三件均缺）', fix: '需要时：node akasha.mjs session index <档案> --full' };
  const m = readMeta();
  if (m === null) return { status: 'warn', detail: 'session-meta.json 缺失或不可解析', fix: '重建任一会话索引即生成' };
  const n = Object.keys(m).length;
  if (!n) return { status: 'warn', detail: '台账为空（sessions 0 条）', fix: '索引任一会话即可重建台账' };
  return { status: 'pass', detail: `${n} 会话` };
});

// ── 5. 覆盖差异 ──
run('覆盖差异', () => {
  if (!SESSION_LAYER) return { status: 'skip', detail: '本部署未启用会话层（三件均缺）' };
  const meta = readMetaNorm();
  if (!meta) return { status: 'warn', detail: '无台账，跳过', fix: '先修索引台账' };
  let sids = new Set();
  try {
    for (const rec of parseJsonl(readFileSync(SESSION_DEFAULTS.storeFile, 'utf8')).records) {
      if (rec.session) sids.add(normalizeSid(rec.session));
    }
  } catch { return { status: 'warn', detail: '索引不可读，跳过', fix: '先修会话索引' }; }
  const metaOnly = [...meta.keys()].filter((s) => !sids.has(s));
  const idxOnly = [...sids].filter((s) => !meta.has(s));
  const twins = twinKeySids();
  if (!metaOnly.length && !idxOnly.length && !twins.length) return { status: 'pass', detail: '台账与索引一一对应（' + sids.size + ' 会话）' };
  const parts = [];
  if (metaOnly.length) parts.push('台账有/索引无 ' + metaOnly.length + '（例 ' + metaOnly.slice(0, 2).map((s) => s.slice(0, 8)).join(',') + '）');
  if (idxOnly.length) parts.push('索引有/台账无 ' + idxOnly.length + '（例 ' + idxOnly.slice(0, 2).map((s) => s.slice(0, 8)).join(',') + '）');
  if (twins.length) parts.push('台账双形态孪生 ' + twins.length + ' 对（例 ' + twins.slice(0, 2).map((s) => s.slice(0, 8)).join(',') + '）');
  const zero = metaOnly.filter((s) => !(meta.get(s)?.segments));
  if (metaOnly.length && zero.length === metaOnly.length) parts.push('（台账有/索引无者均为 0 段会话）');
  return { status: 'warn', detail: parts.join('；'), fix: '台账有/索引无 ⇒ 该会话段被清过或重索引未完成；索引有/台账无 ⇒ 台账回退；双形态孪生 ⇒ 旧账是子集可忽略，或 --full 重建成单键' };
});

// ── 6. 原始档案（核心；活档竞态降级）──
run('原始档案', () => {
  if (SKIP_ARCHIVES) return { status: 'skip', detail: '已跳过（--no-archives）', fix: '定期跑一次全量' };
  // 2026-10-18：OSS/纯六库部署没有 official-home/sessions —— 与「会话索引」同口径降为 SKIP
  if (!existsSync(sessionsRoot)) {
    const noSessionLayer = !existsSync(SESSION_DEFAULTS.storeFile) && readMetaNorm() === null;
    if (noSessionLayer) return { status: 'skip', detail: '本部署未启用会话层（无档案根）', fix: '需要时设 AKASHA_SESSIONS_ROOT / DSH_HOME' };
    return { status: 'fail', detail: '会话根不存在：' + sessionsRoot, fix: '检查 DSH_HOME / AKASHA_SESSIONS_ROOT / 目录布局' };
  }
  const all = listZstd(sessionsRoot);
  if (!all.length) return { status: 'fail', detail: '未发现 .zstd：' + sessionsRoot, fix: '检查存档目录布局' };
  // 抽样优先最近的档案（审核 P10：readdir 顺序会让抽样恒取同一批）
  let files = all;
  if (ARCHIVES_LIMIT > 0) {
    files = [...all].sort((a, b) => { try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; } });
  }
  const scan = ARCHIVES_LIMIT > 0 ? files.slice(0, ARCHIVES_LIMIT) : files;
  const hard = []; const liveSoft = []; const flaky = []; let truncated = 0; let bytes = 0;
  const now = Date.now();
  const t0 = Date.now();
  for (const f of scan) {
    let st; try { st = statSync(f); } catch { hard.push(basename(dirname(f)) + '（stat 失败）'); continue; }
    bytes += st.size;
    if (st.size === 0) { hard.push(basename(dirname(f)) + '（0 字节）'); continue; }
    let r = null; let err = null;
    try { r = readSessionArchive(f); } catch (e) { err = e; }
    // 活档竞态：读后大小变了 ⇒ 重读一次（审核 §③ 竞态）
    if (!err) {
      let st2; try { st2 = statSync(f); } catch { st2 = null; }
      if (st2 && st2.size !== st.size) { try { r = readSessionArchive(f); } catch (e) { err = e; } st = st2; }
    }
    if (err) { hard.push(`${basename(dirname(f))}（${String(err.message).slice(0, 60)}）`); continue; }
    const isLive = now - st.mtimeMs < LIVE_MS;
    if (r.frameFails > 0) {
      // 偶发解压失败 vs 真坏档（2026-10-18 实测：7fe8ec84 单读 10 次全正常，仅全量扫时偶发 frameFails=1）——
      // 重读一次再定性：重读正常 ⇒ WARN「偶发」，不当坏档。
      let r2 = null; let err2 = null;
      try { r2 = readSessionArchive(f); } catch (e) { err2 = e; }
      if (!err2 && r2 && r2.frameFails === 0) {
        truncated += r2.frameTruncated ? 1 : 0;
        if (isLive) liveSoft.push(basename(dirname(f)));
        else flaky.push(basename(dirname(f)));
      } else if (isLive) {
        liveSoft.push(basename(dirname(f)));
      } else {
        hard.push(`${basename(dirname(f))}（frameFails=${r.frameFails}${r2 ? `，重读=${r2.frameFails}` : '，重读抛错'}）`);
      }
      continue;
    }
    if (r.frameTruncated) truncated += 1;
  }
  const ms = Date.now() - t0;
  const scope = scan.length < all.length ? `**部分扫描** ${scan.length}/${all.length}` : `全量 ${scan.length}/${all.length}`;
  const head = `${scope} 份 · ${(bytes / 1048576).toFixed(0)}MB · ${ms}ms · 根 ${sessionsRoot} · 坏档 ${hard.length} · 活档半写 ${liveSoft.length} · 偶发 ${flaky.length} · 截断 ${truncated}`;
  if (hard.length) return { status: 'fail', detail: head + ' ▸ ' + hard.slice(0, 3).join('；'), fix: '坏档只搬不删到隔离目录，再从其他副本恢复' };
  if (scan.length < all.length) return { status: 'warn', detail: head, fix: '本轮只扫了抽样；发版前跑一次全量（不加 --archives）' };
  if (flaky.length) return { status: 'warn', detail: head + ' ▸ ' + flaky.slice(0, 3).join('；'), fix: '偶发解压失败（重读正常）：非坏档；同一档反复出现再按损坏处理' };
  if (liveSoft.length) return { status: 'warn', detail: head, fix: '活档（mtime<120s）半写尾帧：等该会话这轮结束再复扫确认' };
  if (truncated > 0) return { status: 'warn', detail: head, fix: '截断帧通常无害（末帧容错）；若持续增长需查写入中断' };
  return { status: 'pass', detail: head };
});

// ── 7. 基线对比（单调性 + 库根校验）──
run('基线对比', () => {
  if (!SESSION_LAYER) return { status: 'skip', detail: '本部署未启用会话层（三件均缺）' };
  const meta = readMetaNorm();
  if (meta === null) return { status: 'warn', detail: '无台账，跳过', fix: '先修索引台账' };
  if (!existsSync(BASELINE_FILE)) return { status: 'skip', detail: '无基线（首次）', fix: 'node akasha/tools/doctor.mjs --baseline' };
  let b; try { b = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')); } catch { return { status: 'fail', detail: '基线不可解析', fix: '重生成：--baseline' }; }
  if (b.root && !samePath(b.root, DATA)) {
    return { status: 'fail', detail: `基线属于另一个库根 ${b.root}（当前 ${DATA}）`, fix: '确认库根后 `--baseline --force-baseline` 重写；勿跨库比对' };
  }
  const base = b.sessions ?? {};
  const regress = []; const softRegress = [];
  for (const [sid, v] of Object.entries(base)) {
    const cur = meta.get(normalizeSid(sid));
    if (!cur) { regress.push(sid.slice(0, 8) + ' 台账中消失'); continue; }
    const seqDown = (cur.lastSeq ?? 0) < (v.lastSeq ?? 0);
    const conclDown = (cur.conclusions ?? 0) < (v.conclusions ?? 0);
    if (seqDown) regress.push(`${sid.slice(0, 8)} lastSeq ${v.lastSeq}→${cur.lastSeq}`);
    // 只降结论、不降 seq ⇒ 弱信号（2026-10-18 实测 7fe8ec84：台账陈旧的 2968 在重索引后被重算成 2967，
    // 因为 append-only 库删过重复段、而 conclusions 只在索引时重算）——按 WARN 处理，不判丢段。
    else if (conclDown) softRegress.push(`${sid.slice(0, 8)} 结论 ${v.conclusions}→${cur.conclusions}（seq 未退：多为重整索引重算/删重复段）`);
  }
  const head = `${Object.keys(base).length} 会话基线（${String(b.generatedAt ?? '').slice(0, 19)}）`;
  if (regress.length) return { status: 'fail', detail: head + ' ▸ 回退 ' + regress.slice(0, 4).join('；'), fix: '回退＝重索引丢段：先备份 session.jsonl 再逐会话 --full 重建对比' };
  if (softRegress.length) return { status: 'warn', detail: head + ' ▸ ' + softRegress.slice(0, 4).join('；'), fix: 'seq 未退而结论降：先查该会话 indexedAt 是否变过（重索引会重算计数）；确认无丢段后可 --baseline 重写基线' };
  return { status: 'pass', detail: head + '，无回退' };
});

// ── 8. 抽样重建（分层判据：真丢尾 FAIL / 结论漂移 WARN）──
run('抽样重建', () => {
  if (!REBUILD_N) return { status: 'skip', detail: '未启用（--rebuild N）', fix: '隔几天抽查 1-2 个会话即可' };
  const meta = readMetaNorm();
  if (!meta) return { status: 'warn', detail: '无台账，跳过', fix: '先修索引台账' };
  let base = {};
  try {
    const rawB = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    // 审核 R3：抽样重建读基线也要校验库根，异库基线不得当参照
    if (!rawB.root || samePath(rawB.root, DATA)) {
      base = Object.fromEntries(Object.entries(rawB.sessions ?? {}).map(([k, v]) => [normalizeSid(k), v]));
    }
  } catch { /* 无基线用当前台账 */ }
  const all = listZstd(sessionsRoot);
  // R7：同一 sid 可能有多个副本（session.jsonl / session.v3 / v4）——台账的 source 才是当初索引的那份。
  // 不按 readdir 顺序 last-wins（会随机选到旧副本 ⇒ 重建假 FAIL/假 PASS）。
  const sourceBySid = new Map();
  for (const [sid, v] of meta.entries()) {
    if (typeof v?.source === 'string' && v.source.endsWith('.zstd')) sourceBySid.set(sid, v.source);
  }
  const SID_RE = /[\\/]session-([0-9a-fA-F][0-9a-fA-F-]{7,})(?=[\\/]|$)/;
  const bySid = new Map();
  for (const f of all) {
    const m = SID_RE.exec(f);
    if (!m) continue;
    const sid = normalizeSid(m[1]);
    const cur = bySid.get(sid);
    if (!cur) { bySid.set(sid, f); continue; }
    // 用 samePath 归一（审核 P3）：正/反斜杠、大小写、尾斜杠差异不能让 source 失效
    if (samePath(sourceBySid.get(sid), f)) { bySid.set(sid, f); continue; }
    if (samePath(sourceBySid.get(sid), cur)) continue;
    try { if (statSync(f).mtimeMs > statSync(cur).mtimeMs) bySid.set(sid, f); } catch { /* 取不到时间就保留先到的 */ }
  }
  for (const [sid, src] of sourceBySid) {
    if (bySid.has(sid) || !existsSync(src)) continue;
    // 审核中-1：CLI 用同一正则从路径解析 sid；解析不出的路径（如 official-collab-<uuid>\session.v4.jsonl.zstd）
    // 喂给 `session index` 只会 exit 1，被记成假 FAIL —— 不补入，该会话本轮不抽。
    const m = SID_RE.exec(src);
    if (!m || normalizeSid(m[1]) !== sid) continue;
    bySid.set(sid, src);
  }
  // 抽样按 mtime 倒序（审核 P10）；R8c：活档（mtime<120s）跳过——重建会读到半写尾帧，必然偏低
  const liveSkipped = [];
  const targets = [...bySid.keys()].filter((sid) => {
    if (!meta.has(sid)) return false;
    try { if (Date.now() - statSync(bySid.get(sid)).mtimeMs < LIVE_MS) { liveSkipped.push(sid); return false; } } catch { return false; }
    return true;
  })
    .sort((a, b) => { try { return statSync(bySid.get(b)).mtimeMs - statSync(bySid.get(a)).mtimeMs; } catch { return 0; } })
    .slice(0, REBUILD_N);
  // 活档跳过必须可见（审核 P2）：否则有效抽样被静默缩小，看起来「全 PASS」其实少抽了
  const liveNote = liveSkipped.length ? `；跳过活档 ${liveSkipped.length} 个` : '';
  // R7 兜底提示（审核 P2）：没有 source 的**入账会话**按 mtime 选档，若剩旧副本可能假 FAIL——让它可见
  // 只统计台账内的会话：档案目录里没入账的 sid 本来就不会被重建，报它们纯属噪音
  const sourceMissing = [...bySid.keys()].filter((sid) => meta.has(sid) && !sourceBySid.has(sid));
  const srcNote = sourceMissing.length ? `；${sourceMissing.length} 个会话台账无 source（按 mtime 兜底）` : '';
  if (!targets.length) return { status: 'warn', detail: '无可重建目标' + liveNote + srcNote, fix: '检查档案与会话 id 映射（活档等该会话这轮结束后再抽）' };
  const fails = []; const soft = []; const lines = [];
  for (const sid of targets) {
    const tmp = mkdtempSync(join(tmpdir(), 'akasha-doctor-'));
    const store = join(tmp, 'session.jsonl');
    const metaF = join(tmp, 'session-meta.json');
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'akasha.mjs'), 'session', 'index', bySid.get(sid), '--full', '--store', store, '--meta', metaF], {
        cwd: ROOT, encoding: 'utf8', timeout: 300000,
        // 不覆盖 AKASHA_ROOT：CLI 启动会校验数据根必须含库文件，空沙箱会被拒。
        // 只把 --store / --meta 指向 tmp —— 读侧仍读真库（只读），写侧只落 tmp。
      });
      if (r.status !== 0) {
        const code = String(r.error?.code ?? '');
        const transient = !!r.signal || /ETIMEDOUT|ENOBUFS|EAGAIN|EBUSY|EMFILE|ENFILE/.test(code);
        const why = r.error ? `spawn ${code || r.error.message}` : r.signal ? `signal ${r.signal}` : `退出 ${r.status}`;
        fails.push(`${sid.slice(0, 8)} 重建失败（${why}；${transient ? '瞬时，可重试' : '确定性，勿重试'}）：${String(r.stderr ?? '').slice(0, 100)}`);
        continue;
      }
      let segs = 0; const rebuiltConclIds = [];
      if (existsSync(store)) {
        for (const rec of parseJsonl(readFileSync(store, 'utf8')).records) {
          if (normalizeSid(rec.session) !== sid || rec.kind === 'node') continue;
          segs += 1;
          if (rec.kind === 'conclusion') rebuiltConclIds.push(String(rec.id ?? ''));
        }
      }
      // 判据只用重建**台账**（indexSession 写的 lastSeq = 档案 maxSeq），不与段内 seq 互相 fallback（审核 P2）。
      let rebuiltLastSeq = null; let rebuiltConcl = null;
      if (existsSync(metaF)) {
        try {
          const mm = JSON.parse(readFileSync(metaF, 'utf8')).sessions?.[sid];
          if (mm) { rebuiltLastSeq = mm.lastSeq ?? null; rebuiltConcl = mm.conclusions ?? null; }
        } catch { /* 台账坏了 → 下面走 skip */ }
      }
      if (rebuiltLastSeq === null) { soft.push(`${sid.slice(0, 8)}：重建未写出台账（疑似 no-op 或档案空），本轮不比较`); continue; }
      // 基准 = max(基线, 当前台账)：审核 R1——只用基线时，基线一旦陈旧，真实丢尾会失明
      // （实测 4536d5eb 基线 1316 / 台账 ≥1405 / 重建 1408，90+ seq 的尾损会判 PASS）。
      const refBase = base[sid] ?? {};
      const refCur = meta.get(sid) ?? {};
      const refLastSeq = Math.max(refBase.lastSeq ?? 0, refCur.lastSeq ?? 0);
      const refConcl = Math.max(refBase.conclusions ?? 0, refCur.conclusions ?? 0);
      const seqShort = rebuiltLastSeq < refLastSeq;
      const conclMissing = rebuiltConcl === null;
      const conclShort = !conclMissing && rebuiltConcl < refConcl;
      // 静默 no-op 防线（Hindsight #3899 的教训：completed + 0 产出 ≠ 重建成功）
      const noop = segs === 0 && refLastSeq > 0;
      // 内容层判据（更严）：结论数相同但 id 集合哈希不同 ⇒ 同数不同容（抽取器版本变化 / 中段替换）。
      // 口径必须与基线对齐（审核 P1）：hash 覆盖的是基线那一刻的条数 `conclN`。
      // 若拿 max(基线,当前台账) 当参照，基线之后正常增长的会话会被伪报「同数不同容」
      // （实测 4536d5eb：基线 81 → 台账/重建 89，hash 必然不同；旧基线无 conclN ⇒ 不比较，不误报）。
      const rebuiltHash = rebuiltConclIds.length ? sha16(rebuiltConclIds.slice().sort().join('\n')) : null;
      const refConclN = refBase.conclN ?? null;
      const hashDrift = !conclMissing && !!refBase.conclHash && !!rebuiltHash
        && refConclN !== null && rebuiltConclIds.length === refConclN && rebuiltHash !== refBase.conclHash;
      if (seqShort) fails.push(`${sid.slice(0, 8)}：档案尾部未达基准（重建 maxSeq ${rebuiltLastSeq} < ${refLastSeq}）＝真丢尾`);
      else if (noop) soft.push(`${sid.slice(0, 8)}：重建产出 0 段（疑似静默 no-op / 档案为空），maxSeq=${rebuiltLastSeq}`);
      else if (conclShort) soft.push(`${sid.slice(0, 8)}：结论 ${rebuiltConcl} < 基准 ${refConcl}（尾部完好：多为台账累积/档案压缩/抽取器漂移）`);
      else if (hashDrift) soft.push(`${sid.slice(0, 8)}：结论数相同（${rebuiltConclIds.length}）但内容哈希不同——同数不同容（抽取器变化或中段替换）`);
      else lines.push(`${sid.slice(0, 8)} 非node段=${segs} lastSeq=${rebuiltLastSeq}≥${refLastSeq} ${conclMissing ? '结论未知' : '结论=' + rebuiltConcl}`);
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不重要 */ }
    }
  }
  if (fails.length) return { status: 'fail', detail: fails.join('；') + liveNote + srcNote, fix: '真丢尾 ⇒ 先备份真库，再查该档案的 seq 连续性并逐会话 --full 重建' };
  if (soft.length) return { status: 'warn', detail: soft.join('；') + liveNote + srcNote, fix: '结论漂移 ≠ 丢数据：核对该档案可读性与抽取器版本；如需对齐可 --full 重索引该会话' };
  return { status: 'pass', detail: lines.join(' · ') + liveNote + srcNote };
});

// ── 9. 磁盘 ──
run('磁盘', () => {
  if (typeof statfsSync !== 'function') return { status: 'skip', detail: '当前 Node 无 statfsSync', fix: '升级 Node 或忽略' };
  const s = statfsSync(DATA);
  const freeGb = (s.bsize * s.bavail) / 1024 ** 3;
  if (freeGb < 1) return { status: 'fail', detail: freeGb.toFixed(1) + ' GB 可用', fix: '清磁盘（至少留 1 GB）' };
  return { status: freeGb < 5 ? 'warn' : 'pass', detail: freeGb.toFixed(1) + ' GB 可用' };
});

// ── 10. 环境变量两面 ──
run('环境变量', () => {
  // 环境变量在 Windows 上大小写不敏感（审核 R8：只按大小写精确取会假 WARN）
  const envKey = (name) => Object.keys(process.env).find((k) => k.toUpperCase() === name) ?? null;
  const envVal = (name) => { const k = envKey(name); return k ? process.env[k] : undefined; };
  const shown = ['AKASHA_ROOT', 'AKASHA_DIR', 'AKASHA_LOGS'].map((k) => k + '=' + (envVal(k) ?? '(未设)'));
  const dir = envVal('AKASHA_DIR');
  if (dir && join(dir, 'data') !== DATA && !DATA.startsWith(dir)) {
    return { status: 'warn', detail: shown.join(' '), fix: '插件侧 AKASHA_DIR 与核心侧 AKASHA_ROOT 不同源（跨进程对照会「库同源、日志不同源」）' };
  }
  return { status: 'pass', detail: shown.join(' ') };
});

// ── 写基线（唯一写操作；库已红时不洗白，除非 --force-baseline）──
let baselineNote = '';
const failRows = rows.filter((r) => r.status === 'fail');
if (WRITE_BASELINE) {
  if (failRows.length && !FORCE_BASELINE) {
    baselineNote = `基线未写：本轮有 ${failRows.length} 项 FAIL（先修，或加 --force-baseline）`;
  } else {
    const meta = readMetaNorm();
    if (!meta) baselineNote = '基线未写：台账不可用';
    else {
      const sessions = {};
      // 内容层基线：每会话结论 id 集合哈希（结论数不变而内容被替换时靠它抓）
      const conclIdsBySid = new Map();
      try {
        for (const rec of parseJsonl(readFileSync(SESSION_DEFAULTS.storeFile, 'utf8')).records) {
          if (rec.kind !== 'conclusion') continue;
          const s0 = normalizeSid(rec.session);
          const arr = conclIdsBySid.get(s0) ?? [];
          arr.push(String(rec.id ?? ''));
          conclIdsBySid.set(s0, arr);
        }
      } catch { /* 索引不可读 → conclHash 留空，退回纯数量判据 */ }
      for (const [sid, v] of meta.entries()) {
        const ids = (conclIdsBySid.get(sid) ?? []).slice().sort();
        sessions[sid] = {
          lastSeq: v.lastSeq ?? 0,
          conclusions: v.conclusions ?? 0,
          // hash 覆盖的条数（与 conclusions 可能差 1：台账记的入库条数 vs store 实际行数）
          conclN: ids.length || null,
          conclHash: ids.length ? sha16(ids.join('\n')) : null,
        };
      }
      const stamp = new Date().toISOString();
      const summary = { at: stamp, fails: rows.filter((r) => r.status === 'fail').length, warns: rows.filter((r) => r.status === 'warn').length, rows: rows.map((r) => ({ label: r.label, status: r.status })) };
      writeFileAtomic(BASELINE_FILE, JSON.stringify({ generatedAt: stamp, root: DATA, summary, sessions }, null, 2));
      baselineNote = `基线已写：${BASELINE_FILE}（${Object.keys(sessions).length} 会话；写入时 ${failRows.length} FAIL / ${summary.warns} WARN）`;
    }
  }
}

// ── 输出 ──
const localStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const fails = rows.filter((r) => r.status === 'fail').length;
const warns = rows.filter((r) => r.status === 'warn').length;
const skips = rows.filter((r) => r.status === 'skip').length;
if (JSON_OUT) {
  console.log(JSON.stringify({ at: localStamp(), root: DATA, rows, fails, warns, skips, baseline: baselineNote || null }, null, 2));
} else {
  const width = Math.max(...rows.map((r) => r.label.length));
  console.log(`\nakasha doctor · ${localStamp()}\n`);
  for (const r of rows) {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : r.status === 'skip' ? 'SKIP' : 'FAIL';
    console.log(`  ${r.label.padEnd(width)}  ${tag}  ${r.detail}`);
    if (r.fix && (r.status === 'fail' || r.status === 'warn')) console.log(`  ${' '.repeat(width)}        Fix: ${r.fix}`);
  }
  console.log('');
  if (baselineNote) console.log('  ' + baselineNote + '\n');
  const tail = skips ? `（另 ${skips} 项 SKIP）` : '';
  if (fails) console.log(`  ${fails} 项 FAIL · ${warns} 项 WARN${tail}\n`);
  // 2026-10-19：WARN 不等于「全过」——汇总行必须如实；--strict 时警告即非零
  else if (warns) console.log(`  ⚠ 通过但有 ${warns} 项 WARN（逐项 Fix 见上方）${tail}\n`);
  else console.log(`  All checks passed.${skips ? `（另 ${skips} 项 SKIP 未执行）` : ''}\n`);
  if (STRICT && warns) console.log('  （--strict：WARN 视为非零退出）\n');
}
process.exit(fails || (STRICT && warns) ? 1 : 0);
