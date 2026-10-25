// 阿卡夏之书（Akasha）v0 核心库。零依赖（仅 Node stdlib）。
// 数据：data/*.jsonl（append-only）。规范见 SCHEMA.md / PROTOCOL.md。
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, existsSync, statSync, lstatSync, openSync, closeSync, writeSync, readSync, fsyncSync, renameSync, unlinkSync, ftruncateSync, constants } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createRedactor } from './json-redaction.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
// 数据根（#36 相关）：`AKASHA_ROOT` 可覆盖（迁移/多库/坏根演练用）；默认 <repo>/data。
export const DATA = process.env.AKASHA_ROOT ? String(process.env.AKASHA_ROOT) : join(ROOT, 'data');
// 日志根（2026-10-13 补）：原先把 logs 写死成 <repo>/logs，于是 `AKASHA_ROOT` 只能改数据、改不了日志——
// 跨进程对照（MCP 子进程 vs 本进程）就会「库同源、日志不同源」，出现难查的假红（P2 修复时实测）。
// `AKASHA_LOGS` 可覆盖；默认 <repo>/logs（与既有行为一致）。
export const LOGS_DIR = process.env.AKASHA_LOGS ? String(process.env.AKASHA_LOGS) : join(ROOT, 'logs');
/** 本地日期（YYYY-MM-DD）：库的「今天/created/last_reviewed/trash」一律本地时区，避免 UTC 与时钟行错 8h。 */
export function todayLocal(date = new Date()) { const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 10); }
// I-08（2026-10-14）：孤儿＝**热缓冲**的溢出阈值——超过此数即由 audit 报 `orphan-backlog`（只报不裁；压缩流程见 PROTOCOL「孤儿热缓冲」）。
export const ORPHAN_BACKLOG_DEFAULTS = 60;
export const STORES = ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'];
const SOURCE_TYPES = ['复现', '实验', '官方', '他人', '共识'];
export const PROPOSAL_STATUSES = Object.freeze(['proposed', 'accepted']);
const ACCEPT_PROPOSAL_TOKEN = Symbol('accept-proposal');
const SEVERITIES = ['高', '中', '低'];
/** 镜像库条目角色（wave1）：solution＝做成过的解法（做任务时主查）；boundary＝失败 / 越界 / 适用边界（改流程、复盘时查）。 */
export const MIRROR_ROLES = Object.freeze(['solution', 'boundary']);
/** mirrorMatch 的 mode：task＝解法 + 未分层；improve＝边界 + 未分层；all（缺省）＝不过滤（旧行为）。 */
export const MIRROR_MODES = Object.freeze(['all', 'task', 'improve']);
/** 五元组字段顺序：情境模式 → 行为 → 结果 → 社会反应 → 情绪词（结构匹配，不按字面故事）。 */
export const MIRROR_TUPLE_FIELDS = Object.freeze(['situation', 'behavior', 'outcome', 'social_reaction', 'emotion']);
/** 证据口径：story＝典故/教材（给名字）；own-log＝本人日志（给证据）。抗教材偏见：可按 evidence 过滤。 */
export const MIRROR_EVIDENCE = Object.freeze(['story', 'own-log']);

export function storePath(name) {
  return join(DATA, name + '.jsonl');
}

/** 凭据形字符串打码（2026-10 复查）。不打路径：实体钩子靠路径，整段打码会拆掉召回。 */
const REDACT_RES = [
  // 2026-10-18（VERIFY-D D3）：`sk-` 放行字母表补 `_ -`（`sk-proj-…` / `sk-svcacct-…` 等当代 OpenAI key 形态此前整类漏遮）。
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]'],
  // 2026-10-18（VERIFY-D D3 + VERIFY-F F6）：私钥块整块遮蔽（含 PGP/OPENSSH/ENCRYPTED 变体）。
  //   **要求正文（base64 行）**：只"提到 PEM 头"的文档不再被整段吞掉（F6 误伤 4/14）；
  //   截断无 END 的兜底也要求 base64 正文且到串尾，避免把后文说明吞成 [redacted-private-key]。
  // 2026-10-18 (VERIFY-K K7): linear rewrite — the nested quantifier above caused catastrophic
  // backtracking on a truncated multi-line PEM (no END): 2 lines ≈ 5.8s, 8 lines > 12s (killed).
  // Body-required semantics are preserved by the replacement callbacks (8+ chars full / 16+ truncated).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8}?([A-Za-z0-9+/=\s]*?)-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    (m, body) => (/[A-Za-z0-9+/=]{8,}/.test(body) ? '[redacted-private-key]' : m)],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8}?([A-Za-z0-9+/=\s]*?)…?$/g,
    (m, body) => (/[A-Za-z0-9+/=]{16,}/.test(body) ? '[redacted-private-key]' : m)],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-akid]'],
  [/\bghp_[A-Za-z0-9]{10,}\b/g, 'ghp_[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}\b/g, '[redacted-gh]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted-slack]'],
  [/\b(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[redacted]'],
  // **全角 / 两宽绕过**（2026-10-11 补，#22 的另一半）：把分隔符写成全角（`＝` `：`）或键名写成全角（`ｔｏｋｅｎ`）
  //   即可绕过只认 ASCII 的正则。修法＝**同一条规则内并列半角与全角形态** —— 全角词几乎不出现在正常正文里
  //   ⇒ **不引入误伤**（合口径①）✓ 取舍：只列常见键名的全角形式，**不做"全角归一化"**（那会改动原文本）✓
  // ⚠️ **值侧否定前瞻**（2026-10-11 手检补，真误伤实证）：值侧原本是 `\S+`（任意非空）⇒ 实测把探测输出里的
  //   `GITHUB_TOKEN : False` 改成了 `GITHUB_TOKEN : [redacted]` ✗ —— **把「该 token 不存在」篡改成了「存在但被藏」**，
  //   语义被毁 ✓ 修法＝排除**占位值**（False/True/None/null/n/a/(empty)/(none) 与短横占位）✓ 合口径①。
  //   ⚠️ **值侧必须是窄字符集**（2026-10-11 手检实证的**根因**）：原本写 `\S+` ⇒ 它**假设"空白=边界"**，
  //     而 JSON / 代码文本里**没有空白** ⇒ 实测在一条 session.jsonl 记录里**吞掉了半行**（含 JSON 结构符）
  //     ⇒ **把派生索引改成坏行** ✗✗。修法＝只吃凭据字符（遇 ' " , } 即停）✓
  //   ＋**纯短数字**（1–4 位）同样排除（2026-10-11 手检补）：实测 `token= 200` / `token=403` 是**状态码**，
  //     遮掉会把"试错结果"篡改成"有令牌"✗ ⇒ 语义被毁。
  [/((?:api[_-]?key|token|secret|password|passwd|pwd|ａｐｉ[＿_]?ｋｅｙ|ｔｏｋｅｎ|ｓｅｃｒｅｔ|ｐａｓｓｗｏｒｄ|ｐｗｄ)\s*[=:＝：]\s*)(?!False\b|True\b|None\b|null\b|n\/a\b|\(empty\)|\(none\)|\d{1,4}\b|-{1,3}\s*$)([A-Za-z0-9_\-./+:=]{6,})/gi, '$1[redacted]'],
  // 自家补充（2026-10-08）：npm / HuggingFace / GitLab 凭证前缀
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, 'npm_[redacted]'],
  [/\bhf_[A-Za-z0-9]{20,}\b/g, 'hf_[redacted]'],
  [/\bglpat-[A-Za-z0-9_\-]{16,}\b/g, '[redacted-glpat]'],
  // 自家补充（2026-10-11，吸收 #22；两条口径为 Claude/灵枢评审原话，保留）：
  //   口径①「**宁可漏报也不误伤**」—— 只 redact **可识别**的凭据形态；识别不了就放过，不许"猜它像不像密码"。
  //   口径②「**识别面宽为拦得住、受理面窄为说得准**」—— 模式可以多列，但**实际改写要窄**：只遮蔽凭据段本身，
  //          scheme / host / path **一律保留**（报告与证据常需指明"是哪个站"，全遮蔽＝毁掉可用性）。
  //   ⚠️ 顺序敏感：`user:pass@` 必须在 `user@` **之前**匹配 —— 否则后者先吃掉 user 段、留下 `:pass@` 露在外面。
  [/\b([a-z][a-z0-9+.\-]*:\/\/)([^\/\s:@]{1,64}):([^\/\s@]{1,256})@/gi, '$1[redacted]:[redacted]@'],
  // ⚠️ **`user@` 形态必须收窄**（2026-10-11 手检补，真误伤实证）：原写法把 `ssh://git@github.com` 的 `git@`
  //   也遮了 ✗ —— 而 `git@github.com` / `oauth2@host` 是**公开无害**的标准写法，在真实历史里大量存在。
  //   收窄判据：user 段**像令牌**才遮（已知前缀，或 ≥12 字符）⇒ 合口径①（宁可漏报也不误伤）✓
  [/\b([a-z][a-z0-9+.\-]*:\/\/)((?:ghp_|github_pat_|xox[baprs]-|npm_|hf_|glpat-|sk-)[A-Za-z0-9_\-]{4,}|[^\/\s:@]{12,})@/gi, '$1[redacted]@'],
  // Authorization 头的**非 Bearer** 形态（Bearer 已在上面第 6 条）
  [/\b(Authorization\s*:\s*)(Basic|token|Token|ApiKey)\s+[A-Za-z0-9._\-+/=]{6,}/g, '$1$2 [redacted]'],
  // F02（2026-10-14 外部审查 · GPT）：**带引号 / JSON 形态**此前漏遮——`password="xxx"`、`{"api_key":"xxx"}`
  //   会原样落库。两条规则：① JSON 键值对（敏感键名 + 双引号值）；② 赋值形态的引号值（单/双引号）。
  //   **R10（GPT 复核二轮）**：占位豁免从「前缀就放过」改为**整个值等于占位词才放过**（`FalseSYNTHETIC_…` 不再漏遮）。
  //   **R11（GPT 复核二轮）**：键名从「任意子串」收窄为「**敏感词结尾**」形态——`tokenizer` / `token_count_source` /
  //   `password_policy` / `secretary` 等合法字段保真；`access_token` / `client_secret` / `api_key` 等照遮。
  //   **N01/N02（GPT 第三轮）**：名单补回 `authorization`（对象型有、文本型漏了——回归）；值模式支持**转义序列**
  //   （`\"` 不再被当字符串终止符 ⇒ 密码内转义引号不再泄漏后半段）。
  [/((?:[A-Za-z0-9]*[_-])?(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|credential|authorization)"\s*:\s*")((?:\\.|[^"\\]){6,})(")/gi,
    (m, p1, v, p3) => (/^(?:False|True|None|null|n\/a)$/i.test(v) ? m : p1 + '[redacted]' + p3)],
  [/((?:[A-Za-z0-9]*[_-])?(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|credential|authorization)\s*[=:]\s*)(["'])((?:\\.|[^"'\\]){6,})\2/gi,
    (m, p1, q, v) => (/^(?:False|True|None|null|n\/a)$/i.test(v) ? m : p1 + q + '[redacted]' + q)],
  // **明确不做**（2026-10-11 裁定）：通用「长随机串」规则（如 [A-Za-z0-9_-]{32,}）—— 它与**我们自己的 id 形态**
  //   冲突（`node-7fe8ec84-L2-2781-4441-eb9ff212` / `canon-…-20261011` 都会命中）⇒ **必然误伤** ⇒ 违反口径①。
  //   此条即「独立令牌形态」的具体取舍：宁可漏报，不做泛化长串遮蔽 ✓
];
function redactText(value) {
  let out = String(value ?? '');
  for (const [re, to] of REDACT_RES) out = out.replace(re, to);
  return out;
}

/** 递归脱敏（对象 / 数组 / 字符串）——只有字符串才过规则，结构原样保留。
 *  F02（2026-10-14 外部审查 · GPT）：**按键判定**——值本身不带凭据前缀时文本规则抓不到，
 *  而键名（api_key / password / token…）已经点名「这是凭据字段」⇒ 直接遮蔽；占位值与短数字仍是例外。
 *  R11（GPT 复核二轮）：键名判定收窄为**完整键或敏感词结尾**（不再任意子串）——`tokenizer` /
 *  `token_count_source` / `password_policy` / `secretary` 等正常知识保真。 */
const SENSITIVE_KEY_RE = /^(?:api[_-]?key|apikey|password|passwd|pwd|secret|token|authorization|credential)$/i;
const SENSITIVE_KEY_TAIL_RE = /(^|[_-])(?:token|secret|password|passwd|pwd|apikey|api[_-]?key|credential)$/i;
const isSensitiveKey = (k) => SENSITIVE_KEY_RE.test(String(k)) || SENSITIVE_KEY_TAIL_RE.test(String(k));
// V01 + Q04: JSON strings use a bounded lossless scanner. Only string/key tokens
// are decoded; numbers and unchanged spans keep their original source spelling.
// Sensitive context is inherited through arrays/objects. Ordinary text keeps the
// existing regex policy, including mixed prose / fenced JSON fragments. Malformed
// credential fragments become a visible conservative mask; resource limits reject.
export const { redact, redactDeep } = createRedactor({
  redactText, isSensitiveKey,
  shouldMask: (v) => v.length >= 6 && !/^(true|false|null|none|yes|no)$/i.test(v) && !/^\d{1,4}$/.test(v),
});

/** 原子替换（先写临时文件再 rename）。 */
export function writeFileAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, text); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** 锁持有者信息（写进 .lock；用于「按持有者判活」而不是「按 mtime 判死」）。 */
function readLockInfo(lock) {
  try { return JSON.parse(readFileSync(lock, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
function lockAgeMs(lock) {
  try { return Date.now() - statSync(lock).mtimeMs; } catch { return 0; }
}

/** 锁告警（2026-10-19 人工复检）：只进 logs/lock-warn.jsonl + stderr，绝不写六库。 */
function recordLockWarn(file, msg) {
  const rec = { at: new Date().toISOString(), pid: process.pid, host: hostname(), file, msg };
  try { console.error('[akasha:lock] ' + msg + ' :: ' + file); } catch { /* 无 stderr */ }
  try { mkdirSync(LOGS_DIR, { recursive: true }); appendFileSync(join(LOGS_DIR, 'lock-warn.jsonl'), JSON.stringify(rec) + String.fromCharCode(10)); } catch { /* 日志失败不遮主流程 */ }
}

/** 尾部完整性修复（2026-10-19 P0）：JSONL 最后一行若被截断，下一次追加会粘成坏行。
 *  - 尾部是合法 JSON（只是缺换行）⇒ 补 '\n'，不搬移任何记录；
 *  - 尾部不是合法 JSON ⇒ 原字节搬进 `<file>.corrupt-<ts>`，文件截断到最后一个换行后。
 *  返回 { repaired } / { quarantined, bytes } / null（无需处理）。
 */
export function quarantineTail(file) {
  if (!existsSync(file)) return null;
  let size = 0;
  try { size = statSync(file).size; } catch { return null; }
  if (!size) return null;
  const fd = openSync(file, 'r+');
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 10) return null;
    const CHUNK = 64 * 1024;
    let pos = size;
    let lastNL = -1;
    while (pos > 0 && lastNL < 0) {
      const take = Math.min(CHUNK, pos);
      const buf = Buffer.alloc(take);
      readSync(fd, buf, 0, take, pos - take);
      const i = buf.lastIndexOf(10);
      if (i >= 0) lastNL = pos - take + i;
      pos -= take;
    }
    const tailStart = lastNL + 1;
    const tailLen = size - tailStart;
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, tailStart);
    const unchanged = () => { try { return statSync(file).size === size; } catch { return false; } };
    const text = tail.toString('utf8');
    if (text.trim() === '') { if (!unchanged()) return { skipped: true, reason: '文件在检查期间增长' }; ftruncateSync(fd, tailStart); return { repaired: true, bytes: tailLen }; }
    let parsed = null;
    try { parsed = JSON.parse(text.trim()); } catch { /* 真坏行 */ }
    if (parsed && typeof parsed === 'object') {
      if (!unchanged()) return { skipped: true, reason: '文件在检查期间增长' };
      appendFileSync(file, '\n');
      return { repaired: true, bytes: tailLen };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const q = `${file}.corrupt-${stamp}`;
    const qfd = openSync(q, 'a');
    try {
      writeSync(qfd, JSON.stringify({ quarantined_at: new Date().toISOString(), source: file, bytes: tailLen, tail: text, tail_b64: tail.toString('base64') }) + String.fromCharCode(10));
      fsyncSync(qfd);
    } finally { closeSync(qfd); }
    if (!unchanged()) return { quarantined: q, bytes: tailLen, skipped: true, reason: '文件在检查期间增长' };
    ftruncateSync(fd, tailStart);
    return { quarantined: q, bytes: tailLen };
  } finally { closeSync(fd); }
}

/** 排他锁（2026-10-19 P0）：持有者身份 + 存活判定；不再「30s 按 mtime 抢锁」。
 *  - 同机：持有者 pid 已死 ⇒ 立即接管；活着的持有者 ⇒ 等到 timeout 报明确错误（不抢）。
 *  - 异机/旧格式：无法判活 ⇒ 超过 60s / 30s 视为陈锁（网络盘回退）。
 *  - 不提供活锁心跳/抢占：临界区必须短；活持有者只等待，不按 at/mtime 抢（长临界区 fail-closed 报错）。
 *  - 不支持多主机共享同一库文件：host 不同时按 60s 兜底，O_EXCL 在网络盘上的原子性未保证。
 *  - 释放：只删内容仍是自己的 token 的锁文件（避免删掉被接管后的新锁）。
 */
export function withFileLock(file, fn, opts = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = file + '.lock';
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 5000;
  const token = randomUUID();
  const host = hostname();
  const start = Date.now();
  for (;;) {
    let fd;
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      writeSync(fd, JSON.stringify({ pid: process.pid, host, token, at: Date.now() }));
      fsyncSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      const info = readLockInfo(lock);
      const age = lockAgeMs(lock);
      const stale = info
        ? (info.host === host ? !pidAlive(info.pid) : age > 60000)
        : age > 30000;
      if (stale) {
        // 2026-10-19 审查 P0-1：判 stale 与「拿走锁」必须串行——否则 A 建新锁后、B 的 rename 会拿走 A 的活锁。
        //   闸：<lock>.steal（O_EXCL）；拿到闸后重读锁确认仍 stale 才 rename/unlink，finally 释放闸。
        const gate = lock + '.steal';
        let gfd;
        try { gfd = openSync(gate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); }
        catch (e) {
          if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
          try { if (lockAgeMs(gate) > 5000) unlinkSync(gate); } catch { /* 刚释放 */ }
        }
        if (gfd !== undefined) {
          try {
            const info2 = readLockInfo(lock);
            const age2 = lockAgeMs(lock);
            const stale2 = info2
              ? (info2.host === host ? !pidAlive(info2.pid) : age2 > 60000)
              : age2 > 30000;
            if (stale2) {
              const claim = lock + '.stale-' + process.pid + '-' + token.slice(0, 8);
              try { renameSync(lock, claim); unlinkSync(claim); } catch { /* 已被别的接管者处理 */ }
            }
          } finally {
            try { closeSync(gfd); } catch { /* 已关 */ }
            try { unlinkSync(gate); } catch { /* 已删 */ }
          }
          continue;
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`锁超时：${lock}（持有者 pid=${info && info.pid ? info.pid : '未知'} host=${info && info.host ? info.host : '?'}，已等 ${Date.now() - start}ms；不抢活锁）`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关 */ } }
    }
  }
  const lockT0 = Date.now();
  try { return fn(); }
  finally {
    const lockMs = Date.now() - lockT0;
    const warnAfter = Number.isFinite(opts.warnAfterMs) ? opts.warnAfterMs : 5000;
    if (lockMs > warnAfter) recordLockWarn(file, `长临界区 ${lockMs}ms（超 ${warnAfter}ms）`);
    const gate = lock + '.steal';
    let gfd;
    const releaseDeadline = Date.now() + 1000;
    while (gfd === undefined && Date.now() < releaseDeadline) {
      try { gfd = openSync(gate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); }
      catch (e) {
        if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        try { if (lockAgeMs(gate) > 5000) unlinkSync(gate); } catch { /* 刚释放 */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    if (gfd === undefined) recordLockWarn(file, '释放失败：.steal 闸被占用 >1s，锁保留（fail-closed）');
    if (gfd !== undefined) {
      try {
        const info = readLockInfo(lock);
        if (info && info.token === token) unlinkSync(lock);
      } finally {
        try { closeSync(gfd); } catch { /* 已关 */ }
        try { unlinkSync(gate); } catch { /* 已删 */ }
      }
    }
  }
}

export function parseJsonl(text) {
  const records = []; const errors = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const s = line.trim();
    if (!s) return;
    try { records.push(JSON.parse(s)); }
    catch (e) { errors.push({ line: i + 1, error: 'JSON 解析失败：' + e.message }); }
  });
  return { records, errors };
}

/**
 * Sync chunked JSONL parser for files beyond the V8 string limit.
 * Never materializes the whole file as one string; keeps line numbers for errors.
 */
export function parseJsonlStream(file, { chunkSize = 64 * 1024, maxLineBytes = 16 * 1024 * 1024 } = {}) {
  const fd = openSync(file, 'r');
  const records = []; const errors = [];
  let carry = Buffer.alloc(0); let lineNo = 0; let skipLine = false;
  const consume = (line, number) => {
    const s = line.toString('utf8').replace(/\r$/, '').trim();
    if (!s) return;
    try { records.push(JSON.parse(s)); }
    catch (e) { errors.push({ line: number, error: 'JSON 解析失败：' + e.message }); }
  };
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const n = readSync(fd, buf, 0, chunkSize, null);
      if (n <= 0) break;
      let chunk = Buffer.concat([carry, buf.subarray(0, n)]);
      let start = 0;
      if (skipLine) {
        const nl = chunk.indexOf(10);
        if (nl < 0) { carry = Buffer.alloc(0); continue; }
        start = nl + 1;
        skipLine = false;
      }
      for (let i = start; i < chunk.length; i += 1) {
        if (chunk[i] !== 10) continue;
        lineNo += 1;
        const line = chunk.subarray(start, i);
        if (line.length > maxLineBytes) errors.push({ line: lineNo, error: `行超过上限 ${maxLineBytes} 字节，已跳过` });
        else consume(line, lineNo);
        start = i + 1;
      }
      carry = chunk.subarray(start);
      if (carry.length > maxLineBytes) {
        lineNo += 1;
        errors.push({ line: lineNo, error: `行超过上限 ${maxLineBytes} 字节，已跳过` });
        carry = Buffer.alloc(0);
        skipLine = true;
      }
    }
    if (carry.length && !skipLine) { lineNo += 1; consume(carry, lineNo); }
  } finally { closeSync(fd); }
  return { records, errors };
}

// ── 库签名缓存（P3，2026-10-20）────────────────────────────────────────────
// 缓存「文件内容解析结果」，键 = 文件 mtimeMs + size（即**库签名**；真正判别是 size，mtime 本机仅 1–4ms 粒度）。
// 口径（重要，决定它能不能长久存在）：
//   · **纯派生、可丢弃**：只活在进程内，不落盘。删掉缓存 / 重启 ⇒ 行为完全不变，只变慢。
//     所以它是**可选优化**，不引入任何新状态，不破坏 append-only 与可审计定位。
//   · 收益主要在**长驻进程**（MCP 面每次调用都复用）；CLI 每进程新起，首次仍是冷读。
//   · 签名变化自动失效。常规 append 必然改 size；但 quarantine 截断可抵消长度 ⇒ append 后主动失效。原「无需主动失效」注释已按 2026-10-20 复核修正。
//     去掉签名比较 ⇒ 34 条用例转红）。只有「原地重写且长度不变」的写入才会漏 —— 当前无此路径。
//   · `AKASHA_NOCACHE=1` 关闭 —— 诊断与前后对照用。
//   · 返回对象与 records 数组被多处共享；已核：全库无任何 `.records.push/sort/splice` 原地修改，
//     故不拷贝（拷贝会把 23.6ms 的收益又吃掉一半）。
const STORE_CACHE = process.env.AKASHA_NOCACHE === '1' ? null : new Map();

function storeSig(file) {
  // P3 修正（2026-10-20 Codex 审查）：加入 ino + ctimeMs——touch -r / cp -p / 解压保留时间 会改 ino 或 ctime，
  // 单靠 mtimeMs+size 会漏；读路径另做 before/after 复核防 TOCTOU。
  try { const st = statSync(file); return st.ino + ':' + st.mtimeMs + ':' + st.ctimeMs + ':' + st.size; } catch { return null; }
}

/** 写路径调用：让该库缓存失效（不传 name ⇒ 全清）。 */
export function invalidateStoreCache(name) {
  if (!STORE_CACHE) return;
  if (name === undefined) STORE_CACHE.clear(); else STORE_CACHE.delete(name);
}
export function clearStoreCache() { invalidateStoreCache(undefined); }

function storeView(value) {
  // P3 契约（2026-10-20 Codex B2/B5）：缓存是内部快照，对外每次返回新的数组壳；
  // 调用方 push/sort 不会污染缓存，且 NOCACHE 与缓存分支的数组恒等性一致。
  return { name: value.name, records: value.records.slice(), errors: value.errors.slice() };
}

export function loadStore(name, file = storePath(name)) {
  if (!existsSync(file)) return { name, records: [], errors: [{ line: 0, error: '文件不存在：' + file }] };
  // V8 string limit: a >480 MiB JSONL file cannot be read as one string. The session
  // index is the only store that reaches this size; stream it instead of readFileSync.
  // Parser errors are returned, never silently retried through a whole-file read.
  let size = 0;
  try { size = statSync(file).size; } catch { /* size unavailable; normal read may report */ }
  if (size > 480 * 1024 * 1024) return { name, ...parseJsonlStream(file), largeFile: true };
  if (!STORE_CACHE) return { name, ...parseJsonl(readFileSync(file, 'utf8')) };
  const hit = STORE_CACHE.get(name);
  // 同一 name 可能指向不同 file（opts.files / 测试夹具 / 沙箱根）⇒ file 必须一起比，否则串库
  if (hit && hit.file === file) {
    const now = storeSig(file);
    if (now !== null && hit.sig === now) return storeView(hit.value);
  }
  // B6（2026-10-20 Codex 审查）：读路径不持写锁，append 可能正在写；用 stat→read→stat 复核，
  // 且解析有错（半写尾行）不缓存，避免把截断结果冻结到下一次读取。
  const before = storeSig(file);
  const value = { name, ...parseJsonl(readFileSync(file, 'utf8')) };
  const after = storeSig(file);
  if (before !== null && before === after && value.errors.length === 0) STORE_CACHE.set(name, { file, sig: after, value });
  return storeView(value);
}

/**
 * 从文件**尾部**倒读 JSONL 行（2026-10-13 审计 P6：hooks.jsonl 线性增长面的读侧优化）。
 * 设计口径（改过一版，这里写清楚为什么）：
 *   · **永远分块倒扫**（不设"小文件整读"捷径）——整读与小文件捷径都让「读多少」与「窗口多大」脱钩，
 *     日志一涨就退回整份解析；倒扫的成本只与「调用方实际需要的窗口」成正比。
 *   · 字节级切行（不在块边界做字符串拼接）——UTF-8 里 `\n` 只出现在单字节位置，`buf[i]===10` 是精确判定。
 *   · **窗口边界即停**（`stopWhen`）：本日志近似单调（时间正序追加），倒扫中首次遇到窗口外记录后，
 *     再往前读到的只会更旧；继续读到行数/字节上限纯属浪费。注意：这假定日志**大致按时间追加**——
 *     `ts` 缺失的行（不计入边界判定）与倒序写入的异常行仍会按 caps 读入，不静默改变语义（如实短读）。
 *   lines —— 行数上限（安全垫；读够即停）
 *   maxBytes —— 字节上限（硬闸；到顶即停，返回已读部分）
 *   filter —— 逐行判定；返回 false 的行不进结果，但**仍计入**行数/字节预算（保证窗口完整）
 *   stopWhen —— 收到记录后判定：true ⇒ 已越过窗口边界，立即停（不把更旧的历史读进来）
 * 坏行静默跳过（与既有 usage 读取口径一致；需要坏行报错的场景继续走 loadStore / parseJsonl）。
 */
export function readJsonlLinesReverse(file, { lines = 2000, maxBytes = 8 * 1024 * 1024, filter = null, stopWhen = null } = {}) {
  if (!existsSync(file)) return [];
  let size = 0;
  try { size = statSync(file).size; } catch { return []; }
  if (!size) return [];
  const want = Math.max(1, Number(lines) || 1);
  const cap = Math.max(1024, Number(maxBytes) || 8 * 1024 * 1024);
  const CHUNK = 64 * 1024;
  const fd = openSync(file, 'r');
  try {
    // ── 单缓冲尾部读取（2026-10-13 重写：前一版按块切行，边界算术连翻四次车——丢行/重行/粘行。
    //    这一版**不做跨块拼接**：从文件尾往前块读，接进同一条连续缓冲，**读完之后**才按 `\n` 切。──
    let buf = Buffer.alloc(0);
    let filled = 0;                                   // 已读字节数（位于 buf 尾部）
    let pos = size;                                   // 下一个要读的右边界
    while (pos > 0 && filled < cap) {
      const take = Math.min(CHUNK, pos, cap - filled);
      if (take <= 0) break;
      const room = buf.length - filled;               // 现有空位（可能为负：缓冲区比已读数据还小）
      if (room < take) {                              // 扩容（上限 cap）
        const next = Buffer.alloc(Math.min(cap, Math.max(buf.length * 2, filled + take)));
        buf.copy(next, next.length - filled);
        buf = next;
      }
      const at = buf.length - filled - take;
      const n = readSync(fd, buf, at, take, pos - take);
      if (n <= 0) break;
      pos -= n;
      filled += n;
    }
    // 取「最后 want 条」：先切行、再解析、**解析不成的不计数**。
    //   踩坑记录：先按行数切窗口、再解析，会把坏行算进 want ⇒ 请求 1 条却被坏行占掉（实测 got 0）。
    //   正确顺序 = 从尾往前逐条 parse，凑够 want 条（或 filter 通过 want 条）即止。
    const region = buf.subarray(buf.length - filled).toString('utf8');
    const parts = region.split('\n');
    const out = [];
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const s = parts[i].trim();
      if (!s) continue;
      let rec = null;
      try { rec = JSON.parse(s); } catch { continue; }       // 坏行/半行：跳过，且**不占** want 名额
      if (filter && !filter(rec)) continue;                  // 被过滤的行同样不占名额（窗口完整性由读取端保证）
      out.push(rec);
      if (out.length >= want) break;
      if (stopWhen && stopWhen(rec)) break;
    }
    out.reverse();
    return out;
  } finally { closeSync(fd); }
}

const isStr = v => typeof v === 'string' && v.trim() !== '';
const isNum = v => typeof v === 'number' && Number.isFinite(v);

export function validateRecord(store, r) {
  if (!r || typeof r !== 'object') return ['记录不是对象'];
  const e = [];
  if (!isStr(r.id)) e.push('缺少 id');
  if (['canon', 'orphan'].includes(store)) {
    if (r.status !== undefined && !PROPOSAL_STATUSES.includes(r.status)) e.push('status 须为 ' + PROPOSAL_STATUSES.join('/') + '（可省略；缺省=accepted）');
    if (r.proposed_by !== undefined && !isStr(r.proposed_by)) e.push('proposed_by 须为非空字符串（可省略）');
    if (r.status === 'proposed' && !isStr(r.proposed_by)) e.push('status=proposed 时必须提供 proposed_by');
    if (r.accepted_by !== undefined && !isStr(r.accepted_by)) e.push('accepted_by 须为非空字符串（可省略）');
    if (r.accepted_at !== undefined && !isStr(r.accepted_at)) e.push('accepted_at 须为非空字符串（可省略）');
  } else if (['proposed', 'accepted'].includes(r.status)) {
    e.push('提案 status 仅支持 canon / orphan');
  }
  // 2026-10-15（GPT 复核 core N2）：**格式**也要校——只查「非空字符串」时 '15/10/2026' 能经通用 `add` / MCP `revise`
  // 落库（专门入口修了、公共写层没修 ⇒ 写进去却按日期查不到）。与读侧 normalizeDateArg 同口径；存量真库实测 0 条受影响。
  if (r.event_time !== undefined) {
    if (!isStr(r.event_time)) e.push('event_time 须为非空字符串（YYYY-MM-DD 或 ISO）');
    else if (!normalizeDateArg(r.event_time).ok) e.push('event_time 格式非法（应为 YYYY-MM-DD 或 ISO 8601）：' + r.event_time);
  }
  if (r.logged_at !== undefined && !isStr(r.logged_at)) e.push('logged_at 须为非空字符串（ISO）');
  // revokes（2026-10-14 SCHEMA §P4 落地）：撤销记录指向被撤的墓碑 id。
  if (r.revokes !== undefined && !isStr(r.revokes)) e.push('revokes 须为墓碑 id（非空字符串）');
  if (r.valence !== undefined && (!isNum(r.valence) || r.valence < -1 || r.valence > 1)) e.push('valence 须为 [-1,1] 内数字');
  if (r.arousal !== undefined && (!isNum(r.arousal) || r.arousal < 0 || r.arousal > 1)) e.push('arousal 须为 [0,1] 内数字');
  // #37 perspective（2026-10-12 窗口 5）：视角字段可选，只许 world/experience（禁自动抽取，人工填）。
  if (r.perspective !== undefined && !PERSPECTIVES.includes(r.perspective)) e.push('perspective 须为 ' + PERSPECTIVES.join('/') + '（可省略；缺省=不参与过滤）');
  if (r.category !== undefined && !CATEGORIES.includes(r.category)) e.push('category 须为 ' + CATEGORIES.join('/') + '（可省略；缺省=未分类）');
  // I-09 因果注释（2026-10-14，**字段先行**）：可选 `caused_by` / `led_to` —— 轻量 id 引用（非空字符串数组）。
  //   设计口径：写入时标「估计的因果父」（LLM 近似标注即可，不必完整因果推断）；**检索侧不改**（「为什么」类链遍历后置）。
  for (const f of ['caused_by', 'led_to']) {
    if (r[f] === undefined) continue;
    if (!Array.isArray(r[f]) || !r[f].length || r[f].some((x) => !isStr(x) || !x.trim())) e.push(f + ' 须为非空字符串数组（id 引用；可省略）');
  }
  if (store === 'canon') {
    if (!isStr(r.claim)) e.push('缺少 claim');
    if (!r.source || !SOURCE_TYPES.includes(r.source.type)) e.push('source.type 须为 ' + SOURCE_TYPES.join('/'));
    if (!r.source || !isStr(r.source.ref)) e.push('缺少 source.ref');
    if (!isStr(r.last_reviewed)) e.push('缺少 last_reviewed');
    // #13 触发词路由的字段面（2026-10-12 窗口 2 补校验）：hint（≤80 字反射文本）+ triggers（触发词数组）+ hint_until（到期日）。
    //   显示侧硬裁在 sleep 插件（trim80）；这里给**写入侧软上限**（>160 即拦，防存进去必被裁的长文本）。
    if (r.hint !== undefined && (!isStr(r.hint) || !r.hint.trim())) e.push('hint 须为非空字符串（≤80 字；可省略）');
    else if (isStr(r.hint) && r.hint.length > 160) e.push('hint 过长（' + r.hint.length + ' 字）：显示侧会按 80 字裁剪，请写到 80 字内');
    if (r.triggers !== undefined && (!Array.isArray(r.triggers) || !r.triggers.length || r.triggers.some((t) => !isStr(t) || !t.trim()))) e.push('triggers 须为非空字符串数组（如 ["改文件","patch"]；可省略）');
    if (r.hint_until !== undefined && (!isStr(r.hint_until) || !/^\d{4}-\d{2}-\d{2}/.test(r.hint_until))) e.push('hint_until 须为 YYYY-MM-DD（可省略）');
  }
  if (store === 'mirror') {
    for (const f of ['situation', 'behavior', 'outcome', 'social_reaction', 'emotion', 'story'])
      if (!isStr(r[f])) e.push('缺少 ' + f);
    // wave1：解法库 / 边界库同库分层（可选字段；缺省 = 未分层，行为与旧版一致）。
    if (r.role !== undefined && !MIRROR_ROLES.includes(r.role)) e.push('role 须为 ' + MIRROR_ROLES.join('/') + '（解法 / 边界；可省略）');
    // wave4：出处/时代/语境/结构标签（均可选；缺省＝旧数据不受影响）。
    if (r.evidence !== undefined && !MIRROR_EVIDENCE.includes(r.evidence)) e.push('evidence 须为 ' + MIRROR_EVIDENCE.join('/') + '（可省略）');
    if (r.era !== undefined && !isStr(r.era)) e.push('era 须为非空字符串（可省略）');
    if (r.context !== undefined && !isStr(r.context)) e.push('context 须为非空字符串（可省略）');
    if (r.patterns !== undefined && (!Array.isArray(r.patterns) || r.patterns.some((x) => typeof x !== 'string'))) e.push('patterns 须为字符串数组（可省略）');
    // #3 不适用条件（2026-10-12 窗口 2）：形状与算子合法性走 #9 校验器（非法即抛 ⇒ 转成校验错误）。
    if (r.not_applicable !== undefined) {
      try { validateCondition(r.not_applicable, 'not_applicable'); }
      catch (err) { e.push('not_applicable 条件非法：' + err.message); }
    }
  }
  if (store === 'orphan') {
    for (const f of ['summary', 'observed', 'hypothesis', 'would_confirm', 'would_refute'])
      if (!isStr(r[f])) e.push('缺少 ' + f);
    if (!SEVERITIES.includes(r.severity)) e.push('severity 须为 ' + SEVERITIES.join('/'));
    if (!isStr(r.created)) e.push('缺少 created');
  }
  if (store === 'pricing') {
    if (!isStr(r.behavior)) e.push('缺少 behavior');
    if (!isNum(r.valence) || r.valence < -1 || r.valence > 1) e.push('valence 须为 [-1,1] 内数字');
    if (!Number.isInteger(r.severity_default) || r.severity_default < 1 || r.severity_default > 5) e.push('severity_default 须为 1..5 整数');
  }
  if (store === 'lexicon') {
    for (const f of ['term', 'trigger', 'behavior', 'resolution', 'source'])
      if (!isStr(r[f])) e.push('缺少 ' + f);
  }
  if (store === 'frontier') {
    for (const f of ['title', 'url', 'topic', 'status', 'last_checked', 'next_review'])
      if (!isStr(r[f])) e.push('缺少 ' + f);
    if (!['已实践', '已复现', '高引用', '待验证'].includes(r.status)) e.push('status 须为 已实践/已复现/高引用/待验证');
    if (isStr(r.url) && !/^https?:\/\//.test(r.url)) e.push('url 须以 http(s):// 开头');
    if (r.year !== undefined && r.year !== null && !Number.isInteger(r.year)) e.push('year 须为整数或留空');
    if (r.supports !== undefined && (!Array.isArray(r.supports) || r.supports.some(s => typeof s !== 'string'))) e.push('supports 须为字符串数组');
  }
  // wave2 §3：验证事件只记在修订版上（根版的层级由 source.type 推导，不另存）。ref 必填。
  if (r.verification !== undefined) {
    const v = r.verification;
    if (!v || typeof v !== 'object' || Array.isArray(v)) e.push('verification 须为对象');
    else {
      if (!VERIFY_KINDS.includes(v.kind)) e.push('verification.kind 须为 ' + VERIFY_KINDS.join('/'));
      if (!isStr(v.at)) e.push('verification.at 须为非空字符串（YYYY-MM-DD 或 ISO）');
      if (!isStr(v.ref)) e.push('verification.ref 必填（指向可核对的来源：会话 ptr / frontier id / URL）');
      if (!isStr(r.supersedes)) e.push('verification 只允许出现在修订版（须带 supersedes）');
    }
  }
  // wave2 §1：段升格来源（可选）。replay 只允许人工确认，且仅 canon + source.type=复现 必填。
  if (r.promoted_from !== undefined) {
    const p = r.promoted_from;
    if (!p || typeof p !== 'object' || Array.isArray(p)) e.push('promoted_from 须为对象');
    else {
      if (p.store !== 'session') e.push('promoted_from.store 须为 session');
      if (!isStr(p.id) || !p.id.startsWith('seg-')) e.push('promoted_from.id 须为段 id（seg- 开头）');
      if (!isStr(p.session)) e.push('promoted_from.session 须为非空字符串');
      if (!Number.isInteger(p.seq)) e.push('promoted_from.seq 须为整数');
      if (!isStr(p.at)) e.push('promoted_from.at 须为非空字符串（ISO）');
      if (p.replay !== undefined && p.replay !== 'manual') e.push('promoted_from.replay 只允许 "manual"');
      if (p.replay === 'manual' && !isStr(p.replay_at)) e.push('promoted_from.replay_at 须为非空字符串');
      if (p.replay === undefined && p.replay_at !== undefined) e.push('没有 replay 不得写 replay_at');
      const replaySource = store === 'canon' && r.source && r.source.type === '复现';
      if (replaySource && p.replay !== 'manual') e.push('source.type=复现 必须带 promoted_from.replay="manual"（段里没有成败，不能代核）');
      if (p.replay !== undefined && !replaySource) e.push('promoted_from.replay 仅用于 canon 且 source.type=复现');
    }
  }
  // #6 关系边（2026-10-12 窗口 1）：形状层校验（悬空检查在 checkRelations——须跨记录）。
  if (r.relates_to !== undefined && (!Array.isArray(r.relates_to) || r.relates_to.some((x) => !isStr(x)) || r.relates_to.some((x) => !x.trim())))
    e.push('relates_to 须为非空字符串数组（可省略）');
  if (r.relations !== undefined) {
    if (!Array.isArray(r.relations) || r.relations.some((x) => !x || typeof x !== 'object' || Array.isArray(x))) e.push('relations 须为对象数组（可省略）');
    else for (const it of r.relations) {
      if (!isStr(it.type) || !it.type.trim()) e.push('relations[].type 须为非空字符串（如 supports / contradicts / relates）');
      if (!isStr(it.id) || !it.id.trim()) e.push('relations[].id 须为非空字符串（指向条目 id）');
    }
  }
  return e;
}

export function checkAll(opts = {}) {
  const report = { ok: true, errors: [], stores: {} };
  const loaded = {};
  for (const name of STORES) {
    const { records, errors } = loadStore(name, (opts.files && opts.files[name]) || storePath(name));
    loaded[name] = records;
    const ids = new Set(); const dups = [];
    let ok = 0;
    records.forEach((r, i) => {
      const errs = validateRecord(name, r);
      if (errs.length) report.errors.push({ store: name, index: i, id: r.id, errors: errs });
      else ok += 1;
      if (isStr(r.id)) { if (ids.has(r.id)) dups.push(r.id); ids.add(r.id); }
    });
    errors.forEach(x => report.errors.push({ store: name, ...x }));
    if (dups.length) report.errors.push({ store: name, errors: ['重复 id：' + dups.join(', ')] });
    for (const e of checkSupersedes(name, records)) report.errors.push(e);
    for (const e of checkRetires(name, records)) report.errors.push(e);
    for (const e of checkRelations(name, records)) report.errors.push(e);
    report.stores[name] = { total: records.length, ok, current: currentRecords(records).length, proposed: pendingProposalCount(records), retired: retiredIds(records).size, loadErrors: errors.length };
  }
  // wave2 §1：升格跨库核对。没有 promoted_from 且会话文件不存在 → 不读。
  // 文件在则整次只读一次（段 id 集合 + promotion 标记）；坏行报错；绝不打开 zstd 原档。
  const sessionFile = opts.sessionFile !== undefined ? opts.sessionFile : join(DATA, 'session.jsonl');
  for (const err of checkPromotions(loaded, sessionFile)) report.errors.push(err);
  // 2026-10-17：**id 跨库唯一性守卫**（四项待裁之三的落地方式）。
  //   实测基线：1273 条记录 / 1273 个唯一 id / 跨库同 id **0** ⇒ 不做"改模板"或"产物附 file"两个大方案
  //   （前者要迁移全部 id，后者要改所有写入与读端），只加这条**只读断言**：平时安静，真撞号那天自己红。
  {
    const owner = new Map();
    for (const name of STORES) {
      for (const r of (loaded[name] || [])) {
        if (!r || !isStr(r.id)) continue;
        if (!owner.has(r.id)) owner.set(r.id, new Set());
        owner.get(r.id).add(name);
      }
    }
    for (const [id, set] of owner) {
      if (set.size > 1) report.errors.push({ store: 'cross', id, errors: ['id 跨库重复：' + [...set].join('、') + '（六库共用一个命名空间）'] });
    }
  }
  report.ok = report.errors.length === 0;
  return report;
}

/** 升格三向 + 会话文件缺失/坏行。纯核对，不读 ptr、不打开归档。 */
export function checkPromotions(loaded, sessionFile) {
  const out = [];
  const promoted = [];
  for (const name of STORES) {
    for (const r of loaded[name] ?? []) {
      if (!r || !r.promoted_from || r.retires) continue;
      promoted.push({ store: name, rec: r });
    }
  }
  const present = existsSync(sessionFile);
  if (!promoted.length && !present) return out;
  if (promoted.length && !present) {
    out.push({ store: 'session', code: 'promotion-session-missing', errors: ['有升格记录但 session.jsonl 不存在：' + sessionFile] });
    return out;
  }
  const sessionSize = (() => { try { return statSync(sessionFile).size; } catch { return 0; } })();
  const parsed = sessionSize > 480 * 1024 * 1024
    ? loadStore('session', sessionFile)
    : parseJsonl(readFileSync(sessionFile, 'utf8'));
  for (const err of parsed.errors) out.push({ store: 'session', code: 'bad-jsonl', ...err, errors: [err.error] });
  const segIds = new Set();
  const summaryIds = new Set();   // #32：摘要/派生类 id —— 只许引叶、不许被引（promotion/topic/node）
  const marks = [];
  for (const r of parsed.records) {
    if (!r || typeof r !== 'object') continue;
    if (r.kind === 'promotion') { marks.push(r); if (isStr(r.id)) summaryIds.add(r.id); continue; }
    if (r.kind === 'node' || r.kind === 'topic') { if (isStr(r.id)) summaryIds.add(r.id); }
    if (isStr(r.id)) segIds.add(r.id);
  }
  const markKey = new Set();
  for (const m of marks) {
    const to = m.promoted_to;
    if (!to || !STORES.includes(to.store) || !isStr(to.id) || !isStr(m.seg)) {
      out.push({ store: 'session', id: m.id, code: 'promotion-dangling', errors: ['promotion 标记不完整：' + (m.id ?? '?')] });
      continue;
    }
    const ids = new Set((loaded[to.store] ?? []).map((r) => r && r.id).filter(Boolean));
    if (!ids.has(to.id)) out.push({ store: 'session', id: m.id, code: 'promotion-dangling', errors: [`标记指向不存在的记录 ${to.store}/${to.id}`] });
    markKey.add(to.store + '\0' + to.id + '\0' + m.seg);
  }
  // #32 合成禁互引（2026-10-11 立；外部对照启发＝Hindsight 的 `exclude_mental_models`）：
  //   摘要/派生类段落**不许在引用面里指向别的摘要** —— 防「错误主张在摘要之间循环放大」。
  //   口径（实测标定过，勿改宽）：只查**引用类字段**；**不查结构字段**（`children` 是树的父子关系，合法）。
  //     ← 第一版判定器就是漏了这条，把 12 处 L2→L1 的 children 误报成"互引" ✗
  const CITE_FIELDS = ['based_on', 'cites', 'refs', 'source'];

    // 引用完整性（2026-10-11 手检补）：摘要/派生段的**引用类字段**（based_on/cites/refs）里写的 id
  //   必须**真实存在**（同文件内的段 id ∪ 六库记录 id）。此前没有这条 ⇒ 写错 id 无人发现 ✓
  //   注意：只认**结构化字段**，不做文本扫描（文本里的 id 形态含大量截断产物，扫了就是假警 ✗ 见 PROTOCOL §七.7⑤）。
  {
    const known = new Set(segIds);
    for (const name of STORES) for (const r of (loaded[name] ?? [])) if (r && isStr(r.id)) known.add(r.id);
    for (const r of parsed.records) {
      if (!r || typeof r !== 'object' || !summaryIds.has(String(r.id))) continue;
      for (const f of CITE_FIELDS) {
        const v = r[f];
        const list = Array.isArray(v) ? v : (v && typeof v === 'object' && isStr(v.id) ? [v.id] : (isStr(v) ? [v] : []));
        for (const id of list) if (isStr(id) && !known.has(id)) out.push({ store: 'session', id: r.id, code: 'cite-dangling', errors: ['引用指向不存在的记录（' + f + '）：' + id] });
      }
    }
  }
  for (const r of parsed.records) {
    if (!r || typeof r !== 'object' || !summaryIds.has(String(r.id))) continue;
    const face = CITE_FIELDS.map((f) => JSON.stringify(r[f] ?? '')).join(' ');
    for (const sid of summaryIds) {
      if (sid !== String(r.id) && face.includes(sid)) {
        out.push({ store: 'session', id: r.id, code: 'summary-cites-summary', errors: ['摘要只许引叶段（不许引摘要/派生类）：' + sid] });
        break;
      }
    }
  }
  const covered = (store, rec) => {
    const byId = new Map((loaded[store] ?? []).filter((r) => r && r.id).map((r) => [r.id, r]));
    let cur = rec;
    const seen = new Set();
    while (cur && cur.id && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (markKey.has(store + '\0' + cur.id + '\0' + rec.promoted_from.id)) return true;
      cur = cur.supersedes ? byId.get(cur.supersedes) : null;
    }
    return false;
  };
  for (const { store, rec } of promoted) {
    const from = rec.promoted_from;
    if (!from || !isStr(from.id) || !segIds.has(from.id)) {
      out.push({ store, id: rec.id, code: 'promotion-source-missing', errors: ['promoted_from 指向不存在的段：' + (from && from.id)] });
    } else if (summaryIds.has(String(from.id))) {
      // #32：堵住旧口径的洞 —— node/topic 的 id 也在 segIds 里，故"存在"不足以证明"是叶"。
      out.push({ store, id: rec.id, code: 'promotion-source-not-leaf', errors: ['promoted_from 只许指向叶段（不许引摘要/派生类）：' + from.id] });
    }
    if (!covered(store, rec)) {
      out.push({ store, id: rec.id, code: 'promotion-unmarked', errors: ['有 promoted_from 但没有 promotion 标记：' + rec.id] });
    }
  }
  return out;
}

const LOOKUP_FIELDS = {
  canon: ['claim', 'tags'],
  mirror: ['situation', 'behavior', 'outcome', 'social_reaction', 'emotion', 'story', 'era', 'context', 'patterns'],
  orphan: ['summary', 'observed', 'hypothesis'],
  pricing: ['behavior'],
  lexicon: ['term', 'trigger', 'behavior', 'resolution'],
  frontier: ['title', 'note', 'topic', 'supports']
};

// 检索计分（2026-10-07 检索退化修复，对应 orphan-brief-phrase-miss-20261007）：
// 整词命中 ×1；含中文且 ≥3 字的词追加相邻二字（bigram）回退 ×0.25——治「词组未原样出现 → 零命中」。
// 2 字词与纯 ASCII 词的行为与旧版一致。
const CJK_RE = /[\u4e00-\u9fff]/;
const TOKEN_SPLIT_RE = /[\s,，、|]+/;
// #37 视角字段（2026-10-12 窗口 5）：world=别人说的（教材/常识）；experience=自己踩过的（亲历教训）。
export const PERSPECTIVES = Object.freeze(['world', 'experience']);
// ── 条件谓词化（2026-10-11 解冻后新增；外部对照启发：灵枢的「条件可判定」）──
// 目的：把「生效条件 / 不适用条件」从散在代码里的 if，变成**跟着数据走的 JSON 条件**（可查、可审、可单测）。
// 形态（极简，约 50 行；**不写编译器**——那 290 KB 换的是可编程性，我们要的是可审计性）：
//   原子：{ field: 值 }                    ⇒ 相等
//        { field: { eq|ne|gte|lte|in|contains: 值 } }
//   组合：{ and: [条件…] } · { or: [条件…] } · { not: 条件 }
// 纪律（与既有门控同口径）：**非法条件抛错，绝不静默放宽**；求值只读、无副作用；未知算符 = 非法。
export const COND_ATOM_OPS = Object.freeze(['eq', 'ne', 'gte', 'lte', 'in', 'contains']);
export const COND_LOGICAL_OPS = Object.freeze(['and', 'or', 'not']);

/** 形状校验：不合法就抛（带路径），不返回真假。 */
export function validateCondition(cond, path = '$') {
  if (cond === null || typeof cond !== 'object' || Array.isArray(cond)) throw new Error(`条件非法（${path}）：须为对象`);
  for (const [k, v] of Object.entries(cond)) {
    if (COND_LOGICAL_OPS.includes(k)) {
      if (k === 'not') { validateCondition(v, `${path}.not`); continue; }
      if (!Array.isArray(v) || !v.length) throw new Error(`条件非法（${path}.${k}）：须为非空数组`);
      v.forEach((c, i) => validateCondition(c, `${path}.${k}[${i}]`));
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const ops = Object.keys(v);
      if (!ops.length) throw new Error(`条件非法（${path}.${k}）：算子对象为空`);
      for (const op of ops) {
        if (!COND_ATOM_OPS.includes(op)) throw new Error(`条件非法（${path}.${k}）：未知算子「${op}」（可用：${COND_ATOM_OPS.join('/')}）`);
        if (op === 'in' && !Array.isArray(v[op])) throw new Error(`条件非法（${path}.${k}.in）：须为数组`);
      }
    }
  }
  return true;
}

/** 求值（只读）。ctx 为可判定事实的平面对象（如 { turn, usedTools, failedRecently, date }）。 */
export function evalCondition(cond, ctx = {}) {
  validateCondition(cond);
  const atom = (actual, op, expect) => {
    switch (op) {
      case 'eq': return actual === expect;
      case 'ne': return actual !== expect;
      case 'gte': return typeof actual === 'number' && typeof expect === 'number' && actual >= expect;
      case 'lte': return typeof actual === 'number' && typeof expect === 'number' && actual <= expect;
      case 'in': return Array.isArray(expect) && expect.includes(actual);
      case 'contains':
        return Array.isArray(actual) ? actual.includes(expect)
          : (typeof actual === 'string' && typeof expect === 'string' && actual.includes(expect));
      default: throw new Error(`未知算子「${op}」`);
    }
  };
  for (const [k, v] of Object.entries(cond)) {
    if (k === 'and') { if (!v.every((c) => evalCondition(c, ctx))) return false; continue; }
    if (k === 'or') { if (!v.some((c) => evalCondition(c, ctx))) return false; continue; }
    if (k === 'not') { if (evalCondition(v, ctx)) return false; continue; }
    const actual = ctx[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [op, expect] of Object.entries(v)) if (!atom(actual, op, expect)) return false;
      continue;
    }
    if (!atom(actual, 'eq', v)) return false;
  }
  return true;
}

export function tokenize(q) {
  return String(q || '').toLowerCase().split(TOKEN_SPLIT_RE).filter(Boolean);
}
/** 计分零件（2026-10-07 复查）：whole＝整词命中次数（每次 ×1）；fb＝中文回退贡献（单 token 封顶 0.9，仅 ≥3 字 CJK 词）。
 *  ⚠ 2026-10-14 修复（K1 复检暴露）：**<2 字 token 不参整词**——单字功能词（的/了/是）按出现次数计分（如百字长文「的」×70）
 *  会以噪声洪水淹没真命中（实测：「也吃桌面端 pnpm」命中目标孤案，尾加「的」后目标被「的」最多的条目挤出显示面）。 */
export function matchParts(hayL, token) {
  const t = String(token || '').toLowerCase();
  if (t.length < 2) return { whole: 0, fb: 0 }; // 单字 token：噪声源（2026-10-14 守卫）
  let whole = 0;
  let idx = hayL.indexOf(t);
  while (idx !== -1) { whole += 1; idx = hayL.indexOf(t, idx + t.length); }
  let fb = 0;
  if (t.length >= 3 && CJK_RE.test(t)) {
    let bg = 0;
    for (let i = 0; i < t.length - 1; i += 1) {
      const g = t.slice(i, i + 2);
      if (!CJK_RE.test(g)) continue;
      let j = hayL.indexOf(g);
      while (j !== -1) { bg += 1; j = hayL.indexOf(g, j + g.length); }
    }
    fb = Math.min(bg * 0.25, 0.9);
  }
  return { whole, fb };
}
export function matchScore(hayL, token) { const p = matchParts(hayL, token); return p.whole + p.fb; }
/** 记录级计分（2026-10-07 复查）：Σ整词 ×1 + min(Σ回退, 0.9)
 *  ⇒ **记录分 ≥1 ⟺ 至少一次整词命中**（口径承诺：多 token 弱回退叠加不得越过 1；此前「回退 <1」只按单 token 成立）。
 *  2026-10-18（排名缺陷 canon-session-rank-nodeflood-20261018）：可选 `capWhole` 给**每个 token 的整词分**封顶。
 *  用途＝会话层的 node 摘要（长 gist 里重复词会按出现次数洪水压过精确结论）；默认 Infinity ⇒ 其余调用方零漂移。 */
export function scoreTokens(hayL, tokens, opts = {}) {
  // 2026-10-18（复核 A·W4 / B·补丁B）：第三参消毒——NaN / 负数 / 非数字（含 null 第三参）回落 Infinity（不封顶），
  //   否则 NaN 会穿进 score 并让排序比较器拿到 NaN（顺序不可预测）。0 与数字串（"1"）/布尔（true）按数值处理（兼容旧行为）。
  const rawCap = opts?.capWhole;
  const c = Number(rawCap);
  const capWhole = rawCap != null && Number.isFinite(c) && c >= 0 ? c : Infinity;
  let whole = 0;
  let fb = 0;
  for (const t of tokens) { const p = matchParts(hayL, t); whole += Math.min(p.whole, capWhole); fb += p.fb; }
  return { whole, fb, score: whole + Math.min(fb, 0.9) };
}

// 情绪 tip（2026-10-07；wave3 起 arousal 主进 rankFactors.severity，避免与乘子双计）。
// emotionBoost 仍保留：旧测试与「只要 tip 不要整套因子」的调用方；brief 排序改走 rankFactors，
// 负价只留 +0.25 tip（教训优先），不再把 arousal 加进 base。
export function emotionBoost(r) {
  const arousal = typeof r.arousal === 'number' ? r.arousal : 0;
  const negative = typeof r.valence === 'number' && r.valence < 0 ? 0.25 : 0;
  return +(arousal * 0.5 + negative).toFixed(3);
}
/** brief 用的负价 tip（不含 arousal，arousal 已进严重度乘子）。 */
export function valenceTip(r) {
  return typeof r?.valence === 'number' && r.valence < 0 ? 0.25 : 0;
}

// 时间过滤（2026-10-07）：时间戳 = event_time（事件时间，优先）|| logged_at（记录时间，ISO UTC）。
// 带过滤参数时，无时间戳的条目被排除；比较按「记录本地日」（event_time 纯日期原样）。
function tsOf(r) { return r.event_time || r.logged_at || null; }
function recordDay(r) {
  const ts = tsOf(r);
  if (!ts) return null;
  // event_time 是作者写的日期（YYYY-MM-DD）⇒ 原样；logged_at 是 ISO 时刻 ⇒ 按本地日切（与 todayLocal 同口径）。
  if (r.event_time) {
    const ev = String(ts);
    if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(ev)) return ev;
    const ed = new Date(ev);
    return Number.isNaN(ed.getTime()) ? ev.slice(0, 10) : todayLocal(ed);
  }
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts).slice(0, 10) : todayLocal(d);
}
function inRange(r, since, until) {
  if (!since && !until) return true;
  const day = recordDay(r);
  if (!day) return false;
  if (since && day < String(since).slice(0, 10)) return false;
  if (until && day > String(until).slice(0, 10)) return false;
  return true;
}

/** 日期参数归一（接受 YYYY-MM-DD 或 ISO 8601；一律按 UTC 取日）。返回 {ok:true, day}|{ok:false, error}。 */
export function normalizeDateArg(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: true, day: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].+)?$/.exec(raw);
  if (!m) return { ok: false, error: `非法日期：${raw}（应为 YYYY-MM-DD 或 ISO 8601，含时区按 UTC 归一）` };
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const probe = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== day) return { ok: false, error: `非法日期：${raw}` };
  if (raw.length > 10) {
    const t = new Date(raw);
    if (Number.isNaN(t.getTime())) return { ok: false, error: `非法日期：${raw}` };
    return { ok: true, day: t.toISOString().slice(0, 10) };
  }
  return { ok: true, day };
}

/** 日期三分（单条）：in=范围内 / out=范围外 / undated=无戳（无法定年，不参与"该时段发生了什么"判断）；附 timeSource。 */
export function dateBucket(r, { since, until } = {}) {
  const hasEvt = !!r.event_time;
  const ts = tsOf(r);
  const src = ts ? (hasEvt ? 'event_time' : 'logged_at') : null;
  if (!since && !until) return { bucket: 'in', timeSource: src };
  if (!ts) return { bucket: 'undated', timeSource: null };
  const day = recordDay(r);
  if (since && day < String(since).slice(0, 10)) return { bucket: 'out', timeSource: src };
  if (until && day > String(until).slice(0, 10)) return { bucket: 'out', timeSource: src };
  return { bucket: 'in', timeSource: src };
}

/** 全库日期覆盖统计（供 cross/brief 的"日期未知"提示；与关键词无关的粗口径）。 */
export function dateCoverageStats({ since, until } = {}) {
  const stats = { undated: 0, excluded: 0, total: 0 };
  if (!since && !until) return stats;
  for (const name of STORES) {
    const { records } = loadStore(name);
    for (const r of currentRecords(records)) {
      stats.total += 1;
      const b = dateBucket(r, { since, until });
      if (b.bucket === 'undated') stats.undated += 1;
      else if (b.bucket === 'out') stats.excluded += 1;
    }
  }
  return stats;
}

// 对位比较的主行（每条记录“说什么”的那一行，不截断）。
const PRIMARY_LINE = {
  canon: (r) => String(r.claim ?? ''),
  mirror: (r) => `${r.situation ?? ''} → ${r.behavior ?? ''}`,
  orphan: (r) => String(r.summary ?? ''),
  pricing: (r) => String(r.behavior ?? ''),
  lexicon: (r) => `${r.term ?? ''}：${r.behavior ?? ''}`,
  frontier: (r) => String(r.title ?? '')
};

// 对位比较：把同一主题词在六库里的命中**全部**摆在一起（按库分组、当前版本、主行不截断）。
export function cross(query, opts = {}) {
  const __t0 = Date.now();                          // I-02：对位耗时（只进侧线）
  const __qRaw = String(query ?? '').trim();
  const q = String(query || '').trim().toLowerCase();
  // 2026-10-13（举一反三·类③）：空查询此前**静默返回 0 命中**（与 `cross` 的「请给一个主题词」提示不一致——
  //   同一类问题里，一个给提示、一个闷着）。补上 hint：0 命中 vs 空输入必须可区分。
  if (!q) return { query: '', hits: [], groups: [], total: 0, hint: '请给一个主题词（如：重启 / 记忆 / 来源态）。' };
  const tokens = tokenize(q);
  const groups = [];
  const rankOpts = loadBalanceEnabled(opts) ? { ...opts, usageWindow: opts.usageWindow || resolveUsageWindow(opts) } : opts;
  for (const name of STORES) {
    const records = recordsOf(name, opts);
    const creds = credibilityMap(name, records, opts);
    const hits = [];
    for (const r of currentRecords(records)) {
      if (name === 'mirror' && opts.mirrorSituationGate === true) {
        if (r.evidence !== 'story' || mirrorSituationScore(q, r).situationScore < 2) { filtered.mirrorSituationGate += 1; continue; }
      }
      const cred = creds.get(r.id);
      if (cred && cred.refuted && !opts.includeRefuted) continue;
      if (!inRange(r, opts.since, opts.until)) continue;
      if (opts.tag && !(r.tags || []).map(String).includes(String(opts.tag))) continue;   // ⑥ 按标签精确过滤（2026-10-11）
      const hay = (LOOKUP_FIELDS[name] || [])
        .map(f => (Array.isArray(r[f]) ? r[f].join(' ') : (r[f] || '')))
        .join(' | ');
      const hayL = hay.toLowerCase();
      const sc = scoreTokens(hayL, tokens);
      if (sc.score > 0) {
        const strong = name !== 'orphan' && sc.whole >= 1;
        const rf = applyRank(sc.score, name, r, cred, { ...rankOpts, strong });
        hits.push({
          id: r.id, score: sc.score, strong, zeroWeight: name === 'orphan', line: PRIMARY_LINE[name] ? PRIMARY_LINE[name](r) : hay,
          rank: rf.rank, factor: rf.factor, severity: rf.severity, complexity: rf.complexity, factorApplied: rf.factorApplied, balance: rf.balance,
          tier: cred ? cred.tier : null, displayTier: cred ? cred.displayTier : null, stale: !!(cred && cred.stale), refuted: !!(cred && cred.refuted),
          agePrefix: agePrefix(r, { today: opts.today })
        });
      }
    }
    hits.sort((a, b) => b.rank - a.rank || b.score - a.score);
    // 有界档保留完整候选；限量在 offset 定位之后执行，不能先截断再分页。
    const items = readTierActive(opts) ? hits : (opts.perStore ? hits.slice(0, opts.perStore) : hits);
    if (items.length) groups.push({ store: name, total: hits.length, items });
  }
  const total = groups.reduce((n, g) => n + g.total, 0);
  const multi = groups.filter(g => g.total >= 2).map(g => `${g.store}×${g.total}`);
  const hint = multi.length
    ? `同题多源：${multi.join('、')}——对位时若见矛盾：不合并；矛盾留档用「孤案」（orphan add），定论用「修订链」（revise）。`
    : null;
  // cross = 对位视图（并排对账）⇒ **豁免**「每次查阅上限」（那是取料类的事，2026-10-11）。
  // 体裁隔离＝渲染策略：不传 depth 时与 main 一样——默认剥皮、主行不截断。
  // 行宽（pointer 80 / summary 300）只在显式 depth=summary|pointer 时生效。
  // reflect / depth:full / rawProcess ＝原文不剥、不截。
  const depth = readDepthOf(opts);
  if (!highFidelityRead(opts)) {
    for (const g of groups) for (const it of g.items) it.line = stripGenre(String(it.line ?? ''));
  }
  if (readTierActive(opts)) {
    const cap = opts.depth === 'pointer' ? READ_TIER.pointerChars : READ_TIER.crossLineChars;
    for (const g of groups) for (const it of g.items) it.line = projectText(it.line, opts.depth, cap);
  }
  const citeAllowlist = [];
  for (const g of groups) for (const it of g.items) citeAllowlist.push({ id: it.id, store: g.store, tier: it.tier ?? null, strong: !!it.strong });
  const __out = { query: q, groups, total, hint, depth, citeAllowlist };
  if (opts.__noQueryLog !== true) recordQuery({ cmd: 'cross', query: __qRaw, hits: total, ms: Date.now() - __t0, ids: citeAllowlist.map((x) => x.id), genreRender: genreRenderOf(opts) }, opts);
  // F08（2026-10-14 外部审查 · GPT）：**显式给了 maxTokens / offset 才守预算**——默认仍豁免全量（「性能优先」：
  //   对位视图的完整可达性优先，削减只在调用方明确要求时发生；分页可续取 `budget.nextOffset`，不丢内容）。
  //   clipByBudget 原样保留（账实 + 原始序号）；depth / citeAllowlist 随结果对象带过去，不改裁剪算法。
  if (readTierActive(opts)) return clipByBudget(__out, {
    ...opts, pageLimits: boundedPageLimits(opts, READ_TIER.boundedPerStore),
    // cross 默认仍豁免 token 预算；有界档仅强制条数分页，显式 maxTokens 才同时限 token。
    contextBudget: opts.maxTokens === undefined ? false : opts.contextBudget
  });
  if (opts.maxTokens !== undefined || Math.floor(opts.offset ?? 0) > 0) return clipByBudget(__out, { ...opts });
  return __out;
}

// —— 可信度（wave2 §3）——
// 不新增存储字段。层级由根版 source.type 起步，沿修订链应用 verification；过期只降展示层。
// 系数只进排序权重与命中行标签，不改 strong / weak（strong 仍是整词命中 ≥ 1；孤案仍 zeroWeight）。
export const TIER_OF_SOURCE = Object.freeze({ '复现': 'T1', '实验': 'T2', '官方': 'T3', '他人': 'T4', '共识': 'T5' });
export const TIER_WEIGHT = Object.freeze({ T1: 1, T2: 0.9, T3: 0.8, T4: 0.65, T5: 0.5 });
export const VERIFY_KINDS = Object.freeze(['replay', 'experiment', 'doc', 'incident', 'refute']);
// 分类开关（2026-10-22，design-recognition-and-category 稿）：四类枚举；缺省=未分类，行为与旧版逐位一致。
export const CATEGORIES = Object.freeze(['安全', '纪律', '事实', '品味']);
export const CRED_DEFAULTS = Object.freeze({ snapshotDays: 90, evergreenDays: 180, verifyUsageMin: 3 });
const TIER_ORDER = Object.freeze({ T1: 1, T2: 2, T3: 3, T4: 4, T5: 5 });
const ORDER_TIER = Object.freeze(['', 'T1', 'T2', 'T3', 'T4', 'T5']);
const SNAPSHOT_ID_RE = /-(\d{8})$/;

const credDay = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');
const credAge = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
const betterTier = (a, b) => (!a ? b : (TIER_ORDER[a] <= TIER_ORDER[b] ? a : b));
const dropTier = (t) => (t ? ORDER_TIER[Math.min(5, TIER_ORDER[t] + 1)] : null);

// P1（2026-10-20）：`byId` 改为可选第三参。
// 原实现每次调用都 `new Map(records…)` 重建全库索引；credibilityMap / credibilityTodos 在循环里
// 对每条记录调一次 ⇒ canon 941 条约 88 万次 Map 插入，实测占 lookup 净耗时 28%（43.4ms）。
// 现由调用方在循环外建一次传入；不传则退回旧行为（单点调用如 show 无需改）。
function chainEndingAt(records, rec, byId) {
  const idx = byId || new Map(records.filter((r) => isStr(r.id)).map((r) => [r.id, r]));
  const chain = [];
  let c = rec;
  const seen = new Set();
  while (c && isStr(c.id) && !seen.has(c.id)) {
    seen.add(c.id);
    chain.unshift(c);
    c = isStr(c.supersedes) ? idx.get(c.supersedes) : null;
  }
  return chain;
}

/**
 * 一条链（根在前）的可信度。纯函数。
 * opts.today（YYYY-MM-DD，缺省本地今天）、snapshotDays、evergreenDays。
 * 返回 { tier（存储层，排序用）, displayTier（展示层，过期降一档）, weight, refuted, stale, cls, anchor, steps }。
 * 升格没有加成：promoted_from 不参与，层级就是 source.type + verification。
 */
export function credibilityOf(store, chain, opts = {}) {
  const rows = Array.isArray(chain) ? chain.filter((r) => r && typeof r === 'object') : [];
  const today = credDay(opts.today) || todayLocal();
  const steps = [];
  let tier = null;
  let refuted = false;
  rows.forEach((rec, i) => {
    const why = [];
    const type = rec.source && rec.source.type;
    const prevType = i > 0 && rows[i - 1].source ? rows[i - 1].source.type : undefined;
    if (TIER_OF_SOURCE[type] && (i === 0 || type !== prevType)) {
      tier = TIER_OF_SOURCE[type];
      why.push('source.type=' + type);
    }
    const v = rec.verification;
    const isRevision = isStr(rec.supersedes);
    if (v && typeof v === 'object' && isRevision && VERIFY_KINDS.includes(v.kind)) {
      if (v.kind === 'replay') { tier = 'T1'; refuted = false; }
      else if (v.kind === 'experiment') { tier = betterTier(tier, 'T2'); refuted = false; }
      else if (v.kind === 'doc') { tier = betterTier(tier, 'T3'); refuted = false; }
      else if (v.kind === 'refute') refuted = true;
      why.push('verification.' + v.kind);
    }
    steps.push({ id: rec.id ?? null, tier, refuted, why: why.join(' → ') || '沿用上一版' });
  });
  const root = rows[0] || {};
  const tip = rows[rows.length - 1] || {};
  const rootId = isStr(root.id) ? root.id : '';
  let cls = 'evergreen';
  if (rows.some((r) => isProtocolId(r.id))) cls = 'protocol';
  else if (store === 'frontier') cls = 'frontier';
  else if (SNAPSHOT_ID_RE.test(rootId)) cls = 'snapshot';
  let stale = false;
  let anchor = null;
  let limit = null;
  if (cls === 'snapshot') {
    anchor = credDay(tip.last_reviewed);
    limit = Number.isInteger(opts.snapshotDays) ? opts.snapshotDays : CRED_DEFAULTS.snapshotDays;
    stale = !!anchor && credAge(anchor, today) > limit;
  } else if (cls === 'frontier') {
    anchor = credDay(tip.next_review);
    stale = !!anchor && anchor <= today;
  } else if (cls === 'evergreen') {
    const marks = rows
      .filter((r) => r.verification && r.verification.kind !== 'incident')
      .map((r) => credDay(r.verification.at))
      .filter(Boolean)
      .sort();
    const lastV = marks.length ? marks[marks.length - 1] : '';
    const reviewed = credDay(tip.last_reviewed);
    anchor = lastV > reviewed ? lastV : (reviewed || null);
    limit = Number.isInteger(opts.evergreenDays) ? opts.evergreenDays : CRED_DEFAULTS.evergreenDays;
    stale = !!anchor && credAge(anchor, today) > limit;
  }
  const displayTier = stale ? dropTier(tier) : tier;
  const weight = refuted ? 0 : (tier ? TIER_WEIGHT[tier] : 1);
  return {
    tier, displayTier, weight, refuted, stale, cls, anchor, limitDays: limit, today, steps,
    label: [displayTier, refuted ? 'refuted' : '', stale ? '待复核' : ''].filter(Boolean).join(' ')
  };
}

// —— 排序补齐（wave3 · 严重度 × 可信度 × 复杂度）——
// 只进排序 / 展示，不改存储。不新增字段：用已有 severity / severity_default / valence / arousal。
// strong / weak 仍只看 scoreTokens 整词命中；孤案仍 zeroWeight。时间仍只做 --since/--until 门与有效期门。
// A1 检索负载均衡（research/weight-internalization-pid）：默认关闭；开启后只乘校正项，不改语义/不删条。
export const LOAD_BALANCE_DEFAULTS = Object.freeze({
  windowMs: 7 * 24 * 3600 * 1000, // 近期窗口（缺省 7 天）
  kP: 1,            // 超配额衰减强度（防垄断）
  kExplore: 0.25,   // 长期零引用 + 弱命中的探索加成上限
  kD: 0.5,          // 集中度恶化斜率的刹车强度
  slopeThresh: 0.05,// HHI 斜率超过此值才激活 D 项
  minCorrection: 0.25,
  maxCorrection: 1.5
});
export const RANK_DEFAULTS = Object.freeze({ loadBalance: false });

// —— 知识分层（wave4）——
// 路由：模型内建 → 技能/插件 → 本地大图馆（六库）→ 外网检索（宿主可插）。
// core 不实现搜索器；只定义层标签、认知态与 hostWebSearch 契约。可信度 T1..T5 挂在 library 层命中上。
export const KNOWLEDGE_LAYERS = Object.freeze([
  Object.freeze({ id: 'model', order: 1, label: '模型内建', host: false,
    note: '官方模型参数内知识；不可审计，只作起点，不得冒充库内证据' }),
  Object.freeze({ id: 'skill', order: 2, label: '技能/插件', host: false,
    note: '宿主 skill / 工具说明' }),
  Object.freeze({ id: 'library', order: 3, label: '本地大图馆', host: false,
    stores: Object.freeze(['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier']),
    // 改口 2026-10-12（手检）：原「已核共识」对全层设了过高预期 ⇒ 级别看 tier（T1 已复现 / T2 自证·不升共识 / T4 他人·待补引）。
    note: '本地库同步；级别看 tier：T1 已复现 / T2 自证·不升共识 / T4 他人·待补引；原文不可变，注释/改口走 revise；frontier 经 due/recheck 排期刷新' }),
  Object.freeze({ id: 'web', order: 4, label: '外网检索', host: true,
    rankBy: Object.freeze(['citation', 'credibility']),
    note: '宿主接入；按 citation×credibility 排序建议；回灌只许 append/annotate，不覆盖原文' })
]);
export const EPISTEMIC_STANCES = Object.freeze(['known', 'uncertain', 'confirmed-unknown']);

/** 宿主外网检索契约（不实现搜索）。rankBy 含 credibility，与 TIER_WEIGHT 对齐。 */
export function webSearchRequest(query, opts = {}) {
  return {
    interface: 'akasha.hostWebSearch',
    version: 1,
    query: String(query ?? ''),
    rankBy: ['citation', 'credibility'],
    credibilityWeights: { T1: TIER_WEIGHT.T1, T2: TIER_WEIGHT.T2, T3: TIER_WEIGHT.T3, T4: TIER_WEIGHT.T4, T5: TIER_WEIGHT.T5 },
    accept: '结果以新条目或注释 append；不得改写已有原文。',
    note: 'core 只定义契约；由宿主实现检索并回灌。'
  };
}

/**
 * 认知态路由（纯函数）：known / uncertain / confirmed-unknown。
 * strongHits>0 → known；仅有可引用弱来源 → uncertain（须引 cites）；否则 confirmed-unknown（可带 search 契约）。
 */
export function knowledgeRoute({ query = '', strongHits = 0, cites = [], orphanOnly = false } = {}) {
  const cited = Array.isArray(cites) ? cites.slice(0, 8) : [];
  if (strongHits > 0) {
    return {
      stance: 'known', layer: 'library', layers: KNOWLEDGE_LAYERS, cites: [], search: null,
      note: '强命中可标「记得·库内」（命中行带可信度层级，如 T3；待复核只是展示）。弱命中、孤案（zeroWeight）、refute 不算证据。层级系数只影响排序。基石优先级 已实践 > 已复现 > 高引用 > 待验证。'
    };
  }
  if (cited.length > 0) {
    return {
      stance: 'uncertain', layer: 'library', layers: KNOWLEDGE_LAYERS, cites: cited, search: null,
      note: '「不确定」——仅有弱命中/疑似相关：须引用下列来源，不得写成确定；无据处保持不确定。'
    };
  }
  return {
    stance: 'confirmed-unknown', layer: 'library', layers: KNOWLEDGE_LAYERS, cites: [],
    search: webSearchRequest(query), next: ['web'],
    note: '「确定不知道」——本地大图馆无可用证据' + (orphanOnly ? '（仅有零权重孤案）' : '') + '。按协议标注来源态，不要编；宿主可按 search 契约接外网检索。'
  };
}


// —— A2 上下文预算分配（wave4 · DeepSeek-V4.1-Flash CSA2 stride S=2）——
// 误差驱动配额：救场→加额；长期空转→减额；近平衡小更新；恶化才刹车（D）。
// 相位稳健：**冗余放置**（关键段至少两份、不同偏移）+ nearest-fetch；客户端无法对齐 provider 压缩相位。
// alignTokenCount / padBlockToStride 仅保留为论文实验对照，**不是**生产修复。
// 只分配注入额度，不改排序/存储。默认关。协议(usage)+自我(self)豁免敌对缩额。
export const CONTEXT_BUDGET_SOURCES = Object.freeze(['self', 'usage', 'kit', 'session', 'retrieval']);
export const CONTEXT_BUDGET_DEFAULTS = Object.freeze({
  enabled: false,  // 分配器（含相位实验属性）默认关＝10-10 裁定；「每次查阅的 token 上限」由其下 clipByBudget 默认承担（两者解耦，2026-10-11）
  stride: 2,                 // V4.1-Flash CSA2 压缩步长（相位周期）
  totalTokens: 2048,
  baseShare: Object.freeze({ self: 0.15, usage: 0.15, kit: 0.15, session: 0.25, retrieval: 0.30 }),
  kRescue: 0.15,
  kIdle: 0.12,
  kNear: 0.35,
  nearEps: 0.08,
  kD: 0.4,
  slopeThresh: 0.05,
  minShare: 0.05,
  maxShare: 0.50,
  rescueScale: 3,
  idleScale: 3,
  windowMs: 7 * 24 * 3600 * 1000,
  exemptShrink: Object.freeze(['self', 'usage']),
  /** 冗余放置：每条关键段复制份数（≥2）；偏移 token 数取奇数以翻转 residue */
  redundancyCopies: 2,
  redundancyOffsetTokens: 1
});

/** 查阅出口的装载预算裁剪（A2 接线，2026-10-11 用户令「开」）。
 *  目的：让「每次查阅的 token 上限」在生产路径真正生效（此前只有 CLI 视图、无调用方）。
 *  与分配器解耦：本裁剪**默认生效**（装载纪律），而 A2 自适应分配器（相位实验属性）**默认关**。
 *  口径：额度 = allocateContextBudget(...).shares × totalTokens；
 *        store→预算源映射：session → session；kit → kit；其余五库/文献 → retrieval；
 *        self/usage 为豁免源（exemptShrink），不参与此处裁剪。
 *  行为：按 rank 顺序累计 estimateTokens，超额即裁；被裁条数写入 result.budget.trimmed（可见、可观测）。
 *  关闭：opts.contextBudget === false。 */
function boundedPageLimits(opts, fallback) {
  const requested = Number.isInteger(opts.perStore) && opts.perStore > 0 ? opts.perStore : fallback;
  return { perStore: Math.min(requested, READ_TIER.boundedPerStore), total: READ_TIER.boundedTotal };
}

// 稳定轮转六库的组内排序，offset 指向这条完整序列；遇页额度即停，绝不跳过留待下页的候选。
function groupedPageWindow(groups, offset, limits) {
  const arrays = groups.map(g => g.items || g.hits || []);
  const all = [], stores = new Map();
  const longest = arrays.reduce((n, a) => Math.max(n, a.length), 0);
  for (let i = 0; i < longest; i += 1) for (let gi = 0; gi < arrays.length; gi += 1) {
    if (i < arrays[gi].length) { const item = arrays[gi][i]; all.push(item); stores.set(item, groups[gi].store); }
  }
  const remaining = all.slice(Math.min(offset, all.length)), window = [], counts = new Map();
  for (const item of remaining) {
    const store = stores.get(item), count = counts.get(store) || 0;
    if (window.length >= limits.total || count >= limits.perStore) break;
    window.push(item); counts.set(store, count + 1);
  }
  return { all, remaining, window };
}

export function clipByBudget(result, opts = {}) {
  const pageLimits = opts.pageLimits;
  if (opts.contextBudget === false && !pageLimits) return result;
  const countOnly = opts.contextBudget === false;
  // 每次查阅的总量上限：**天花板的性质**（防跑飞），不是日常配额 —— 默认 4096 tok；
  // 依据：实测 lookup(「记忆」)=1442 tok、cross(「记忆」)=2544 tok 都在其下（不会被裁）；
  //       取 2048 时 cross 对位视图会被砍到 4/95 条，违背其「主行不截断」契约。
  const DEFAULT_CALL_CAP = 4096;
  const cap = countOnly ? Infinity : Math.max(200, Math.floor(opts.maxTokens ?? DEFAULT_CALL_CAP));
  // F08（2026-10-14 外部审查 · GPT）：**账实相符**——预算必须覆盖**整条**（全部字段与元数据），而不是只估主文本一个字段。
  //   旧口径漏计：mirror 五字段（0/4096）、lookup report 元数据（2060 vs 实际 6213）。现口径＝整条 JSON 过同一
  //   estimateTokens（与复现脚本「同一算法复算」同口径）。结构符与 budget 自身不计（量级 = 个位数 tok）。
  const usedOf = (item) => estimateTokens(JSON.stringify(item ?? {}));
  let used = 0, trimmed = 0, oversize = 0, floorApplied = false, floorDone = false;
  /** 通用：按 rank 顺序装入；单条超预算**只跳自己**（后面更短的照收）；全超时**地板保底给第一条**（防「空结果 ≈ 库里没有」）。
   *  F08：`reserve` = 外围（query+hint+结构）预留——装载时就把外围算进去，保证 used ≤ cap（账实优先）。 */
  const trim = (list, reserve = 0) => {
    const kept = [];
    let lastKeptIdx = 0;                                      // F08：最后装下条目在输入序中的下标+1（供 nextOffset 原始序号口径）
    for (let i = 0; i < list.length; i += 1) {
      const it = list[i];
      const t = usedOf(it);
      if (used + t + reserve > cap) {
        if (t > cap - reserve) { oversize++; trimmed++; continue; }   // 单条连整页都放不下（除保底）⇒ 跳过不卡页（分页也永远取不到它，--full 可取）
        break;   // 装得下但本页剩余不足 ⇒ **停**（留到续取页）——原先 continue 会让后续页的游标越过它 ⇒ 永久丢失（GPT 复核 R7：A、C 出、B 消失）
      }
      used += t; kept.push(it); lastKeptIdx = i + 1;
    }
    // F08：地板**只给全局第一条**（多组时后面的组不得各自保底——否则每组各留一条，预算被打穿、账不再实）。
    // R08（GPT 复核二轮）：**严格上限**——超大条目以**短占位**保底（存在但未展开；全文走 show/--full），
    //   不再以「首条全文」突破 cap（旧行为 brief 8328/4096、cross 1114/200 均可穿透）。摘要长度随 cap 收缩。
    if (kept.length === 0 && list.length > 0 && used === 0 && !floorDone) {
      const first = list[0];
      // N12（GPT 第三轮）：**固定白名单**（不再黑名单补漏——orphan.summary / lexicon.resolution / mirror.story /
      //   source.ref 都曾因漏列而完整保留）——只留身份与短元数据 + 来源态 type；正文一律只进 snippet 摘要。
      const KEEP = new Set(['id', 'store', 'kind', 'status', 'score', 'strong', 'zeroWeight', 'rank', 'factor', 'severity', 'complexity', 'factorApplied', 'balance', 'tier', 'displayTier', 'stale', 'refuted', 'time', 'agePrefix', 'valence', 'severity_default', 'count', 'miss', 'weight']);
      const ph = {};
      for (const k of Object.keys(first)) if (KEEP.has(k)) ph[k] = first[k];
      if (first.source && typeof first.source === 'object') ph.source = { type: first.source.type };
      const BODY_KEYS = ['snippet', 'gist', 'claim', 'line', 'title', 'summary', 'situation', 'story', 'behavior', 'outcome', 'social_reaction', 'emotion', 'resolution', 'word', 'term', 'label', 'topic'];
      let bodyText = '';
      for (const k of BODY_KEYS) { if (typeof first[k] === 'string' && first[k]) { bodyText = first[k]; break; } }
      const capChars = Math.max(60, Math.min(300, cap - reserve - 80));
      ph.snippet = bodyText.slice(0, capChars);
      ph.oversizeOmitted = true;
      ph.fullHint = '单条超预算：此处为前 ' + capChars + ' 字摘要；全文用 show ' + String(first.id ?? '') + ' / --full';
      kept.push(ph);
      used += usedOf(ph);
      floorApplied = true; floorDone = true; oversize++;
      trimmed = Math.max(0, list.length - 1);        // 占位算留下
      lastKeptIdx = Math.max(lastKeptIdx, 1);
    }
    return { kept, lastIndex: lastKeptIdx };
  };
  const out = { ...result };
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const page = pageLimits && Array.isArray(out.groups) ? groupedPageWindow(out.groups, offset, pageLimits) : null;
  if (page && Array.isArray(out.citeAllowlist)) {
    const visibleIds = new Set(page.window.map(item => item.id));
    out.citeAllowlist = out.citeAllowlist.filter(item => visibleIds.has(item.id));
  }
  // F08-r3（GPT 复核二轮 R09 · 她 token 脚本复跑揭出）：预留改为**真实元数据口径**——report/trace/citeAllowlist/
  //   stats 等顶层内容此前进不了装填判定（lookup report 20 条小条目全装后整响应 5414>4096）。先把「除条目本体
  //   与 budget 外的一切」序列化估一遍作为 reserve；条目裁剪据此收缩。极小 cap 低于元数据体量时，overCap 如实标注。
  const stripItems = { ...out }; delete stripItems.hits; delete stripItems.groups; delete stripItems.budget;
  const metaTok = estimateTokens(JSON.stringify(stripItems));
  const reserve = metaTok + 20;
  if (Array.isArray(out.hits)) {
    const all = out.hits;
    if (offset > 0) out.hits = all.slice(offset);          // ② 分页：先跳过后裁剪（排序稳定）
    out.__afterOffset = out.hits.length;                    // 供区分「offset 跳过」与「上限裁掉」
    const t1 = trim(out.hits, reserve);
    out.hits = t1.kept;
    out.__nextRaw = offset + t1.lastIndex;                  // F08：nextOffset=原始序号口径（已翻过的条目数）
    out.budget = null;                                      // 占位，下面统一写
    out.__total = all.length;
  }
  if (Array.isArray(out.groups)) {
    // brief 用 groups[].hits，cross 用 groups[].items ⇒ 两者都处理（2026-10-11）
    // F08（2026-10-14 外部审查 · GPT）：**全局序**处理 offset 与预算（按组序 × 组内序展平）——
    //   原实现逐组独立 slice/trim ⇒ offset 对 groups 完全失效（复现实测：页 2 与页 1 重复、拼不齐全集）。
    const flat = page ? page.all : out.groups.flatMap(g => g.items || g.hits || []);
    const sliced = page ? page.window : flat.slice(Math.min(offset, flat.length));
    const t1 = trim(sliced, reserve);
    const kept = new Set(t1.kept);
    out.__nextRaw = offset + t1.lastIndex;                  // F08：原始序号口径（同 hits 分支）
    // R08 补（GPT 复核二轮 · 她 core 脚本复跑揭出）：**floor 占位在 groups 分支必须回位**——否则重组时
    //   占位不在原列表 ⇒ 被 filter 丢掉（用例：单条超大 brief ⇒ itemsAfter=0，用户看不到「存在但未展开」）。
    if (t1.kept.length && t1.kept[0] !== sliced[0] && t1.kept[0].oversizeOmitted === true && sliced.length) {
      const gi = out.groups.findIndex((g) => (Array.isArray(g.hits) ? g.hits : (g.items || [])).includes(sliced[0]));
      if (gi >= 0) {
        const g = out.groups[gi];
        const src = [...(Array.isArray(g.hits) ? g.hits : (g.items || []))];
        src[src.indexOf(sliced[0])] = t1.kept[0];
        out.groups[gi] = Array.isArray(g.hits) ? { ...g, hits: src } : { ...g, items: src };
      }
    }
    out.groups = out.groups.map((g) => {
      const own = (Array.isArray(g.hits) ? g.hits : (g.items || [])).filter((it) => kept.has(it));
      return Array.isArray(g.hits) ? { ...g, hits: own } : { ...g, items: own };
    });
    out.__afterOffset = page ? page.remaining.length : sliced.length; // 未进入本页的候选仍属于剩余集合
    out.__total = flat.length;
  }
  const before = (Array.isArray(result.hits) ? result.hits.length : 0)
    + (Array.isArray(result.groups) ? result.groups.reduce((n, g) => n + (g.items || g.hits || []).length, 0) : 0);
  const after = (Array.isArray(out.hits) ? out.hits.length : 0)
    + (Array.isArray(out.groups) ? out.groups.reduce((n, g) => n + (g.items || g.hits || []).length, 0) : 0);
  const total = out.__total ?? before;
  const afterOffset = out.__afterOffset ?? before;
  delete out.__total; delete out.__afterOffset;
  const trimmedOut = Math.max(0, afterOffset - after);      // 仅「被上限裁掉」的条数（不含 offset 跳过）
  const skippedByOffset = Math.min(offset, total);
  // F08：nextOffset 用**原始序号口径**——「已翻过的条目数（含被跳过的）」；此前用 offset+已装条数，
  //   在「大条目自跳」列表上会原地打转（页 2 重走同一批被跳条、装出与页 1 相同的两条 —— 复现实测）。
  const nextOffset = Math.min(total, out.__nextRaw ?? (offset + after));
  delete out.__nextRaw;
  // ③ 可见性：每次返回都带一行人类可读的装载说明（不再有静默截断）
  const parts = ['本页 ' + after + ' 条 / 共 ' + total + ' 条', countOnly ? '按条数分页（未启用 token 上限）' : used + '/' + cap + ' tok'];
  if (skippedByOffset > 0) parts.push('已跳过前 ' + skippedByOffset + ' 条(offset)');
  if (floorApplied) parts.push('地板保底：首条超大条目**仅示摘要**（oversizeOmitted=true；全文走 show/--full）（另 ' + Math.max(0, trimmedOut - 1) + ' 条未显示）→ 续取 offset=' + nextOffset + '（或 --full）');
  else if (trimmedOut > 0) parts.push('因上限未显示 ' + trimmedOut + ' 条 → 续取 offset=' + nextOffset + '（或 --full）');
  else parts.push('无因上限丢弃');
  const hint = parts.join(' · ');
  // F08-r2（GPT 复核 R8）：**账实对齐整响应**——写 budget 前，以「除 budget 自身外整响应」序列化为准（一次 stringify）。
  //   此前只累计「条目 + query/hint」：外层 stats/report/其余字段未计 ⇒ 大报告场景偏差 ~850 tok（她复算 9178 vs 账面 8328）。
  {
    const probe = { ...out };
    delete probe.budget;
    used = estimateTokens(JSON.stringify(probe));
  }
  // R09-r3 复检补：**hint 说真话**——元数据使总账超限时如实追加（否则「155/200」看起来没超，与 overCap:true 打架）。
  // ③（GPT 第四轮·token 开刀）：**最小包标记**——cap 连元数据都装不下时如实标注（不塞完整诊断、不假装成功）。
  const budgetTooSmall = metaTok > cap - 60;
  const hintOut = budgetTooSmall
    ? hint + ' · ⚠ 预算 ' + cap + ' < 元数据 ' + metaTok + ' tok：连最小包都装不下——请加大 maxTokens（budgetTooSmall）'
    : (used > cap ? hint + ' · ⚠ 元数据 ' + metaTok + ' tok 使总账 ' + used + '/' + cap + ' 超限（条目已按剩余额度收缩；不复读假绿）' : hint);
  out.budget = { mode: countOnly ? 'per-page-count' : 'per-call-cap', capTokens: countOnly ? null : cap, usedTokens: used, offset, skippedByOffset, total, itemsBefore: before, itemsAfter: after, trimmed: trimmedOut, truncated: trimmedOut, oversize, floorApplied, nextOffset, exhausted: trimmedOut === 0 || nextOffset >= total, hint: hintOut, metaTokens: metaTok, overCap: used > cap, budgetTooSmall,
    ...(pageLimits ? { perStoreLimit: pageLimits.perStore, totalLimit: pageLimits.total, cursorOrder: 'store-round-robin' } : {}) };
  return out;
}

export function contextBudgetEnabled(opts = {}) {
  return opts.contextBudget === true || CONTEXT_BUDGET_DEFAULTS.enabled === true;
}

/** 轻量 token 估计（无分词器）：CJK=1；其余 ceil(n/4)。宿主可用真分词器替换。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let cjk = 0, other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * 【实验对照 · 非生产修复】上取整到 stride 倍数。
 * 论文用 padding 做控制变量；客户端看不到 / 设不了 provider 压缩相位边界，故不能当修复手段。
 */
export function alignTokenCount(n, stride = CONTEXT_BUDGET_DEFAULTS.stride) {
  const x = Math.max(0, Math.floor(Number(n) || 0));
  const s = Math.max(1, Math.floor(Number(stride) || 1));
  if (s <= 1) return x;
  const rem = x % s;
  return rem === 0 ? x : x + (s - rem);
}

/**
 * 【实验对照 · 非生产修复】截断后空格垫到 stride 对齐。同 alignTokenCount 口径。
 */
export function padBlockToStride(text, tokenBudget, opts = {}) {
  const stride = Math.max(1, Math.floor(opts.stride ?? CONTEXT_BUDGET_DEFAULTS.stride));
  const budget = Math.max(0, Math.floor(Number(tokenBudget) || 0));
  let body = String(text ?? '');
  while (body && estimateTokens(body) > budget) {
    if (/[\u4e00-\u9fff]$/.test(body)) body = body.slice(0, -1);
    else body = body.replace(/\s+\S*$/, '') || body.slice(0, Math.max(0, body.length - 4));
    if (body.length === 0) break;
  }
  let tokens = estimateTokens(body);
  let padUnits = 0;
  const target = Math.min(budget, alignTokenCount(tokens, stride));
  while (tokens < target && padUnits < stride * 4) {
    body += ' ';
    padUnits += 1;
    tokens = estimateTokens(body);
  }
  return {
    text: body, tokens, budget, padded: padUnits > 0, padUnits, stride,
    method: 'experimental-control-pad',
    note: '非生产修复：客户端无法对齐 provider 压缩相位'
  };
}

/**
 * nearest-fetch：按距离升序（再按 priority 降序）排列候选，缩短关键段到查询的暴露距离。
 * segments: [{ id, text, distance?, priority? }]
 */
export function nearestFetch(segments, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : (segments || []).length;
  const ranked = [...(segments || [])].map((seg, i) => ({
    id: seg.id ?? ('seg-' + i),
    text: String(seg.text ?? ''),
    distance: Number.isFinite(seg.distance) ? seg.distance : i,
    priority: Number.isFinite(seg.priority) ? seg.priority : 0
  }));
  ranked.sort((a, b) => a.distance - b.distance || b.priority - a.priority || String(a.id).localeCompare(String(b.id)));
  return ranked.slice(0, limit);
}

/**
 * 冗余放置（生产主策略）：关键段至少 copies 份，中间插入奇数 token 偏移以翻转 residue，
 * 使至少一份落在较好相位。先 nearest-fetch 再复制。
 * 返回 { text, placements, stride, method, copies, offsetTokens }。
 */
export function placeWithRedundancy(segments, opts = {}) {
  const stride = Math.max(1, Math.floor(opts.stride ?? CONTEXT_BUDGET_DEFAULTS.stride));
  const copies = Math.max(2, Math.floor(opts.copies ?? CONTEXT_BUDGET_DEFAULTS.redundancyCopies));
  let offsetTokens = Math.floor(opts.offsetTokens ?? CONTEXT_BUDGET_DEFAULTS.redundancyOffsetTokens);
  if (offsetTokens % stride === 0) offsetTokens += 1; // 保证非 stride 倍数 → 翻转 residue
  const ordered = nearestFetch(segments, opts);
  const parts = [];
  const placements = [];
  let cursor = 0;
  for (const seg of ordered) {
    const tok = estimateTokens(seg.text);
    for (let c = 0; c < copies; c++) {
      if (c > 0) {
        // 使下一份起始 residue 翻转：需要 (tok + F) % stride !== 0
        let f = Math.max(1, offsetTokens);
        while ((tok + f) % stride === 0) f += 1;
        // 用 CJK「垫」凑精确 token 数（ASCII 填充会被 ceil(n/4) 压缩）
        let filler = '';
        while (estimateTokens(filler) < f) filler += '垫';
        parts.push(filler);
        cursor += estimateTokens(filler);
      }
      const startTok = cursor;
      const residue = startTok % stride;
      parts.push(seg.text);
      placements.push({
        id: seg.id, copy: c, startTokens: startTok, tokens: tok,
        residue, distance: seg.distance, priority: seg.priority
      });
      cursor += tok;
    }
  }
  return {
    text: parts.join(''),
    placements,
    stride,
    copies,
    offsetTokens,
    method: 'redundancy+nearest-fetch',
    note: '关键段多份不同偏移；客户端不试图对齐 provider 相位'
  };
}

/**
 * 验收：按 stride 做奇偶 residue 采样 + 多长度前缀扰动（预算变化会改相位）。
 * 主指标 = best−worst gap（非仅平均）。samples 全保留。
 * opts.scoreFn({ residue, prefixTokens, prefix, memory }) 可注入真评测；缺省用论文形态代理（偶>~奇）。
 */
export function phaseResidueSample(memoryText, opts = {}) {
  const stride = Math.max(1, Math.floor(opts.stride ?? CONTEXT_BUDGET_DEFAULTS.stride));
  const mem = String(memoryText ?? '');
  // 多长度前缀：模拟 A2 配额微调导致的相位漂移（必须覆盖奇偶 residue）
  const prefixes = opts.prefixes || [
    '', 'a', 'ab', 'abc', 'word', 'words!', '词', '词条', '词条A',
    'prefix-07', 'prefix-0077', '较长前缀xyz', 'budg1', 'budget-chg-17'
  ];
  const scoreFn = typeof opts.scoreFn === 'function'
    ? opts.scoreFn
    : ({ residue }) => (residue % 2 === 0 ? 0.95 : 0.895); // 对齐 Flash 表偶~95 / 奇~89.5 形态
  const samples = [];
  for (const pre of prefixes) {
    const prefixTokens = estimateTokens(pre);
    const residue = prefixTokens % stride;
    const score = Number(scoreFn({ residue, prefixTokens, prefix: pre, memory: mem }));
    samples.push({
      prefixLen: pre.length,
      prefixTokens,
      residue,
      score: +score.toFixed(6)
    });
  }
  const scores = samples.map((x) => x.score);
  const best = Math.max(...scores);
  const worst = Math.min(...scores);
  const gap = +(best - worst).toFixed(6);
  const byResidue = {};
  for (let r = 0; r < stride; r++) byResidue[r] = [];
  for (const x of samples) byResidue[x.residue].push(x.score);
  const residueMeans = {};
  for (let r = 0; r < stride; r++) {
    const arr = byResidue[r];
    residueMeans[r] = arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(6) : null;
  }
  const meanVals = Object.values(residueMeans).filter((v) => v != null);
  const residueGap = meanVals.length >= 2
    ? +(Math.max(...meanVals) - Math.min(...meanVals)).toFixed(6)
    : 0;
  return {
    stride,
    method: 'residue-sample+prefix-perturbation',
    samples,                 // 全样本，非平均掉
    best, worst, gap,        // 主验收：best−worst
    byResidue,
    residueMeans,
    residueGap,              // 辅：residue 组间均差（对照论文 Δres）
    note: '客户端无法对齐 provider 压缩相位；主指标 gap=best−worst，须报告而非只报平均'
  };
}

/** @deprecated 名称保留：转调 phaseResidueSample（冗余策略下不再追求「对齐后相位恒 0」）。 */
export function phaseStabilityCheck(memoryText, opts = {}) {
  const r = phaseResidueSample(memoryText, opts);
  return {
    ...r,
    stable: r.gap < (opts.maxGap ?? 1), // 宽松兼容旧断言；新测试查 gap/samples
    method: 'deprecated-alias→phaseResidueSample'
  };
}

/**
 * 从 hooks 记录提取各来源救场/空转信号（纯函数可测）。
 * 认 kind:"budget-rescue"| "budget-idle"（须带 source∈SOURCES）；
 * 亦认 gate-self-* → self、gate-usage-* → usage、召回工具 → retrieval、kit、session-*。
 */
export function budgetSignalsFromRecords(records, opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : CONTEXT_BUDGET_DEFAULTS.windowMs;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const start = nowMs - windowMs;
  const mid = start + windowMs / 2;
  const blank = () => ({ rescues: 0, idle: 0, rescuesOld: 0, idleOld: 0, rescuesNew: 0, idleNew: 0 });
  const by = Object.fromEntries(CONTEXT_BUDGET_SOURCES.map((s) => [s, blank()]));
  const bump = (src, field, t) => {
    if (!by[src]) return;
    by[src][field] += 1;
    if (t < mid) by[src][field + 'Old'] += 1;
    else by[src][field + 'New'] += 1;
  };
  const mapKind = (kind) => {
    const k = String(kind || '');
    if (k.startsWith('gate-self')) return 'self';
    if (k.startsWith('gate-usage')) return 'usage';
    if (k === 'kit' || k.startsWith('kit-')) return 'kit';
    if (k.startsWith('session-')) return 'session';
    if (RECALL_TOOLS.includes(k) || RECALL_CLI.includes(k) || k.startsWith('akasha_')) return 'retrieval';
    return null;
  };
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== 'object') continue;
    const ts = rec.ts ? Date.parse(rec.ts) : NaN;
    const t = Number.isFinite(ts) ? ts : nowMs;
    if (t < start || t > nowMs) continue;
    const src = CONTEXT_BUDGET_SOURCES.includes(rec.source) ? rec.source : null;
    if (rec.kind === 'budget-rescue' && src) bump(src, 'rescues', t);
    else if (rec.kind === 'budget-idle' && src) bump(src, 'idle', t);
    else {
      const mapped = mapKind(rec.kind);
      if (mapped && (rec.ok === true || rec.rescue === true || rec.kind.startsWith('gate-self-recovered') || rec.kind.startsWith('gate-usage-recovered'))) {
        bump(mapped, 'rescues', t);
      } else if (mapped && (rec.ok === false || rec.idle === true || String(rec.kind).includes('fallback') || String(rec.kind).includes('skip'))) {
        bump(mapped, 'idle', t);
      }
    }
  }
  const out = {};
  for (const s of CONTEXT_BUDGET_SOURCES) {
    const b = by[s];
    const idleOldRate = b.idleOld / Math.max(1, b.idleOld + b.rescuesOld);
    const idleNewRate = b.idleNew / Math.max(1, b.idleNew + b.rescuesNew);
    out[s] = {
      rescues: b.rescues, idle: b.idle,
      idleSlope: +(idleNewRate - idleOldRate).toFixed(6)
    };
  }
  return { bySource: out, windowMs, missing: false };
}

/**
 * A2 分配（纯函数）：误差驱动 share → tokens（不再强制偶数对齐）。
 * 附带 redundancy 策略说明；padding 对齐降级为 experimentalControl。
 */
export function allocateContextBudget(opts = {}) {
  const p = { ...CONTEXT_BUDGET_DEFAULTS, ...(opts.params || {}) };
  const enabled = contextBudgetEnabled(opts);
  const stride = Math.max(1, Math.floor(p.stride));
  const totalTokens = Math.max(0, Math.floor(opts.totalTokens ?? p.totalTokens));
  let signals = opts.signals || opts.budgetSignals || null;
  if (!signals && opts.records) signals = budgetSignalsFromRecords(opts.records, { windowMs: p.windowMs, nowMs: opts.nowMs });
  if (!signals) signals = { bySource: Object.fromEntries(CONTEXT_BUDGET_SOURCES.map((s) => [s, { rescues: 0, idle: 0, idleSlope: 0 }])), missing: true, windowMs: p.windowMs };

  const rawShares = {};
  const details = {};
  for (const s of CONTEXT_BUDGET_SOURCES) {
    const base = p.baseShare[s] ?? (1 / CONTEXT_BUDGET_SOURCES.length);
    const sig = (signals.bySource && signals.bySource[s]) || { rescues: 0, idle: 0, idleSlope: 0 };
    const rescueNorm = Math.min(2, (sig.rescues || 0) / Math.max(1, p.rescueScale));
    const idleNorm = Math.min(2, (sig.idle || 0) / Math.max(1, p.idleScale));
    let rawDelta = p.kRescue * rescueNorm - p.kIdle * idleNorm;
    const reasons = [];
    if (Math.abs(rawDelta) < p.nearEps) {
      rawDelta *= p.kNear;
      reasons.push({ code: 'near-balance', rawDelta: +rawDelta.toFixed(4) });
    }
    const slope = Number(sig.idleSlope) || 0;
    if (slope > p.slopeThresh && idleNorm > 0 && rawDelta <= 0) {
      const brake = p.kD * ((slope - p.slopeThresh) / p.slopeThresh);
      rawDelta -= brake;
      reasons.push({ code: 'worsen-brake', slope, brake: +brake.toFixed(4) });
    }
    const exempt = (p.exemptShrink || []).includes(s);
    if (exempt && rawDelta < 0) {
      reasons.push({ code: s === 'self' ? 'self-layer-exempt' : 'protocol-exempt', blockedDelta: +rawDelta.toFixed(4) });
      rawDelta = 0;
    }
    if (rescueNorm > 0 && rawDelta > 0) reasons.push({ code: 'rescue-bump', rescueNorm: +rescueNorm.toFixed(4) });
    if (idleNorm > 0 && rawDelta < 0) reasons.push({ code: 'idle-shrink', idleNorm: +idleNorm.toFixed(4) });
    let share = base * (1 + rawDelta);
    share = Math.max(p.minShare, Math.min(p.maxShare, share));
    rawShares[s] = share;
    details[s] = { base, rawDelta: +rawDelta.toFixed(4), reasons, rescues: sig.rescues || 0, idle: sig.idle || 0, idleSlope: slope, exempt };
  }
  const sum = CONTEXT_BUDGET_SOURCES.reduce((a, s) => a + rawShares[s], 0) || 1;
  const sources = {};
  let allocated = 0;
  const ordered = CONTEXT_BUDGET_SOURCES.slice();
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    const share = rawShares[s] / sum;
    let tokens = Math.round(share * totalTokens);
    if (i === ordered.length - 1) tokens = Math.max(0, totalTokens - allocated); // 末项吃余数
    allocated += tokens;
    sources[s] = { share: +share.toFixed(4), tokens, ...details[s] };
  }
  return {
    enabled,
    stride,
    totalTokens,
    model: 'DeepSeek-V4.1-Flash',
    phase: {
      stride,
      method: 'redundancy+nearest-fetch',
      note: '客户端无法对齐 provider 压缩相位；关键段冗余双份+偏移。align/pad 仅实验对照。',
      acceptance: 'phaseResidueSample → 主指标 best−worst gap；多样本前缀扰动'
    },
    redundancy: {
      copies: p.redundancyCopies,
      offsetTokens: p.redundancyOffsetTokens,
      place: 'placeWithRedundancy'
    },
    experimentalControl: {
      alignTokenCount: true,
      padBlockToStride: true,
      note: '论文实验控制，非生产修复'
    },
    sources,
    signals: { missing: !!signals.missing, windowMs: signals.windowMs ?? p.windowMs },
    params: {
      kRescue: p.kRescue, kIdle: p.kIdle, kNear: p.kNear, nearEps: p.nearEps,
      kD: p.kD, slopeThresh: p.slopeThresh, exemptShrink: [...(p.exemptShrink || [])],
      redundancyCopies: p.redundancyCopies, redundancyOffsetTokens: p.redundancyOffsetTokens
    }
  };
}

/** 类别模板：由 credibilityOf.cls 选定。协议条强制 sev/cpx = 1（不让 arousal 抬协议）。 */
export const RANK_TEMPLATES = Object.freeze({
  protocol: Object.freeze({ severityScale: 0, complexityScale: 0, label: 'protocol' }),
  snapshot: Object.freeze({ severityScale: 1, complexityScale: 1, label: 'snapshot' }),
  frontier: Object.freeze({ severityScale: 1, complexityScale: 1, label: 'frontier' }),
  evergreen: Object.freeze({ severityScale: 1, complexityScale: 1, label: 'evergreen' })
});
const ORPHAN_SEV = Object.freeze({ '高': 1, '中': 0.75, '低': 0.5 });
const clamp01 = (n) => Math.max(0, Math.min(1, n));
/** arousal → [0.5, 1]：缺省不压到 0，避免「没写 arousal」被当成最不严重。 */
const arousalUnit = (a) => 0.5 + 0.5 * clamp01(a);

/**
 * 从已有字段读严重度 / 复杂度（纯函数；不写库）。
 * severity：orphan.severity → pricing.severity_default/5 → arousal 映射 → 1。
 * complexity：无独立字段。若严重度已来自显式 severity 且有 arousal，则 arousal 当复杂度代理；
 *            若严重度已来自 arousal，复杂度固定 1（避免同一信号乘两次）。否则 1。
 * valence 负价不进乘子（仍由 brief 行首 ⚠ / 小幅 tip 表达）；不改 strong。
 */
export function severityComplexityOf(store, r) {
  const rec = r && typeof r === 'object' ? r : {};
  let severity = 1;
  let severityFrom = 'default';
  if (store === 'orphan' && ORPHAN_SEV[rec.severity] != null) {
    severity = ORPHAN_SEV[rec.severity];
    severityFrom = 'severity';
  } else if (store === 'pricing' && Number.isInteger(rec.severity_default) && rec.severity_default >= 1 && rec.severity_default <= 5) {
    severity = rec.severity_default / 5;
    severityFrom = 'severity_default';
  } else if (typeof rec.arousal === 'number' && Number.isFinite(rec.arousal)) {
    severity = +arousalUnit(rec.arousal).toFixed(4);
    severityFrom = 'arousal';
  }
  let complexity = 1;
  let complexityFrom = 'default';
  if (severityFrom !== 'arousal' && typeof rec.arousal === 'number' && Number.isFinite(rec.arousal)) {
    complexity = +arousalUnit(rec.arousal).toFixed(4);
    complexityFrom = 'arousal';
  }
  return { severity, complexity, severityFrom, complexityFrom };
}

/**
 * 排序因子：factor = credibility × severity' × complexity'（模板缩放后）。
 * cred 缺省按 weight=1、cls=evergreen。refuted → factor 0。
 * A1 负载均衡不在这里乘——见 applyRank / loadBalanceCorrection（正交、可关）。
 */
export function rankFactors(store, r, cred = null, opts = {}) {
  const c = cred && typeof cred === 'object' ? cred : { weight: 1, cls: 'evergreen', refuted: false, tier: null };
  const tpl = RANK_TEMPLATES[c.cls] || RANK_TEMPLATES.evergreen;
  const sc = severityComplexityOf(store, r);
  const severity = tpl.severityScale === 0 ? 1 : +(1 + (sc.severity - 1) * tpl.severityScale).toFixed(4);
  const complexity = tpl.complexityScale === 0 ? 1 : +(1 + (sc.complexity - 1) * tpl.complexityScale).toFixed(4);
  const credibility = c.refuted ? 0 : (typeof c.weight === 'number' ? c.weight : 1);
  const factor = +(credibility * severity * complexity).toFixed(6);
  return {
    credibility, severity, complexity, factor,
    severityFrom: sc.severityFrom, complexityFrom: sc.complexityFrom,
    template: tpl.label, tier: c.tier ?? null, cls: c.cls ?? null
  };
}

const hhiOf = (counts) => {
  const vals = [...counts.values()].filter((n) => n > 0);
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  return vals.reduce((s, n) => s + (n / total) ** 2, 0);
};
/** 该 distinct 下 HHI 位移的**可达上限**（2026-10-13）：固定总数 N、n 个类别时，
 *  HHI 上限 = 1（全挤在一类）；下限 = 1/n（均匀）。真实位移永远 ≤ 这个量级 ⇒ 用来给 slope 做**尺度归一**。 */
const hhiMaxShiftOf = (distinct) => (distinct >= 2 ? 1 - 1 / distinct : 1);
// ── 似然比 G 检验（两半窗同构性；2026-10-13）──
// H0：两个半窗的类别分布相同（同构）。对每个类别按行边际做 2 格检验，逐类相加得总 G，df = 参与类别数 − 1。
// 为什么用它替代固定阈值：① 它是**尺度无关**的（随样本量自动收紧）；② 类别稀疏时对 0 计数稳健（0 项不贡献）；
// ③ 只判「有没有真结构变化」，方向交给 slope 的符号 ⇒ 「改善不抖」的原有承诺不受影响。
const lgammaOf = (z) => {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = z; let y = z; let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) ser += g[j] / (y += 1);
  return -tmp + Math.log(2.5066282746310005 * ser / x);
};
/** 卡方尾概率 P(X² > x²; df)（正则化不完全伽马；两段法，精度 ~1e-12）。 */
export function chi2UpperTail(x2, df) {
  const a = df / 2; const x = x2 / 2;
  if (!(x2 > 0) || !(df > 0)) return 1;
  const gln = lgammaOf(a);
  if (x < a + 1) {
    let ap = a; let sum = 1 / a; let del = sum;
    for (let n = 1; n <= 200; n += 1) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-12) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a; let c = 1e308; let d = 1 / b; let h = d;
  for (let i = 1; i <= 200; i += 1) {
    const an = -i * (i - a);
    b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del2 = d * c; h *= del2;
    if (Math.abs(del2 - 1) < 1e-12) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}
/** 两半窗同构性 G 检验 → { G, df, p }。0 计数不贡献；参与类别数 <2 ⇒ 无法判（df=1, p=1）。 */
export function homogeneityG(oldCounts, newCounts) {
  let nA = 0; let nB = 0;
  for (const v of oldCounts.values()) nA += v;
  for (const v of newCounts.values()) nB += v;
  if (!nA || !nB) return { G: 0, df: 1, p: 1 };
  const ids = new Set([...oldCounts.keys(), ...newCounts.keys()]);
  let G = 0; let rows = 0;
  for (const id of ids) {
    const a = oldCounts.get(id) ?? 0; const b = newCounts.get(id) ?? 0;
    const r = a + b;
    const ea = r * nA / (nA + nB); const eb = r * nB / (nA + nB);
    if (!(ea > 0) || !(eb > 0)) continue;
    if (a > 0) G += 2 * a * Math.log(a / ea);
    if (b > 0) G += 2 * b * Math.log(b / eb);
    rows += 1;
  }
  const df = Math.max(1, rows - 1);
  return { G, df, p: chi2UpperTail(G, df) };
}

/**
 * 修订链根 id：剥掉尾部 `-rN`（N 为正整数）。usage 日志与当前版 id 混用时，两侧都归一到根再计数/查表。
 * 例：`canon-foo-r3` → `canon-foo`；无后缀原样返回。
 */
export function rootIdOf(id) {
  const s = String(id ?? '');
  const m = /^(.*)-r(\d+)$/.exec(s);
  return m ? m[1] : s;
}

/** 自我层（gate akasha:self 永久注入）：id 前缀或 tag『自我』。与协议条同属常驻提示。 */
export function isSelfLayerRecord(r) {
  if (!r || typeof r !== 'object') return false;
  const id = rootIdOf(r.id);
  if (/^canon-(self-concept|address-layers|memory-auto-record)/.test(id)) return true;
  return Array.isArray(r.tags) && r.tags.includes('自我');
}

/**
 * A1 豁免：协议类 ∪ 自我层。返回 { exempt, code }；非豁免 code=null。
 * 协议：cls==="protocol"，或根 id 为 canon-akasha-usage（与 isProtocolId 同口径）。
 * 自我层：record/tags/id 前缀 self-concept|address-layers|memory-auto-record。
 */
export function isLoadBalanceExempt(opts = {}) {
  const cls = opts.cls || null;
  const id = opts.id != null ? String(opts.id) : (opts.record && opts.record.id != null ? String(opts.record.id) : '');
  const root = id ? rootIdOf(id) : '';
  if (cls === 'protocol' || root === 'canon-akasha-usage') {
    return { exempt: true, code: 'protocol-exempt' };
  }
  if (opts.selfLayer === true || isSelfLayerRecord(opts.record) ||
      /^canon-(self-concept|address-layers|memory-auto-record)/.test(root)) {
    return { exempt: true, code: 'self-layer-exempt' };
  }
  return { exempt: false, code: null };
}

/**
 * 从 hooks 记录建用量窗口（纯函数可测）。
 * 只统计 kind:"usage" 的 ids（与 metrics 同源）。opts.windowMs / nowMs。
 * 返回 { byId, total, distinct, quota, hhi, hhiOld, hhiNew, slope, windowMs, missing }。
 */
export function usageWindowFromRecords(records, opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : LOAD_BALANCE_DEFAULTS.windowMs;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const start = nowMs - windowMs;
  const mid = start + windowMs / 2;
  const byId = new Map();
  const old = new Map();
  const neu = new Map();
  let total = 0;
  for (const rec of records ?? []) {
    if (!rec || rec.kind !== 'usage' || !Array.isArray(rec.ids)) continue;
    const ts = rec.ts ? Date.parse(rec.ts) : NaN;
    const t = Number.isFinite(ts) ? ts : nowMs; // 无戳 → 算进窗口（宽口径，不夸大饿死）
    if (t < start || t > nowMs) continue;
    for (const raw of rec.ids) {
      const id = rootIdOf(raw);
      if (!id) continue;
      byId.set(id, (byId.get(id) ?? 0) + 1);
      total += 1;
      if (t < mid) old.set(id, (old.get(id) ?? 0) + 1);
      else neu.set(id, (neu.get(id) ?? 0) + 1);
    }
  }
  const distinct = byId.size;
  const quota = total / Math.max(1, distinct);
  const hhiOld = hhiOf(old);
  const hhiNew = hhiOf(neu);
  const hhiMaxShift = hhiMaxShiftOf(distinct);
  // ── 集中度变化的**显著性**（2026-10-13，算法数学批 B②）──
  // 为什么不能只看 |slope|：HHI 是 1/n 量级的量，位移上限随 distinct 收缩（n=204 时"全部重复集中在一条"也只到 0.02），
  //   而小样本又能轻松越过固定阈值（实测滑移扫描：最大 |slope|=0.222 出现在 total=6 的噪声样本）
  //   ⇒ 固定阈值 slopeThresh=0.05 小样本被噪声越过、大样本不可达。
  // 现算两件事：① 真实位移相对**该总体可达上限**的比例（自动随 distinct 缩放）；
  //   ② 两半窗同构性的似然比 G 检验 p 值（df = 参与类别数−1）——只有**显著**且**方向为恶化**才该刹车。
  const shifted = hhiNew - hhiOld;
  const relShift = Number.isFinite(hhiMaxShift) && hhiMaxShift > 0 ? +(shifted / hhiMaxShift).toFixed(6) : 0;
  const gh = homogeneityG(old, neu);
  return {
    byId, total, distinct, quota: +quota.toFixed(4),
    hhi: +hhiOf(byId).toFixed(6),
    hhiOld: +hhiOld.toFixed(6), hhiNew: +hhiNew.toFixed(6),
    slope: +(hhiNew - hhiOld).toFixed(6),
    hhiMaxShift: +hhiMaxShift.toFixed(6),   // 该 distinct 下 HHI 位移的可达上限
    relShift,                                // = slope / hhiMaxShift（缩放后的口径）
    // 两半窗同构性：G 统计量 / 自由度 / 卡方尾概率（p 小 ⇒ 结构真的变了）
    homogG: +gh.G.toFixed(4), homogDf: gh.df, homogP: gh.p,
    significant: Number.isFinite(gh.p) ? gh.p < 0.05 : false,
    windowMs, missing: false
  };
}

/** 读 hooks 日志建窗口；文件缺失 → missing:true、空窗口（不假装有引用）。
 *  2026-10-13 审计 P6：改**尾部窗口读**（此前整文件读+解析；2.66MB/27k 行时 18.8ms，且随日志线性涨）。
 *  窗口＝`windowMs`（缺省 7 天）：只取窗口内的记录即可产出同一窗口产物；无 ts 的行照样计入（与整读同）。
 *  `full: true` 可回退整读（对照/诊断用，也是本函数单测的反例钩子）。 */
export function usageWindowFromLog(logPath, opts = {}) {
  const file = logPath || join(LOGS_DIR, 'hooks.jsonl');
  if (!existsSync(file)) {
    return { byId: new Map(), total: 0, distinct: 0, quota: 0, hhi: 0, hhiOld: 0, hhiNew: 0, slope: 0, windowMs: opts.windowMs ?? LOAD_BALANCE_DEFAULTS.windowMs, missing: true };
  }
  const windowMs = opts.windowMs ?? LOAD_BALANCE_DEFAULTS.windowMs;
  // 尾读上限：line=60000 / byte=32MB 是**安全垫**（当前 27k 行/2.7MB ⇒ 窗口内全取；
  // 日志到 60k 行仍不丢窗口内记录）。真正决定「读多少」的是调用方给的 windowMs——
  // 窗口过滤仍在 usageWindowFromRecords 里（不在这里重复），本函数只负责「别把整份历史都读进来」。
  const records = opts.full
    ? parseJsonl(readFileSync(file, 'utf8')).records
    : readJsonlLinesReverse(file, { lines: Math.max(60000, Number(opts.maxLines) || 0), maxBytes: Number(opts.maxBytes) || 32 * 1024 * 1024 });
  return usageWindowFromRecords(records, opts);
}

/** 解析本轮要用的用量窗口（可注入 usageWindow / usage Map / balanceLog）。 */
export function resolveUsageWindow(opts = {}) {
  if (opts.usageWindow && typeof opts.usageWindow === 'object') return opts.usageWindow;
  if (opts.usage instanceof Map) {
    const byId = new Map();
    for (const [k, v] of opts.usage) {
      const id = rootIdOf(k);
      if (!id) continue;
      byId.set(id, (byId.get(id) ?? 0) + (Number(v) || 0));
    }
    let total = 0; for (const n of byId.values()) total += n;
    const distinct = [...byId.values()].filter((n) => n > 0).length;
    return {
      byId, total, distinct, quota: total / Math.max(1, distinct || 1),
      hhi: +hhiOf(byId).toFixed(6), hhiOld: 0, hhiNew: +hhiOf(byId).toFixed(6), slope: 0,
      windowMs: opts.windowMs ?? LOAD_BALANCE_DEFAULTS.windowMs, missing: false
    };
  }
  return usageWindowFromLog(opts.balanceLog || opts.log, opts);
}

/**
 * A1 校正（纯函数）：correction 乘在已有 rank 上。
 * - 超软配额（count > quota）→ 降（防垄断，P）
 * - 窗口内零引用且本命中为弱命中 → 探索加成（防饿死）
 * - 集中度斜率上升超阈 → 对超配额项再刹车（D；改善时不抖）
 * 不隐藏、不删条；与 credibility/pricing 正交。
 * 协议类 ∪ 自我层豁免：correction 恒 1，reasons 含 protocol-exempt / self-layer-exempt。
 * 计数两侧均按 rootIdOf 归一（剥 -rN），修订版仍累积用量。
 */
export function loadBalanceCorrection(id, opts = {}) {
  const p = { ...LOAD_BALANCE_DEFAULTS, ...(opts.params || {}) };
  const win = opts.window || { byId: new Map(), total: 0, distinct: 0, quota: 0, slope: 0 };
  const root = rootIdOf(id);
  const count = Number(opts.count ?? win.byId?.get?.(root) ?? 0) || 0;
  const quota = Math.max(win.quota || 0, 0);
  const strong = opts.strong === true;
  const cls = opts.cls || null;
  // 协议 ∪ 自我层豁免：常驻提示条不参与垄断/探索/D（否则每会话必引会被当成垄断）。
  const ex = isLoadBalanceExempt({ cls, id, record: opts.record, selfLayer: opts.selfLayer });
  if (ex.exempt) {
    return {
      enabled: true,
      id: String(id ?? ''),
      root,
      correction: 1,
      count, quota: +quota.toFixed(4), error: +(count - quota).toFixed(4),
      slope: Number(win.slope) || 0,
      reasons: [{ code: ex.code }],
      cls: cls || null,
      params: { kP: p.kP, kExplore: p.kExplore, kD: p.kD, slopeThresh: p.slopeThresh, windowMs: win.windowMs ?? p.windowMs }
    };
  }
  const reasons = [];
  let correction = 1;
  const error = count - quota;
  if (error > 0 && quota > 0) {
    const damp = 1 / (1 + p.kP * (error / quota));
    correction *= damp;
    reasons.push({ code: 'over-quota', count, quota, error: +error.toFixed(4), damp: +damp.toFixed(4) });
  }
  if (count === 0 && !strong) {
    const boost = 1 + p.kExplore;
    correction *= boost;
    reasons.push({ code: 'explore-zero-weak', boost });
  }
  // ── D 项：集中度**恶化**刹车（2026-10-13 重写）──
  // 旧版只看 slope > slopeThresh（固定 0.05）——实测该阈值：小样本被噪声越过（total=6 时 |slope|=0.22），
  //   大样本不可达（distinct=204 时位移上限仅 ~0.02）⇒ 两头都错。
  // 新版三闸齐开才刹车，且强度**随显著性**给：① 结构真的变了（同构性 G 检验 p<0.05，缺该字段则退回旧口径）
  //   ② 方向是恶化（relShift>0，自动随 distinct 缩放）③ 位移够大（relShift ≥ kRel，缺省 = slopeThresh）。
  const slope = Number(win.slope) || 0;
  const relShift = Number.isFinite(win.relShift) ? win.relShift : null;      // 旧窗口对象没有 ⇒ null（按旧口径走）
  const pv = Number.isFinite(win.homogP) ? win.homogP : null;
  const significant = pv === null ? true : pv < 0.05;                        // 缺省 true = 不改变旧调用方语义
  const kRel = Number.isFinite(p.kRel) ? p.kRel : p.slopeThresh;
  const shiftEnough = relShift === null ? (slope > p.slopeThresh) : (relShift >= kRel);
  if (significant && shiftEnough && (relShift === null ? slope > 0 : relShift > 0) && error > 0) {
    const mag = relShift === null ? ((slope - p.slopeThresh) / p.slopeThresh) : (relShift / kRel - 1);
    const brake = 1 / (1 + p.kD * Math.max(0, mag));
    correction *= brake;
    reasons.push({ code: 'slope-brake', slope, relShift, p: pv, kRel, brake: +brake.toFixed(4) });
  }
  correction = Math.max(p.minCorrection, Math.min(p.maxCorrection, correction));
  return {
    enabled: true,
    id: String(id ?? ''),
    correction: +correction.toFixed(4),
    count, quota: +quota.toFixed(4), error: +error.toFixed(4),
    slope, reasons,
    params: { kP: p.kP, kExplore: p.kExplore, kD: p.kD, slopeThresh: p.slopeThresh, windowMs: win.windowMs ?? p.windowMs }
  };
}

export function loadBalanceEnabled(opts = {}) {
  return opts.loadBalance === true || RANK_DEFAULTS.loadBalance === true;
}

/** 词法分（及 brief 的 status/tip）× 排序因子 [× A1 校正]。孤案 / zeroWeight → 只用词法分。
 * factorApplied：因子是否乘进了 rank。孤案仍算出 factor/severity/complexity 供对照，但 rank=score，factorApplied=false。 */
export function applyRank(score, store, r, cred, opts = {}) {
  const f = rankFactors(store, r, cred, opts);
  const enabled = loadBalanceEnabled(opts);
  const base = { ...f, loadBalance: enabled, balance: { enabled: false, correction: 1 }, factorApplied: true };
  // 排序层卫生（2026-10-13，算法数学批 B③）：factor 非有限（NaN/Inf）会让比较器行为未定义 ⇒ 兜回 1 并留痕。
  if (!Number.isFinite(base.factor)) { base.factor = 1; base.factorSanitized = true; }
  const lexical = Number(score);
  if (store === 'orphan' || opts.zeroWeight) {
    return { rank: Number.isFinite(lexical) ? +lexical.toFixed(4) : 0, ...base, factorApplied: false };
  }
  let rank = lexical * base.factor;
  if (enabled) {
    const win = opts.usageWindow || resolveUsageWindow(opts);
    const bal = loadBalanceCorrection(r?.id, { window: win, strong: opts.strong === true, params: opts.balance, cls: f.cls || cred?.cls || null, record: r });
    rank *= bal.correction;
    base.balance = bal;
  }
  if (!Number.isFinite(rank)) { rank = Number.isFinite(lexical) ? lexical : 0; base.rankSanitized = true; }  // 绝不把 NaN 排进榜
  return { rank: +rank.toFixed(4), ...base };
}

function recordsOf(name, opts = {}) {
  const file = (opts.files && opts.files[name]) || storePath(name);
  return loadStore(name, file).records;
}

/** 当前集 id → credibilityOf（链走到该条）。opts.today / files 透传。 */
export function credibilityMap(store, records, opts = {}, current = null) {
  const map = new Map();
  // P1（2026-10-20）：索引建一次，循环内复用（原为每条记录重建全库 Map）
  const byId = new Map(records.filter((r) => isStr(r.id)).map((r) => [r.id, r]));
  for (const r of (current || currentRecords(records))) {
    if (!isStr(r.id)) continue;
    map.set(r.id, credibilityOf(store, chainEndingAt(records, r, byId), opts));
  }
  return map;
}

/**
 * 睡眠待办用的可信度扫描（只读，不写库）。
 * - 当前集里被 refute 的 → kind:review code:refuted（提醒复审，不自动改）
 * - 存储层为 T5 且 hooks 日志 usage 引用链上 id 合计 ≥ verifyUsageMin（缺省 3）→ kind:verify-candidate
 * 日志缺失 = 引用数未知 → 不出 verify-candidate。
 */
export function credibilityTodos(opts = {}) {
  const today = credDay(opts.today) || todayLocal();
  const min = Number.isInteger(opts.verifyUsageMin) ? opts.verifyUsageMin : CRED_DEFAULTS.verifyUsageMin;
  let usage = null;
  if (opts.usage instanceof Map) usage = opts.usage;
  else if (opts.log) {
    // 2026-10-13 审计 P6：尾部窗口读（与 usageWindowFromLog 同法，默认末 20000 行）。
    // 只取 `kind:"usage"` 的行；`usageFull: true` 回退整读（对照/诊断用）。
    const rows = opts.usageFull
      ? parseJsonl(readFileSync(opts.log, 'utf8')).records
      : readJsonlLinesReverse(opts.log, {
        lines: Math.max(2000, Number(opts.usageMaxLines) || 20000),
        maxBytes: Number(opts.usageMaxBytes) || 64 * 1024 * 1024,
        filter: (r) => r && r.kind === 'usage' && Array.isArray(r.ids)
      });
    usage = new Map();
    for (const rec of rows) {
      if (rec && rec.kind === 'usage' && Array.isArray(rec.ids)) {
        for (const id of rec.ids) usage.set(String(id), (usage.get(String(id)) ?? 0) + 1);
      }
    }
  }
  const items = [];
  for (const name of STORES) {
    const records = recordsOf(name, opts);
    const byId = new Map(records.filter((r) => isStr(r.id)).map((r) => [r.id, r]));
    for (const r of currentRecords(records)) {
      if (!isStr(r.id)) continue;
      const chain = chainEndingAt(records, r, byId);
      const cred = credibilityOf(name, chain, { ...opts, today });
      if (cred.refuted) {
        items.push({ kind: 'review', code: 'refuted', store: name, id: r.id, count: 1, note: `${r.id} 被 verification.refute 标记：检索默认隐藏（--include-refuted 或 show 可见），权重 0；不自动改库` });
        continue;
      }
      if (usage && cred.tier === 'T5') {
        const n = chain.reduce((s, row) => s + (usage.get(row.id) ?? 0), 0);
        if (n >= min) items.push({ kind: 'verify-candidate', code: 'verify-candidate', store: name, id: r.id, count: n, note: `${r.id} 为 T5（共识）且被 usage 引用 ${n} 次（≥${min}）：只是提醒去验证，不自动改` });
      }
    }
  }
  items.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return items;
}

function scoreTrace(h) {
  return {
    id: h.id, store: h.store, score: h.score, rank: h.rank, strong: !!h.strong,
    tier: h.tier ?? null, displayTier: h.displayTier ?? null, stale: !!h.stale,
    severity: h.severity ?? null, complexity: h.complexity ?? null, factor: h.factor ?? null, factorApplied: h.factorApplied !== false,
    balance: h.balance ?? { enabled: false, correction: 1 }, zeroWeight: !!h.zeroWeight
  };
}

export function categorySwitchEnabled(opts = {}) {
  if (opts.categorySwitch !== undefined) return opts.categorySwitch === true;
  return String(process.env.AKASHA_CATEGORY_SWITCH || '').toLowerCase() === '1';
}

export function lookupDetailed(query, opts = {}) {
  // #11 参数结构化错误（2026-10-12 窗口 2）：类型错**报错**，绝不静默当空查询。
  if (query !== undefined && query !== null && typeof query !== 'string') {
    throw new Error('lookup query 类型非法：须为字符串（收到 ' + (Array.isArray(query) ? '数组' : typeof query) + '）');
  }
  const __t0 = Date.now();                          // I-02：查询耗时（只进侧线，不进结果）
  const __qRaw = String(query ?? '').trim();
  const q = String(query || '').trim().toLowerCase();
  // #12 写入侧漏记盘面（2026-10-12 窗口 2）：只记 kind/reason 计数，**不记内容**（被跳过的是什么，不进日志）。
  const filtered = { refuted: 0, tagMismatch: 0, outOfRange: 0, noKeyword: 0, deduped: 0, belowThreshold: 0 };
  if (opts.mirrorSituationGate === true) filtered.mirrorSituationGate = 0;
  // 分类开关（默认关）：开时「品味」仅在同为品味查询时入场；安全类保留候选并优先排序（一票语义，不改四因子）。
  const categorySwitch = categorySwitchEnabled(opts);
  const queryCategory = typeof opts.category === 'string' && CATEGORIES.includes(opts.category) ? opts.category : null;
  const stats = { dated: 0, undated: 0, undatedSamples: [], excluded: 0, timeSource: { event_time: 0, logged_at: 0 }, filtered };
  if (!q) return { hits: [], stats, hint: '请给一个主题词（如：重启 / 记忆 / 来源态）。', knowledge: knowledgeRoute({ query: '', strongHits: 0, cites: [] }) };
  //   2026-10-13（举一反三·类③）：空查询与「查了但 0 命中」必须可区分——`cross`/`brief` 早有 hint，这里此前闷着。
  const tokens = tokenize(q);
  const hits = [];
  // N13：__age 映射已移除（agePrefix 在 hit 构建时直接装配——计量口径统一）。
  const rankOpts = loadBalanceEnabled(opts) ? { ...opts, usageWindow: opts.usageWindow || resolveUsageWindow(opts) } : opts;
  const seenIds = new Set();
  for (const name of STORES) {
    const records = recordsOf(name, opts);
    const creds = credibilityMap(name, records, opts);
    for (const r of currentRecords(records)) {
      if (name === 'mirror' && opts.mirrorSituationGate === true) {
        if (r.evidence !== 'story' || mirrorSituationScore(q, r).situationScore < 2) { filtered.mirrorSituationGate += 1; continue; }
      }
      const cred = creds.get(r.id);
      if (cred && cred.refuted && !opts.includeRefuted) { filtered.refuted += 1; continue; }
      if (opts.tag && !(r.tags || []).map(String).includes(String(opts.tag))) { filtered.tagMismatch += 1; continue; }   // ⑥ 按标签精确过滤（2026-10-11，lookup 主循环）
      // #37 视角过滤（2026-10-12 窗口 5）：只过滤命中面、不改加权（缺省条目不参与，视为"没标"）。
      if (opts.perspective && r.perspective !== opts.perspective) { filtered.perspectiveMismatch = (filtered.perspectiveMismatch ?? 0) + 1; continue; }
      // 分类开关（B 资格准入）：品味类只在同类目查询时进候选；安全/纪律/事实不受影响。开关关 ⇒ 不执行。
      if (categorySwitch && r.category === '品味' && queryCategory !== '品味') { filtered.categoryMismatch = (filtered.categoryMismatch ?? 0) + 1; continue; }
      if (isStr(r.id) && seenIds.has(r.id)) { filtered.deduped += 1; continue; }
      if (!inRange(r, opts.since, opts.until) && tsOf(r)) { filtered.outOfRange += 1; continue; }   // #12 只数「有戳且超范围」；无戳走日期三分提示
      if (isStr(r.id)) seenIds.add(r.id);
      const hay = (LOOKUP_FIELDS[name] || [])
        .map(f => (Array.isArray(r[f]) ? r[f].join(' ') : (r[f] || '')))
        .join(' | ');
      const hayL = hay.toLowerCase();
      const sc = scoreTokens(hayL, tokens);
      if (sc.score <= 0) continue; // 统计只看「关键词命中者」的日期归桶
      // ② 任务模式加权（2026-10-11，lookupDetailed 主路径；与 brief 侧同口径）：不传 mode ⇒ 系数 1 ⇒ 零行为变化。
      //    ⚠ 教训：本文件里 scored/hit 构造有多份副本，打补丁**必须行为探针复核**（今日已两次改错副本）。
      let modeBoost = 1;
      if (opts.mode === 'task' || opts.mode === 'improve') {
        const tl = (r.tags || []).map(String).join(' ');
        const SOLVE = /(解法|成功|复现|有效|最佳实践)/;
        const BOUND = /(坑|失败|教训|纪律|边界|禁止|陷阱)/;
        if (opts.mode === 'task') modeBoost = SOLVE.test(tl) ? 1.25 : (BOUND.test(tl) ? 0.9 : 1);
        else modeBoost = BOUND.test(tl) ? 1.25 : (SOLVE.test(tl) ? 0.9 : 1);
      }
      sc.score = +(sc.score * modeBoost).toFixed(4);
      // #25 否定降权（2026-10-12 窗口 7；默认关）：**只进排序键、不动 score/命中面**（A5：修正不替代）。
      sc.negFactor = opts.negationPenalty ? negationPenalty(hayL) : 1;
      if (false) { /* ② 残留已清（2026-10-11 复检）：不再把 mode 写回记录对象；加权只进分数 */ }
      const b = dateBucket(r, opts);
      if (b.bucket === 'out') { stats.excluded += 1; continue; }
      if (b.bucket === 'undated') {
        stats.undated += 1; // 计数不随并入开关变（报告口径一致）
        if (!opts.includeUndated) {
          if (stats.undatedSamples.length < 3) stats.undatedSamples.push({ store: name, id: r.id, snippet: hay.slice(0, 60) });
          continue;
        }
      }
      if (b.timeSource) stats.timeSource[b.timeSource] += 1;
      if (b.bucket === 'in') stats.dated += 1;
      // strong 只看整词命中；严重度×可信度×复杂度只进 rank，不进 score。
      const strong = name !== 'orphan' && sc.whole >= 1;
      const rf = applyRank(sc.score, name, r, cred, { ...rankOpts, strong });
      // 不传 depth / reflect / depth:full：snippet 仍是 main 的 120 字（放开会破坏默认档零差）。只有有效档为 pointer 时收到 80。
      // N14（GPT 第三轮）：用**有效档位**（readDepthOf）而非原始 opts.depth——pointer+reflect 组合下有效档=full。
      const __snipCap = readDepthOf(opts) === 'pointer' ? READ_TIER.pointerChars : READ_TIER.lookupSummaryChars;
      const hit = {
        store: name, id: r.id, score: sc.score, strong, zeroWeight: name === 'orphan',
        snippet: redact(hay.slice(0, __snipCap)),
        rank: rf.rank, factor: rf.factor, severity: rf.severity, complexity: rf.complexity, factorApplied: rf.factorApplied, balance: rf.balance,
        tier: cred ? cred.tier : null, displayTier: cred ? cred.displayTier : null, stale: !!(cred && cred.stale), refuted: !!(cred && cred.refuted),
        ...(r.category ? { category: r.category } : {})
      };
      if (isStr(r.id)) hit.agePrefix = agePrefix(r, { today: opts.today });   // N13：装配**前移**（计量=最终响应）
      if (b.bucket === 'undated') hit.undated = true;
      hits.push(hit);
    }
  }
  // #8 同分次序显式化（2026-10-12 窗口 3）：rank → 词法分 → **时间（新者优先）→ id 升序**。
  //   前两级同分时不再依赖插入序（数组顺序=档案顺序，跨索引批次会漂移）；后两级保证任意两次结果全等。
  const tieBreak = (a, b) => {
    const ta = String(tsOf(a.r ?? {}) ?? ''), tb = String(tsOf(b.r ?? {}) ?? '');
    if (ta !== tb) return ta < tb ? 1 : -1;
    return String(a.id).localeCompare(String(b.id), 'en');
  };
  const catRank = (h) => (categorySwitch && h.category === '安全' ? 1 : 0);
  const ranked = hits.sort((a, b) => catRank(b) - catRank(a) || (b.rank * (b.negFactor ?? 1)) - (a.rank * (a.negFactor ?? 1)) || b.rank - a.rank || b.score - a.score || tieBreak(a, b)).slice(0, 20);
  const strongHits = ranked.filter((h) => h.strong).length;
  const cites = ranked.filter((h) => !h.strong && !h.zeroWeight).map((h) => ({
    store: h.store, id: h.id, tier: h.tier ?? null, displayTier: h.displayTier ?? null
  }));
  const orphanOnly = strongHits === 0 && cites.length === 0 && ranked.some((h) => h.zeroWeight);
  const knowledge = knowledgeRoute({ query: q, strongHits, cites, orphanOnly });
  // #30 citeAllowlist（2026-10-12 窗口 4）：把「本回合取回的 id」明示出来 —— 事前形状（事后靠 output-audit 抓假 id）。
  //   软协议：本回合断言优先引用这份清单里的 id；清单外 = 无据（要么先查、要么明说不知道）。
  const citeAllowlist = ranked.filter((h) => isStr(h.id)).map((h) => ({ id: h.id, store: h.store, tier: h.tier ?? null, strong: !!h.strong }));
  // #35 lookup --trace（2026-10-12 窗口 5）：输出 schema 固化——逐条列出计分零件，可审、可复核。
  // ②（GPT 第四轮·token 开刀）：**诊断默认分离**——trace（逐条计分零件）只在显式 `trace:true`（CLI `--trace`）时返回；
  //   citeAllowlist（引用纪律件）与 stats（报告口径）保留——分离的是「可审零件」，不是纪律。
  const trace = opts.trace !== true ? null : ranked.map(scoreTrace);
  const __res = { hits: ranked, stats, knowledge, citeAllowlist, ...(trace ? { trace } : {}), blindspots: blindspotsFor({ perspective: opts.perspective }), depth: readDepthOf(opts) };
  // I-12 P1-③ 剂量闸（2026-10-13）：符号负荷超阈 ⇒「后续条目」snippet 摘要化（保 id / 序位；反思通道与 doseThreshold:0 不受限）。
  const __doseThreshold = Number.isInteger(opts.doseThreshold) ? opts.doseThreshold : GENRE_DOSE_DEFAULTS.threshold;
  if (!highFidelityRead(opts) && __doseThreshold > 0 && ranked.length) {
    const dg = doseGate(ranked.map((h) => h.snippet), { threshold: __doseThreshold });
    if (dg.cutoff !== null) {
      for (let i = dg.cutoff; i < ranked.length; i += 1) ranked[i] = { ...ranked[i], snippet: doseSummary(ranked[i].snippet), dose: true };
      __res.dose = { threshold: __doseThreshold, total: dg.total, from: dg.cutoff, trimmed: ranked.length - dg.cutoff };
    }
  }
  const __out = opts.contextBudget === false ? __res : clipByBudget(__res, { ...opts, offset: opts.offset });
  // N13（GPT 第三轮）：**统一计量口径**——agePrefix / depth 属最终响应，装配已在 clip **之前**完成（此前裁后装配
  //   ⇒ 账面 4050 而排除 budget 复算 4147）。citeAllowlist 保持裁剪前的清单（与 main 相同，不在裁后重建）。
  // I-02 查询侧线（append-only；失败静默，绝不影响返回值）
  if (opts.__noQueryLog !== true) recordQuery({ cmd: 'lookup', query: __qRaw, hits: ranked.length, ms: Date.now() - __t0, ids: ranked.map((h) => h.id), genreRender: genreRenderOf(opts) }, opts);
  return __out;
}

export function lookup(query, opts = {}) {
  return lookupDetailed(query, opts).hits;
}

/** #7 多路召回 + RRF 融合（2026-10-12 窗口 3；只读、additive——lookup/brief 主路径默认不变）。
 *  路：① 词法路（lookupDetailed，现有计分与四因子重排在**路内**生效）；② 引用路（#6 关系边的**反向索引**：谁引用了词法命中者）。
 *  融合：RRF score = Σ 1/(k + rank_i)（k=60，标准常数）；**RRF 只定名字与次序，仍按现有四因子重排**（A5：修正不替代主语义）。
 *  可审计：返回 `rrf:{lexical,citation,k}` 与每条 `rrfScore` / `paths`。
 *  边界（如实）：会话层路未并入（跨库，需要时另开）；引用路只扩「两步内」的邻居。 */
export function multiRecall(query, opts = {}) {
  // 分类开关与多路召回的组合尚未实现（引用路会绕过资格准入）：明确拒绝，不静默忽略。
  if (categorySwitchEnabled(opts)) throw new Error('分类开关暂不支持与 recall 组合：请先关分类或改用普通 lookup');
  const __t0 = Date.now();                          // I-02：整路耗时（含词法路），只进侧线
  const k = Number.isInteger(opts.rrfK) && opts.rrfK > 0 ? opts.rrfK : 60;
  const base = lookupDetailed(query, { ...opts, contextBudget: false, __noQueryLog: true });   // 路内不裁剪；统一在最后走 clipByBudget；侧线由本层写（防嵌套双记）
  const lexical = Array.isArray(base.hits) ? base.hits : [];
  const byId = new Map(lexical.filter((h) => isStr(h.id)).map((h) => [h.id, h]));
  // 引用路：读与词法同一批 records，建反向索引（target → sources），再把命中者的邻居带回。
  const citHits = [];
  const citationStores = new Map();
  const rrf = new Map();
  lexical.forEach((h, i) => rrf.set(h.id, { item: h, score: 1 / (k + i + 1), paths: ['lexical'] }));
  if (lexical.length) {
    const pool = [];
    for (const name of STORES) for (const r of currentRecords(recordsOf(name, opts))) {
      if (!inRange(r, opts.since, opts.until)) continue;
      const targets = [];
      if (Array.isArray(r.relates_to)) targets.push(...r.relates_to);
      if (Array.isArray(r.relations)) for (const it of r.relations) if (it && isStr(it.id)) targets.push(it.id);
      if (targets.length && r.id && !byId.has(r.id)) pool.push({ rec: r, store: name, targets });
    }
    const wanted = new Set(lexical.map((h) => h.id));
    const seen = new Set();
    for (const p of pool) {
      const hitIdx = p.targets.findIndex((t) => wanted.has(t));
      if (hitIdx === -1 || seen.has(p.rec.id)) continue;
      seen.add(p.rec.id);
      const item = briefHit(p.store, p.rec, 0);
      citHits.push(item);
      citationStores.set(item.id, p.store);
      const cur = rrf.get(item.id);
      const inc = 1 / (k + citHits.length);
      if (cur) { cur.score += inc; cur.paths.push('citation'); }
      else rrf.set(item.id, { item, score: inc, paths: ['citation'] });
    }
  }
  const fused = [...rrf.values()]
    .map((v) => ({ ...v.item, rrfScore: +v.score.toFixed(6), paths: v.paths.slice() }))
    .sort((a, b) => b.rrfScore - a.rrfScore
      || (b.paths.length - a.paths.length)
      || (b.rank ?? 0) - (a.rank ?? 0)
      || (b.score ?? 0) - (a.score ?? 0)
      || String(a.id).localeCompare(String(b.id), 'en'));
  const out = { ...base, hits: fused, rrf: { lexical: lexical.length, citation: citHits.length, k }, citeAllowlist: [...base.citeAllowlist || [], ...fused.filter((h) => isStr(h.id)).map((h) => ({ id: h.id, store: h.store ?? null, tier: h.tier ?? null, strong: !!h.strong }))] };
  if (opts.trace === true) out.trace = fused.map(h => ({
    ...scoreTrace({ ...h, store: h.store ?? citationStores.get(h.id) ?? null }),
    rrfScore: h.rrfScore, paths: h.paths
  }));
  const __out = opts.contextBudget === false ? out : clipByBudget(out, { ...opts, offset: opts.offset });
  __out.depth = readDepthOf(opts);
  if (opts.__noQueryLog !== true) recordQuery({ cmd: 'recall', query: String(query ?? '').trim(), hits: (out.hits || []).length, ms: Date.now() - __t0, ids: (out.hits || []).map((h) => h.id), genreRender: genreRenderOf(opts) }, opts);
  return __out;
}

// 主题简报：把「先查再答」从逐条 lookup 升级为按主题跨六库取料（带来源态与基石映射）。
const STATUS_WEIGHT = { '已实践': 3, '已复现': 2, '高引用': 1, '待验证': 0 };

function briefHit(store, r, score) {
  const base = { id: r.id, score, time: tsOf(r) ? String(tsOf(r)).slice(0, 10) : null, valence: typeof r.valence === 'number' ? r.valence : null, arousal: typeof r.arousal === 'number' ? r.arousal : null };
  if (store === 'canon') return { ...base, claim: r.claim, source: r.source && r.source.type, ref: r.source && r.source.ref, last_reviewed: r.last_reviewed };
  if (store === 'frontier') return { ...base, title: r.title, status: r.status, topic: r.topic, supports: Array.isArray(r.supports) ? r.supports : [], url: r.url };
  if (store === 'mirror') return { ...base, ...mirrorTuple(r), story: r.story ?? null, evidence: MIRROR_EVIDENCE.includes(r.evidence) ? r.evidence : null, era: r.era ?? null, context: r.context ?? null, role: MIRROR_ROLES.includes(r.role) ? r.role : null };
  if (store === 'orphan') return { ...base, summary: r.summary, severity: r.severity };
  if (store === 'pricing') return { ...base, behavior: r.behavior, valence: r.valence, severity_default: r.severity_default };
  if (store === 'lexicon') return { ...base, term: r.term, resolution: r.resolution };
  return base;
}

export function brief(query, opts = {}) {
  // #11 参数结构化错误（2026-10-12 窗口 2）：主题类型错**报错**，不静默。
  if (query !== undefined && query !== null && typeof query !== 'string') {
    throw new Error('brief 主题类型非法：须为字符串（收到 ' + (Array.isArray(query) ? '数组' : typeof query) + '）');
  }
  const __t0 = Date.now();                          // I-02：简报耗时（只进侧线）
  const q = String(query || '').trim();
  const filtered = { refuted: 0, tagMismatch: 0, outOfRange: 0, noKeyword: 0, deduped: 0, belowThreshold: 0 };
  if (opts.mirrorSituationGate === true) filtered.mirrorSituationGate = 0;
  if (!q) return { query: q, tokens: [], groups: [], strongHits: 0, note: '空查询：给一个主题词（多个词用空格分隔）。', knowledge: knowledgeRoute({ query: '', strongHits: 0, cites: [] }), stats: { filtered } };
  const tokens = tokenize(q);
  const perStore = Number.isInteger(opts.perStore) && opts.perStore > 0 ? opts.perStore : READ_TIER.briefPerStore;
  const groups = [];
  // N13：__ageB 映射已移除（同上）。
  const rankOpts = loadBalanceEnabled(opts) ? { ...opts, usageWindow: opts.usageWindow || resolveUsageWindow(opts) } : opts;
  for (const name of STORES) {
    const records = recordsOf(name, opts);
    const cur = currentRecords(records);              // P2（2026-10-20）：只算一次，credibilityMap 复用
    const creds = credibilityMap(name, records, opts, cur);
    const scored = [];
    for (const r of cur) {
      const cred = creds.get(r.id);
      if (cred && cred.refuted && !opts.includeRefuted) { filtered.refuted += 1; continue; }
      if (!inRange(r, opts.since, opts.until) && tsOf(r)) { filtered.outOfRange += 1; continue; }   // #12 只数「有戳且超范围」；无戳走日期三分提示
      if (opts.tag && !(r.tags || []).map(String).includes(String(opts.tag))) { filtered.tagMismatch += 1; continue; }   // ⑥ 按标签精确过滤（2026-10-11）
      const hay = (LOOKUP_FIELDS[name] || [])
        .map(f => (Array.isArray(r[f]) ? r[f].join(' ') : (r[f] || '')))
        .join(' | ')
        .toLowerCase();
      const hayL = hay.toLowerCase();
      const sc = scoreTokens(hayL, tokens);
      if (sc.score > 0) {
        // ② 任务模式加权（2026-10-11，设计稿 §2.5「先判任务模式」）：不传 mode ⇒ 系数 1 ⇒ 零行为变化。
        //    如实口径：按 tags 关键词小幅加权，**不是**语义理解；命中加权的条目在结果里带 `mode` 标注。
        let modeBoost = 1;
        if (opts.mode === 'task' || opts.mode === 'improve') {
          const tl = (r.tags || []).map(String).join(' ');
          const SOLVE = /(解法|成功|复现|有效|最佳实践)/;
          const BOUND = /(坑|失败|教训|纪律|边界|禁止|陷阱)/;
          if (opts.mode === 'task') modeBoost = SOLVE.test(tl) ? 1.25 : (BOUND.test(tl) ? 0.9 : 1);
          else modeBoost = BOUND.test(tl) ? 1.25 : (SOLVE.test(tl) ? 0.9 : 1);
        }
        scored.push({ r, cred, score: +(sc.score * modeBoost).toFixed(4), mode: modeBoost !== 1 ? opts.mode : undefined, strong: name !== 'orphan' && sc.whole >= 1, zeroWeight: name === 'orphan' });
      }
    }
    // 排序 = (词法分 + frontier 状态 + 负价 tip) × (严重度 × 可信度 × 复杂度)。
    // arousal 进严重度乘子，不再加进 base（防双计）。过期不改存储层系数。strong 不看乘子。
    const weight = (x) => {
      if (x.zeroWeight || (x.cred && x.cred.refuted)) return 0;
      const base = x.score + (name === 'frontier' ? (STATUS_WEIGHT[x.r.status] ?? 0) : 0) + valenceTip(x.r);
      return applyRank(base, name, x.r, x.cred, { ...rankOpts, strong: x.strong }).rank;
    };
    scored.sort((a, b) => weight(b) - weight(a) || Number(b.strong) - Number(a.strong));
    if (scored.length) {
      const candidates = readTierActive(opts) ? scored : scored.slice(0, perStore);
      groups.push({ store: name, total: scored.length, hits: candidates.map(x => {
        const base = x.score + (name === 'frontier' ? (STATUS_WEIGHT[x.r.status] ?? 0) : 0) + valenceTip(x.r);
        const rf = applyRank(base, name, x.r, x.cred, { ...rankOpts, strong: x.strong });
        const __pre = isStr(x.r.id) ? agePrefix(x.r, { today: opts.today }) : null;   // N13：装配前移（计量=最终响应）
        return {
          ...( __pre ? { agePrefix: __pre } : {}),
          ...briefHit(name, x.r, x.score), strong: x.strong, zeroWeight: x.zeroWeight,
          rank: rf.rank, factor: rf.factor, severity: rf.severity, complexity: rf.complexity, factorApplied: rf.factorApplied, balance: rf.balance,
          tier: x.cred ? x.cred.tier : null, displayTier: x.cred ? x.cred.displayTier : null,
          stale: !!(x.cred && x.cred.stale), refuted: !!(x.cred && x.cred.refuted)
        };
      }) });
    }
  }
  // I-12 P1-③ 剂量闸（2026-10-13）：按「主文本字段」计符号负荷，超阈 ⇒「后续条目」该字段摘要化（反思通道与 doseThreshold:0 不受限）。
  const __doseThresholdB = Number.isInteger(opts.doseThreshold) ? opts.doseThreshold : GENRE_DOSE_DEFAULTS.threshold;
  let __doseB = null;
  if (!highFidelityRead(opts) && __doseThresholdB > 0 && groups.length) {
    const seq = [];
    for (const g of groups) for (const h of g.hits) seq.push({ g, h });
    const dg = doseGate(seq.map((x) => String(x.h[DOSE_TEXT_FIELD[x.g.store]] ?? '')), { threshold: __doseThresholdB });
    if (dg.cutoff !== null) {
      for (let i = dg.cutoff; i < seq.length; i += 1) {
        const f = DOSE_TEXT_FIELD[seq[i].g.store];
        seq[i].h[f] = doseSummary(seq[i].h[f]);
        seq[i].h.dose = true;
      }
      __doseB = { threshold: __doseThresholdB, total: dg.total, from: dg.cutoff, trimmed: seq.length - dg.cutoff };
    }
  }
  if (readTierActive(opts)) {
    const __d = readDepthOf(opts);                                                    // N14：投影/标签同源于有效档位
    const cap = __d === 'pointer' ? READ_TIER.pointerChars : READ_TIER.summaryChars;
    for (const g of groups) g.hits = g.hits.map((h) => projectHitFields(h, __d, cap));
  }
  const flat = [];
  for (const g of groups) for (const h of g.hits) flat.push({ ...h, store: g.store });
  const strongHits = flat.filter((h) => h.strong).length;
  const cites = flat.filter((h) => !h.strong && !h.zeroWeight).map((h) => ({
    store: h.store, id: h.id, tier: h.tier ?? null, displayTier: h.displayTier ?? null,
    ref: h.ref || h.url || null, source: h.source || h.status || null
  }));
  const orphanOnly = strongHits === 0 && cites.length === 0 && flat.some((h) => h.zeroWeight);
  const knowledge = knowledgeRoute({ query: q, strongHits, cites, orphanOnly });
  const note = knowledge.note;
  const __bres = { query: q, tokens, groups, strongHits, note, knowledge, stats: { filtered }, ...( __doseB ? { dose: __doseB } : {}), citeAllowlist: flat.filter((h) => isStr(h.id)).map((h) => ({ id: h.id, store: h.store ?? null, tier: h.tier ?? null, strong: !!h.strong })),
    // #31 检索梯（2026-10-12 窗口 5）：标明「停在哪一层、为何没下钻」——可解释性直接落地（只提示不拦截）。
    ladder: (() => {
      const orphanHits = flat.filter((h) => h.zeroWeight).length;
      const layers = [
        { layer: 'canon-strong', hit: flat.filter((h) => h.strong && h.store === 'canon').length, note: '库内强命中（整词）' },
        { layer: 'canon-weak', hit: flat.filter((h) => !h.strong && h.store === 'canon').length, note: '库内弱命中（疑似相关，须 cites）' },
        { layer: 'other-strong', hit: flat.filter((h) => h.strong && h.store !== 'canon').length, note: '其它库强命中' },
        { layer: 'orphan', hit: orphanHits, note: '零权重孤案（只作线索，不作证据）' },
        { layer: 'session', hit: 0, note: '会话层未并入本入口（跨库，需要时另开）' },
        { layer: 'web', hit: 0, note: '外网检索：宿主未接（search 契约已备）' }
      ];
      const stop = layers.find((x) => x.hit > 0 && x.layer !== 'session' && x.layer !== 'web');
      for (const x of layers) {
        x.stopped = !!stop && x.layer === stop.layer;
        x.why = x.stopped ? '命中足够，未继续下钻'
          : (x.hit > 0 ? '有更靠上的层先命中（本轮被上层截停）'
            : (x.layer === 'session' ? '未开（单入口设计：会话层检索另走 session lookup）' : (x.layer === 'web' ? '未开（宿主未接外网检索）' : '无命中')));
      }
      return layers;
    })() };
  __bres.depth = readDepthOf(opts);                                                  // N13：depth 装配前移（计量=最终响应）
  const __out = readTierActive(opts)
    ? clipByBudget(__bres, { ...opts, pageLimits: boundedPageLimits(opts, READ_TIER.briefPerStore) })
    : (opts.contextBudget === false ? __bres : clipByBudget(__bres, opts));
  // N13（GPT 第三轮）：agePrefix 装配已前移（组内构建时）——clip 计量即终局。清单不在裁后重建。
  if (opts.__noQueryLog !== true) recordQuery({ cmd: 'brief', query: q, hits: groups.reduce((n, g) => n + g.total, 0), ms: Date.now() - __t0, ids: flat.map((h) => h.id), genreRender: genreRenderOf(opts) }, opts);
  return __out;
}

// 全库摘要：六库计数 + 各库最近 N 条（主行）+ frontier 状态分布 + 审计概要 + 最近写入。
// 「不带问题看一眼全库」的入口——kit 是开工动作、summary 是库自身全貌。
export function summary(opts = {}) {
  // 2026-10-15 全量检查（S-core-1）：本函数声称支持 `opts.files` 数据面注入，实际不带路径读真库 ⇒ 接上注入
  const L = (n) => loadStore(n, (opts.files && opts.files[n]) || storePath(n));
  // 2026-10-15 全量检查（cli-mcp S5）：`per` 无上界 ⇒ `summary --per 1e9` 出 185KB（默认档 4.3KB）⇒ 钳到 20
  const per = Math.min(20, Number.isInteger(opts.per) && opts.per > 0 ? opts.per : 3);
  const today = dayArg(opts.today, 'today') || todayLocal();   // 2026-10-15：校验下沉到 lib（原先只有 MCP 面校，CLI 透传 ⇒ 'bogus' 词法大于一切 ISO 日期）
  const stores = {};
  for (const name of STORES) {
    const cur = currentRecords(L(name).records);
    stores[name] = {
      total: cur.length,
      recent: cur.slice(-per).reverse().map(r => ({
        id: r.id,
        event_time: r.event_time ?? null,
        line: String(PRIMARY_LINE[name] ? PRIMARY_LINE[name](r) : '').slice(0, 160)
      }))
    };
  }
  // 2026-10-15（GPT 复核 core N1）：三个子调用也必须吃**同一注入**——否则「空库却有待验证状态/到期项/newest」
  // 自相矛盾（stats/audit/pulse 各自读默认库 ⇒ summary 的注入只接了一半）。
  const s = stats(opts);
  stores.frontier.by_status = s.frontier.by_status;
  const a = audit({ ...opts, today });
  const p = pulse(opts);
  return {
    at: new Date().toISOString(),
    today,
    stores,
    audit: { ok: a.ok, findings: a.findings.map(f => ({ level: f.level, code: f.code, count: f.detail.length })) },
    newest: p.newest ? { store: p.newest.store, id: p.newest.id, ageText: p.newest.ageText } : null
  };
}

// 直读一条：按 id 跨库取全文；命中**旧版本**时返回所查版本全文 + 附注链尾 id（不自动跳转；Letta「needle+expand」的 expand 最小形态）。
export function parseAkashaUri(uri) {
  const prefix = 'akasha://';
  if (typeof uri !== 'string' || !uri.startsWith(prefix)) throw new TypeError('not an akasha URI');
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) throw new TypeError('akasha URI missing store or id');
  const store = rest.slice(0, slash);
  if (!STORES.includes(store)) throw new TypeError('unknown akasha store: ' + store);
  const encoded = rest.slice(slash + 1);
  if (!encoded || /[/?#\r\n]/.test(encoded)) throw new TypeError('invalid akasha URI component');
  let id;
  try { id = decodeURIComponent(encoded); } catch { throw new TypeError('invalid percent-encoding in akasha URI'); }
  if (!id.trim()) throw new TypeError('empty akasha ID');
  return { store, id };
}

export function showUri(uri, opts = {}) {
  return show(uri, { ...opts, inputKind: 'uri' });
}

export function show(id, opts = {}) {
  let target = String(id || '').trim();
  const inputKind = opts.inputKind ?? 'id';
  if (!['id', 'uri'].includes(inputKind)) throw new TypeError('invalid inputKind: ' + inputKind);
  if (inputKind === 'uri') {
    const parsed = parseAkashaUri(target);
    if (opts.store && opts.store !== parsed.store) {
      return { found: false, note: `URI store=${parsed.store} 与 opts.store=${opts.store} 不一致`, citeAllowlist: [], depth: readDepthOf(opts) };
    }
    target = parsed.id;
    opts = { ...opts, store: parsed.store };
  }
  const depth = readDepthOf(opts);
  const projectDepth = readTierActive(opts) ? opts.depth : 'full';
  const pack = (name, rec, extra) => {
    const projected = projectRecord(rec, name, projectDepth);
    const cred = extra.credibility;
    const note = extra.note && projected.truncated
      ? extra.note + `（读档 ${depth} 已按单条硬顶 ${depth === 'pointer' ? READ_TIER.pointerChars : READ_TIER.claimCapChars} 字截断；全文是默认，或显式 reflect / depth:full）`
      : extra.note;
    // 键序对齐 main（found, store, id, retired?, note?, record, credibility），附加字段放末尾。
    const out = { found: extra.found, store: name, id: extra.id };
    if (extra.retired) out.retired = true;
    if (extra.proposed) out.proposed = true;
    if (note) out.note = note;
    out.record = projected.record;
    if (cred) out.credibility = cred;
    out.depth = depth;
    out.truncated = projected.truncated;
    out.agePrefix = agePrefix(rec, { today: opts.today });
    out.citeAllowlist = isStr(rec && rec.id) ? [{ id: rec.id, store: name, tier: cred ? (cred.tier ?? null) : null, strong: true }] : [];
    return out;
  };
  if (!target) return { found: false, note: '给一个记录 id', citeAllowlist: [], depth };
  const stores = opts.store ? [opts.store] : STORES;
  for (const name of stores) {
    const records = loadStore(name, opts.file || storePath(name)).records;
    const credOf = (rec) => credibilityOf(name, chainEndingAt(records, rec), opts);
    const rec = currentRecords(records).find(r => r.id === target);
    if (rec) return pack(name, rec, { found: true, store: name, id: rec.id, credibility: credOf(rec) });
    const old = records.find(r => r.id === target);
    if (old) {
      let tip = old;
      const seen = new Set([tip.id]);
      for (;;) { const next = records.find(r => r.supersedes === tip.id); if (!next || seen.has(next.id)) break; seen.add(next.id); tip = next; }
      // 退役态优先判定（2026-10-08）：链尾被墓碑 retires 时，不能再提示「当前版本：<链尾>」——链尾本身也已退役。
      const revokedTomb = new Set(records.map(r => r.revokes).filter(v => typeof v === 'string' && v !== ''));
      const tomb = records.find(r => r.retires === tip.id && !revokedTomb.has(r.id));
      if (tomb) {
        return pack(name, old, {
          found: false, store: name, id: target, retired: true,
          note: `该 id 已退役（${tomb.retired_at || '时间未记'}）${tomb.retired_reason ? '：' + tomb.retired_reason : ''}——已不属于当前集（lookup / brief / cross / summary / audit / 列表均不再命中）；历史仍在库里可追溯。`,
          credibility: credOf(old),
        });
      }
      if (tip.status === 'proposed') {
        return pack(name, old, {
          found: false, store: name, id: target, proposed: true,
          note: tip.id === target
            ? '该 id 为待采纳提案（proposed）；采纳用 accept。'
            : `该 id 为历史提案版本；当前待采纳版本：${tip.id}`,
          credibility: credOf(old),
        });
      }
      if (old.status === 'proposed') {
        return pack(name, old, {
          found: false, store: name, id: target,
          note: `该历史提案已采纳；当前版本：${tip.id}`,
          credibility: credOf(old),
        });
      }
      return pack(name, old, { found: false, store: name, id: target, note: '该 id 为旧版本（record 字段＝所查版本全文，不会自动跳转）；当前版本：' + tip.id, credibility: credOf(old) });
    }
  }
  return { found: false, note: '六库均无此 id：' + target, citeAllowlist: [], depth };
}

/** 抽出五元组（纯函数；不写库）。顺序见 MIRROR_TUPLE_FIELDS。 */
/** (a) 两镜对比（2026-10-11 用户口径）：**基线镜（own-log）＝我们自己的经验**，用途是"我现在做得更好还是更差"；
 *  **范式镜（story）＝典籍/寓言/史例**，用途是横向借镜（按结构匹配）。两镜**必须分开呈现**，不可混算。 */
export function mirrorCompare(text, opts = {}) {
  const hits = mirrorMatch(text, { ...opts, limit: opts.limit ?? 12 });
  const rows = hits.map((h) => {
    const r = h.record ?? h.r ?? h;
    return {
      id: r.id, story: r.story, evidence: r.evidence || (r.source ? 'story' : 'own-log'),
      era: r.era, context: r.context, situation: r.situation, behavior: r.behavior,
      outcome: r.outcome, social_reaction: r.social_reaction, emotion: r.emotion,
      patterns: r.patterns, verdict: r.outcome_verdict ?? null, rework: r.rework ?? null,
      score: h.score ?? h.rank ?? null,
      complete: Boolean(r.situation && r.behavior && r.outcome),
    };
  });
  const baseline = rows.filter((r) => r.evidence !== 'story');
  const paradigm = rows.filter((r) => r.evidence === 'story');
  const judged = baseline.filter((r) => r.verdict);
  const worse = judged.filter((r) => /失败|部分/.test(String(r.verdict)));
  // ③ 同构＝权重衰减（2026-10-11，设计稿 §2.9）：**有近同构 ⇒ 高置信**；**无近同构 ⇒ 最近邻 + 折扣**（×0.6），且**显式标注**
  const topScore = rows.reduce((m, r) => Math.max(m, Number(r.score) || 0), 0);
  const total = baseline.length + paradigm.length;
  const confidence = total === 0 ? '无案例'
    : topScore >= 3 ? '高（有近同构）'
      : topScore >= 1 ? '中（弱同构）'
        : '低（仅最近邻）';
  const decay = confidence.startsWith('低') ? 0.6 : (confidence.startsWith('中') ? 0.85 : 1);
  const decayNote = (confidence === '低（仅最近邻）' || confidence === '中（弱同构）')
    ? ('⚠ ' + confidence + ' ⇒ 按最近邻 + 原理推演，置信度折扣 ×' + decay + '；')
    : '';
  return {
    query: String(text).slice(0, 60), baseline, paradigm, confidence, decay,
    summary: {
      baseline: baseline.length, paradigm: paradigm.length, confidence, decay,
      judged: judged.length, worse: worse.length,
      note: decayNote + (judged.length
        ? ('基线镜里已有 ' + judged.length + ' 条带可判定结果（其中 ' + worse.length + ' 条为失败/部分）——可用作"更好还是更差"的比较基准')
        : '基线镜尚无带可判定结果的条目：请用 mirror outcome <id> --verdict 成功|失败|部分 --rework N 记录本次结果（否则"更好更差"只能靠印象）'),
    },
  };
}

/** (a') 记录可判定结果（修订链：追加不改原文）。verdict ∈ 成功|部分|失败。 */
export function mirrorOutcome(id, { verdict, rework = null, note = null } = {}) {
  if (!verdict || !/^(成功|部分|失败)$/.test(String(verdict))) throw new Error('--verdict 必填且 ∈ {成功,部分,失败}');
  const patch = { outcome_verdict: String(verdict), last_reviewed: todayLocal() };
  if (rework !== null) patch.rework = Number(rework);
  if (note) patch.outcome_note = String(note);
  return revise('mirror', id, patch);
}

/** (b) 范式镜导入管道（**不写库**）：校验 + 五元组骨架。story 类**必须**带 source（出处）/era（时代）/context（语境）
 *  —— 这是设计稿 §2.14 自己写的**教材偏差**防护（寓言/史例是"被挑选并流传"的文本）。 */
export function mirrorImportDraft(text, { source, era, context, story = null } = {}) {
  const missing = [];
  if (!source) missing.push('source（出处：书名/篇目/版本）');
  if (!era) missing.push('era（时代：成书或事件年代）');
  if (!context) missing.push('context（语境：文化/立场/使用场景）');
  if (missing.length) throw new Error('范式镜条目必须带出处信息（教材偏差防护）——缺：' + missing.join('、'));
  const body = String(text || '').slice(0, 4000);
  const draft = {
    store: 'mirror', evidence: 'story', source, era, context,
    story: story || '（待填：典故意象/篇名，一句话）',
    situation: '（待填：情境模式——按**结构**写，不写生理描写，如"被反复警告后仍不信"）',
    behavior: '（待填：角色的行为）',
    outcome: '（待填：结果，可判定优先）',
    social_reaction: '（待填：社会反应/众人评价）',
    emotion: '（待填：情绪词，须在 lexicon 内或有释义）',
    patterns: '（待填：可复用的结构模式，用 / 分隔）',
    text_excerpt: body.slice(0, 600),
    checklist: [
      '结构匹配优先（被背叛/被警告不听/…），不写生理描写',
      'emotion 只给"名字"；"我此刻是什么"必须由可验证的自身事件证明（防表演式自知）',
      'outcome 尽量可判定（成功/部分/失败 + 返工次数），便于与基线镜对比',
    ],
    note: '草稿仅供人工填槽后入库（mirror add 或 lib.appendRecord）；本条未被写入。',
  };
  return draft;
}

export function mirrorTuple(r) {
  const rec = r && typeof r === 'object' ? r : {};
  const out = {};
  for (const f of MIRROR_TUPLE_FIELDS) out[f] = rec[f] ?? '';
  return out;
}

/**
 * 镜像结构匹配（2026-10-07；wave4 补 evidence/era/context 过滤与回传）。
 * 五元组字段计分（situation 权重 ×2）+ patterns 可选加权；结构优先于字面故事名。
 * 过滤：mode/role（wave1）；evidence（story|own-log）；era/context（子串，大小写不敏感）；notApplicable（#3 不适用条件，2026-10-12 窗口 2——不传 = 不过滤）。
 */
export function mirrorMatch(text, opts = {}) {
  const tokens = tokenize(text);
  if (!tokens.length) return [];
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 3;
  const mode = opts.mode === undefined || opts.mode === null || opts.mode === '' ? 'all' : String(opts.mode);
  if (!MIRROR_MODES.includes(mode)) throw new Error('mode 须为 ' + MIRROR_MODES.join('/'));
  const role = opts.role === undefined || opts.role === null || opts.role === '' ? null : String(opts.role);
  if (role !== null && !MIRROR_ROLES.includes(role)) throw new Error('role 须为 ' + MIRROR_ROLES.join('/'));
  const evidence = opts.evidence === undefined || opts.evidence === null || opts.evidence === '' ? null : String(opts.evidence);
  if (evidence !== null && !MIRROR_EVIDENCE.includes(evidence)) throw new Error('evidence 须为 ' + MIRROR_EVIDENCE.join('/'));
  const eraNeedle = opts.era ? String(opts.era).toLowerCase() : null;
  const ctxNeedle = opts.context ? String(opts.context).toLowerCase() : null;
  const keepRole = (r) => {
    const rr = MIRROR_ROLES.includes(r.role) ? r.role : null;
    if (role) return rr === role;
    if (mode === 'task') return rr !== 'boundary';
    if (mode === 'improve') return rr !== 'solution';
    return true;
  };
  const keepMeta = (r) => {
    if (evidence) {
      const ev = MIRROR_EVIDENCE.includes(r.evidence) ? r.evidence : null;
      if (ev !== evidence) return false;
    }
    if (eraNeedle && !String(r.era ?? '').toLowerCase().includes(eraNeedle)) return false;
    if (ctxNeedle && !String(r.context ?? '').toLowerCase().includes(ctxNeedle)) return false;
    return true;
  };
  const hits = [];
  // 空对象与缺省同义（2026-10-15，P2 审计 F4）：filterNotApplicable 把 `{}` 当「不过滤」，而 mirrorMatch 原先只查
  // typeof ⇒ `{}` 被当成"有上下文"，会让 ne/not 型条件在空上下文下静默命中、排除条目。两处口径统一为「空＝不过滤」。
  const naCtx = opts.notApplicable && typeof opts.notApplicable === 'object' && Object.keys(opts.notApplicable).length ? opts.notApplicable : null;
  for (const r of currentRecords(loadStore('mirror', opts.file || storePath('mirror')).records)) {
    if (!keepRole(r) || !keepMeta(r)) continue;
    if (naCtx && r.not_applicable !== undefined && evalCondition(r.not_applicable, naCtx)) continue;   // #3 不适用条件（非法条件由 validateCondition 抛错）
    const fields = MIRROR_TUPLE_FIELDS.map((f, i) => [f, f === 'situation' ? 2 : 1]);
    let score = 0;
    for (const [f, w] of fields) {
      const hay = String(r[f] ?? '').toLowerCase();
      for (const t of tokens) score += matchScore(hay, t) * w;
    }
    if (Array.isArray(r.patterns)) {
      for (const p of r.patterns) {
        const pl = String(p).toLowerCase();
        for (const t of tokens) if (pl.includes(t)) score += 2;
      }
    }
    if (score > 0) {
      hits.push({
        id: r.id, score: +score.toFixed(2),
        role: MIRROR_ROLES.includes(r.role) ? r.role : null,
        evidence: MIRROR_EVIDENCE.includes(r.evidence) ? r.evidence : null,
        era: r.era ?? null, context: r.context ?? null,
        story: r.story ?? '',
        patterns: Array.isArray(r.patterns) ? r.patterns.slice() : [],
        ...mirrorTuple(r)
      });
    }
  }
  // 体裁隔离 P0（2026-10-13 复查补齐②）：mirror 五元组＋story/patterns ＝叙事正文（读侧最易回声的面之一）⇒ 默认剥皮；
  //   反思通道 `opts.reflect` 给原文；只剥符号、不动结构与字段名。
  if (opts.reflect !== true) {
    for (const h of hits) {
      for (const f of ['story', 'situation', 'behavior', 'outcome', 'social_reaction', 'emotion']) {
        if (typeof h[f] === 'string' && h[f]) h[f] = stripGenre(h[f]);
      }
      if (Array.isArray(h.patterns)) h.patterns = h.patterns.map((p) => stripGenre(String(p)));
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}


/** Situation overlap for a mirror record. Shared by mirror match and opt-in lookup gate. */
export function mirrorSituationScore(text, record) {
  const STOP = new Set(['已经', '今天', '现在', '刚刚', '刚才', '还是', '就是', '不是', '没有', '因为', '所以', '但是', '如果', '然后', '可以', '需要', '应该', '觉得', '这个', '那个', '一个', '我们', '你们', '他们']);
  const pieces = new Set();
  for (const token of tokenize(text)) {
    if (token.length >= 2 && !STOP.has(token)) pieces.add(token);
    for (let i = 0; i + 2 <= token.length; i += 1) {
      const piece = token.slice(i, i + 2);
      if (!STOP.has(piece)) pieces.add(piece);
    }
  }
  const situation = String(record?.situation ?? '').toLowerCase();
  const patterns = Array.isArray(record?.patterns) ? record.patterns.join('\n').toLowerCase() : '';
  let situationScore = 0;
  let patternScore = 0;
  for (const token of pieces) {
    if (situation.includes(token)) situationScore += 2;
    else if (patterns.includes(token)) patternScore += 1;
  }
  return { situationScore, patternScore };
}
/** 输出审计 v0（2026-10-07）：抽取疑似库 id → 存在性核对。
 * 只做可机检硬核：引用不存在的库 id = 编造嫌疑（unknownIds）；真实 id = 引用命中（ids，供使用计数线）。 */
const OUTPUT_ID_RE = /\b(canon|front|orphan|mirror|price|lex)-[a-z0-9][a-z0-9-]{4,}/gi;
export function auditText(text) {
  const s = String(text || '');
  const found = [...new Set((s.match(OUTPUT_ID_RE) || []).map((x) => x.toLowerCase()))];
  const all = new Set();
  for (const name of STORES) for (const r of loadStore(name).records) all.add(r.id);
  return {
    ids: found.filter((id) => all.has(id)),
    unknownIds: found.filter((id) => !all.has(id)),
    tagged: (s.match(/学过|接触过|记得·库内|搜到/g) || []).length
  };
}

/** 一条 hooks 记录里点名的库 id（usage.ids，以及 output/result/text 里的 id 形）。不读库。 */
export function recordCitedIds(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const ids = [];
  const push = (id) => { if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id); };
  if (Array.isArray(rec.ids)) for (const id of rec.ids) push(id);
  for (const key of ['output', 'result', 'text']) {
    if (typeof rec[key] !== 'string') continue;
    OUTPUT_ID_RE.lastIndex = 0;
    for (const m of rec[key].match(OUTPUT_ID_RE) || []) push(m.toLowerCase());
  }
  return ids;
}

// —— 召回失败信号（B2 · 2026-10 wave1；会话分区 wave1.1）——
// 双路召回（机械钩子 + 主动查库）漏掉的，只能事后从日志里认出来：某回合出了失败，而失败之前没有任何查库动作。
// 纯机械口径（代码做计数、语义判断留给模型/人）：
//   分区 = 会话 id（宿主真值：tool 线 `session` ← tools/result 的 exec.agent.id；turn-end ← session/event 的 session.id；
//          agent-error ← payload.agent.id——三者同为 DSH 的 SessionId，Agent 以其会话 id 为身份）。前缀 `session-` 归一。
//   窗口 = 同一会话内相邻两条 turn-end 之间；并发会话互不混窗。
//   旧日志兼容：不带 session 的行进「未归属」窗口 `*`（＝旧的全局口径）；任一 turn-end 同时关闭 `*` 窗口；
//          `*` 窗口里的召回对同期任何会话的失败都算数（无法证伪，按宽口径，不夸大漏召）。
//   召回 = 只读查库面成功调用（MCP mcp__akasha__<RECALL_TOOLS>，或 hooks 标注的 akasha CLI 查库子命令 akashaCli）；
//   失败 = 非记忆工具 ok:false 或 agent-error（记忆工具自身失败不算任务失败，也不算召回；gate-denied 不计）；
//   每窗口只看第一次失败：之前查过库 → recalledBefore；没查过 → miss（之后才查 → 另记 lateRecall）。
export const RECALL_TOOLS = Object.freeze(['akasha_lookup', 'akasha_brief', 'akasha_cross', 'akasha_kit', 'akasha_show', 'akasha_summary', 'akasha_mirror_match', 'akasha_session_lookup', 'akasha_frontier_due']);
export const RECALL_CLI = Object.freeze(['lookup', 'brief', 'cross', 'kit', 'show', 'summary', 'mirror-match', 'session-lookup', 'frontier-due']);
const MEMORY_PREFIX = 'mcp__akasha__';

/** 一条 hooks 记录是否为「召回」动作（纯函数）。 */
export function isRecallRecord(rec) {
  if (!rec || rec.kind !== 'tool' || rec.ok === false) return false;
  const tool = String(rec.tool ?? '');
  if (tool.startsWith(MEMORY_PREFIX)) return RECALL_TOOLS.includes(tool.slice(MEMORY_PREFIX.length));
  return typeof rec.akashaCli === 'string' && RECALL_CLI.includes(rec.akashaCli);
}

/** hooks 记录的会话分区键（纯函数）：裸会话 id；缺失 → '*'（未归属，旧日志）。 */
export function sessionKeyOf(rec) {
  const raw = typeof rec?.session === 'string' ? rec.session.trim() : '';
  return raw ? raw.replace(/^session-/, '') : '*';
}

/** 召回失败计数（纯函数；输入为已解析的 hooks 记录，按日志顺序；按会话分区）。 */
export function recallSignals(records, opts = {}) {
  const toolTraps = opts.toolTraps instanceof Set ? opts.toolTraps : null; // C2：已知坑工具集（null＝不判）
  const out = { failureTurns: 0, recalledBefore: 0, misses: 0, lateRecall: 0, missRate: 0, samples: [], sessions: 0, unattributed: 0, byTool: {}, preventable: { fails: 0, missed: 0, missRate: 0 } };
  const wins = new Map();  // key -> { recalled, failed, late, starRecall }
  const seen = new Set();
  const win = (k) => { let w = wins.get(k); if (!w) { w = { recalled: false, failed: null, late: false }; wins.set(k, w); } return w; };
  const close = (k) => {
    const w = wins.get(k);
    wins.delete(k);
    if (!w || !w.failed) return;
    out.failureTurns += 1;
    const tool = String(w.failed.what ?? '?');
    const tally = (out.byTool[tool] ??= { fails: 0, missed: 0, late: 0, preventableMisses: 0 });
    tally.fails += 1;
    const preventable = toolTraps ? toolTraps.has(tool) : null;
    if (preventable === true) out.preventable.fails += 1;
    if (w.recalled) out.recalledBefore += 1;
    else {
      out.misses += 1;
      tally.missed += 1;
      if (w.late) { out.lateRecall += 1; tally.late += 1; }
      if (preventable === true) { out.preventable.missed += 1; tally.preventableMisses += 1; }
      if (out.samples.length < 5) out.samples.push(w.failed);
    }
  };
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== 'object') continue;
    const k = sessionKeyOf(rec);
    if (rec.kind === 'turn-end') { close(k); if (k !== '*') close('*'); continue; }
    if (rec.kind !== 'tool' && rec.kind !== 'agent-error') continue;
    if (k === '*') out.unattributed += 1; else seen.add(k);
    if (isRecallRecord(rec)) {
      const w = win(k);
      if (w.failed) w.late = true; else w.recalled = true;
      if (k === '*') for (const [kk, ww] of wins) if (kk !== '*' && !ww.failed) ww.recalled = true; // 未归属召回：宽口径
      continue;
    }
    // 2026-10-10 口径修正（可预防性测试第 1 步当场发现）：门控拒绝不是任务失败——守卫按设计工作；此前使它灌水（59 条里 11 条属此类）。
    const guardDenied = /门控|gate-denied/.test(String(rec.message ?? ''));
    const isFail = (rec.kind === 'tool' && rec.ok === false && !guardDenied && !String(rec.tool ?? '').startsWith(MEMORY_PREFIX)) || rec.kind === 'agent-error';
    if (!isFail) continue;
    const w = win(k);
    if (w.failed) continue;
    if (!w.recalled && k !== '*' && wins.get('*')?.recalled) w.recalled = true; // 同期未归属召回同样算数
    w.failed = { ts: rec.ts ?? null, what: rec.kind === 'agent-error' ? 'agent-error' : String(rec.tool ?? '?'), session: k === '*' ? null : k };
  }
  for (const k of [...wins.keys()]) close(k);
  out.sessions = seen.size;
  out.missRate = out.failureTurns ? +(out.misses / out.failureTurns).toFixed(3) : 0;
  out.preventable.missRate = out.preventable.fails ? +(out.preventable.missed / out.preventable.fails).toFixed(3) : 0;
  return out;
}

/**
 * C2 v2（2026-10-10，外部评审建议）：**显式"工具→坑条目"映射表**。
 * 为什么换掉 v1：v1 用"工具名在库里有强命中"判定，会把**仅仅提到该工具**的条目也算命中（偏宽）。
 * 口径：列出**已归档、确有该工具坑**的条目 id；判定时校验 id 存在（退役/更名即自动失效，不悬空）。
 * 维护：新坑条目归档后，把 id 加进对应工具；结构性工具（web_fetch/web_search）永不入表。
 */
export const RECALL_TRAP_MAP = Object.freeze({
  // 顺序即优先级：hintForTool 取**第一个**有可用 hint 的候选（2026-10-11）
  pwsh: ['canon-trap-pwsh-inline-js', 'canon-trap-quoting-escapes', 'canon-review-manual-20261010', 'canon-npm-publish-20261010', 'canon-dsh-store-remediation-20261010'],
  bash: ['canon-trap-quoting-escapes', 'canon-review-manual-20261010'],
  edit: ['canon-trap-edit-context-mismatch', 'canon-trap-quoting-escapes', 'canon-review-manual-20261010'],
  write: ['canon-trap-quoting-escapes', 'canon-review-manual-20261010'],
  read: ['canon-trap-read-offset-range', 'canon-review-manual-20261010'],
  grep: ['canon-trap-grep-exit2-path', 'canon-review-manual-20261010'],
  dsh_wsl: ['canon-trap-dsh-wsl-channel', 'canon-review-manual-20261010', 'canon-installability-20261010'],
  codex_exec: ['canon-trap-quoting-escapes', 'canon-review-manual-20261010'],
  apply_patch: ['canon-trap-quoting-escapes', 'canon-review-manual-20261010'],
  'multi_tool_use.parallel': ['canon-trap-unknown-tool-name'],
  cordis_inspect_query: ['canon-trap-provider-method-list'],
});

/** 结构性不可预防（2026-10-10 实测：web_fetch 被误判为可预防）——网络/环境类失败，**任何记忆都不可能预防**。 */
export const RECALL_STRUCTURAL_TOOLS = Object.freeze(['web_fetch', 'web_search']);

/** 已知坑工具集（C2 v2）：映射表 ∩ 结构性豁免之外；条目 id 需在库中存在（否则记 missing 但不判可预防）。 */
export function recallToolTraps(opts = {}) {
  const lib = opts.lib;
  const have = lib ? new Set(currentRecords(lib.loadStore('canon').records).map((r) => String(r.id).replace(/-r\d+$/, ''))) : null;
  const traps = new Set();
  const missing = [];
  for (const [tool, ids] of Object.entries(RECALL_TRAP_MAP)) {
    if (RECALL_STRUCTURAL_TOOLS.includes(tool)) continue;
    if (!have) { traps.add(tool); continue; }
    if (ids.some((id) => have.has(id))) traps.add(tool); else missing.push(tool + ':' + ids.join('|'));
  }
  if (missing.length) try { console.error('[akasha] C2 映射表条目缺失（不判可预防）：' + missing.join(' , ')); } catch { /* 静默 */ }
  return traps;
}

/** I-02 查询监控（2026-10-13，批次 1；C 线 B.1）：每次检索落一行 append-only 侧线（默认 logs/query-log.jsonl）。
 *  纪律：**不碰主流程**——本函数任何失败都吞掉（只回执 ok:false），检索结果与耗时不受影响。
 *  session：宿主当前不给子进程传会话号（bash 环境实测无 DSH_*）⇒ 记 `AKASHA_SESSION_ID` / `DSH_SESSION_ID`（有则写、无则 null）；
 *  归因路径＝用 ts 对 `logs/hooks.jsonl` 的 tool / preflight 线（后验 join，不猜）。
 *  genre_render＝该次结果是否经体裁渲染（剥皮 / 非全文）。反思通道与 depth:full 为 false，用来分清「召回差」还是「剥皮过度」。
 *  关断：调用侧 `queryLog:false`；或环境变量 `AKASHA_QUERY_LOG=off`（自测 / 批量脚本用——防污染真日志）。 */
export function queryLogPathOf(opts = {}) {
  if (opts.queryLog === false) return null;
  if (typeof opts.queryLog === 'string' && opts.queryLog) return opts.queryLog;
  if (String(process.env.AKASHA_QUERY_LOG || '').toLowerCase() === 'off') return null;
  return join(LOGS_DIR, 'query-log.jsonl');
}

/** **读侧**查询日志路径（2026-10-14 整体复检修）：与环境变量 `AKASHA_QUERY_LOG=off` **无关**——那个开关只管「要不要写」，
 *  写侧关了不代表读侧应把已有数据读成 0（实测：metrics 的查询维度与 K3 的矛盾检测计数都被静默读空）。读侧只认 `opts.queryLog`。 */
export function queryLogReadPathOf(opts = {}) {
  if (opts.queryLog === false) return null;
  if (typeof opts.queryLog === 'string' && opts.queryLog) return opts.queryLog;
  return join(LOGS_DIR, 'query-log.jsonl');
}

export function recordQuery(entry = {}, opts = {}) {
  try {
    const file = queryLogPathOf(opts);
    if (!file) return { ok: false, skipped: true };
    const hits = Number(entry.hits) || 0;
    const sid = process.env.AKASHA_SESSION_ID || process.env.DSH_SESSION_ID || null;
    const rec = {
      ts: new Date().toISOString(),
      via: String(opts.via || entry.via || 'lib'),
      cmd: String(entry.cmd || '?'),
      query: redact(String(entry.query ?? '')).slice(0, 200),
      hits, zero: hits === 0,
      ms: Number.isFinite(entry.ms) ? Math.max(0, Math.round(entry.ms)) : null,
      session: sid ? String(sid) : null,
      genre_render: entry.genreRender === true,
      ids: Array.isArray(entry.ids) ? entry.ids.filter(isStr).slice(0, 10) : []
    };
    appendFileSync(file, JSON.stringify(rec) + '\n');
    return { ok: true, file, rec };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 结果计数器 v0（2026-10-07）：hook 线 + 修订链统计 → 可机检指标。 */
/** K3 可复查/可修订·**实际使用计数**（2026-10-14，板条 K3）：复审线（review-log）＋ 退役墓碑 ＋ 近 7 天修订版 ＋
 *  矛盾检测的实际调用（query-log 侧线，cmd=conflict；计数自 2026-10-13 侧线启用起——如实标注窗口）。
 *  只读、只报数，不做任何裁决。数据面注入：`opts.files`（六库文件）/ `opts.reviewLog` / `opts.queryLog` / `opts.today`。 */
export function revisabilityStats(opts = {}) {
  const today = opts.today ? String(opts.today).slice(0, 10) : todayLocal();
  const dayNum = (d) => { const t = Date.parse(String(d ?? '').slice(0, 10) + 'T00:00:00Z'); return Number.isFinite(t) ? Math.floor(t / 86400000) : null; };
  const todayNum = dayNum(today);
  let retired = 0; const retiredByStore = {};
  let revised7d = 0; let lastRevisedAt = null;
  for (const name of STORES) {
    let recs = [];
    try { recs = loadStore(name, opts.files?.[name]).records; } catch { recs = []; }
    if (!recs.length) continue;
    const n = retiredIds(recs).size;
    if (n) { retiredByStore[name] = n; retired += n; }
    for (const r of recs) {
      if (!isStr(r.supersedes)) continue;
      const at = r.logged_at ?? r.event_time ?? null;
      if (at && (!lastRevisedAt || String(at) > String(lastRevisedAt))) lastRevisedAt = at;
      const d = dayNum(at);
      if (d !== null && todayNum !== null && todayNum - d >= 0 && todayNum - d <= 7) revised7d += 1;
    }
  }
  const review = { total: 0, byVerdict: {}, lastAt: null, lastVerdict: null, lastId: null };
  try {
    const rows = readReviewLog({ limit: 100000, ...(opts.reviewLog ? { file: opts.reviewLog } : {}) });
    review.total = rows.length;
    for (const r of rows) { const v = String(r.verdict ?? '?'); review.byVerdict[v] = (review.byVerdict[v] ?? 0) + 1; }
    if (rows.length) { const last = rows[rows.length - 1]; review.lastAt = last.ts ?? null; review.lastVerdict = last.verdict ?? null; review.lastId = last.id ?? null; }
  } catch { /* 失败即空，只报数 */ }
  const calls = { conflict: 0, firstAt: null, lastAt: null, windowNote: '计数自 2026-10-13 查询侧线启用起' };
  const ql = queryLogReadPathOf(opts);   // 读侧路径（不受 AKASHA_QUERY_LOG=off 影响——2026-10-14 复检修）
  if (ql) {
    try {
      for (const l of readFileSync(ql, 'utf8').split(/\r?\n/).filter(Boolean)) {
        let j; try { j = JSON.parse(l); } catch { continue; }
        if (String(j.cmd) !== 'conflict') continue;
        calls.conflict += 1;
        if (!calls.firstAt || String(j.ts) < calls.firstAt) calls.firstAt = j.ts;
        if (!calls.lastAt || String(j.ts) > calls.lastAt) calls.lastAt = j.ts;
      }
    } catch { /* 空 */ }
  }
  return { today, retired, retiredByStore, revised7d, lastRevisedAt, review, calls };
}

export function metrics(opts = {}) {
  const logPath = opts.log || join(LOGS_DIR, 'hooks.jsonl');
  const since = opts.since ? String(opts.since).slice(0, 10) : null;
  let lines = [];
  try { lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean); } catch { lines = []; }
  const counters = { tools: 0, toolErrors: 0, denials: 0, agentErrors: 0, turnEnds: 0, sleeps: 0, wakeNotes: 0, outputAudits: 0, usageRefs: 0 };
  const toolErrorsByName = {}; const usageById = {};
  const memoryByName = {}; let memoryCalls = 0;
  const kept = [];
  for (const raw of lines) {
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (since && String(rec.ts || '').slice(0, 10) < since) continue;
    kept.push(rec);
    if (rec.kind === 'tool') {
      counters.tools += 1;
      const toolName = String(rec.tool ?? '?');
      if (toolName.startsWith('mcp__akasha__')) { memoryCalls += 1; memoryByName[toolName] = (memoryByName[toolName] ?? 0) + 1; }
      if (rec.ok === false) { counters.toolErrors += 1; toolErrorsByName[toolName] = (toolErrorsByName[toolName] ?? 0) + 1; }
    } else if (rec.kind === 'gate-denied') counters.denials += 1;
    else if (rec.kind === 'agent-error') counters.agentErrors += 1;
    else if (rec.kind === 'turn-end') counters.turnEnds += 1;
    else if (rec.kind === 'sleep-done') counters.sleeps += 1;
    else if (rec.kind === 'wake-note') counters.wakeNotes += 1;
    else if (rec.kind === 'output-audit') counters.outputAudits += 1;
    else if (rec.kind === 'usage' && Array.isArray(rec.ids)) {
      counters.usageRefs += rec.ids.length;
      for (const id of rec.ids) usageById[id] = (usageById[id] ?? 0) + 1;
    }
  }
  // I-02 查询维度（2026-10-13 批次 1）：读查询侧线（默认 logs/query-log.jsonl；`opts.queryLog` 可注入 / 关断）。
  let qEntries = [];
  try {
    const qf = queryLogReadPathOf({ queryLog: opts.queryLog });   // 读侧路径（不受 AKASHA_QUERY_LOG=off 影响——2026-10-14 复检修）
    if (qf) {
      for (const raw of readFileSync(qf, 'utf8').split(/\r?\n/).filter(Boolean)) {
        let rec; try { rec = JSON.parse(raw); } catch { continue; }
        if (since && String(rec.ts || '').slice(0, 10) < since) continue;
        qEntries.push(rec);
      }
    }
  } catch { qEntries = []; }
  const qByCmd = {}; const qTop = {}; const qHot = {};
  let qZero = 0, msSum = 0, msN = 0, sessKnown = 0, refWith = 0, refHit = 0, qRetrieval = 0;
  // 2026-10-14 复检举一反三：**检索面指标只统计检索类调用**——K3 起 `conflict`（及未来诊断类）也走 query-log，
  //   若混入，零结果率/高频 top/引用率会被诊断调用污染（conflict 常在 hits=0 时记 zero:true）。byCmd 仍全量展示。
  const RETRIEVAL_CMDS = new Set(['lookup', 'brief', 'cross', 'recall']);
  let qProbe = 0;
  for (const rec of qEntries) {
    const cmdName = String(rec.cmd || '?'); qByCmd[cmdName] = (qByCmd[cmdName] ?? 0) + 1;
    if (!RETRIEVAL_CMDS.has(cmdName)) continue;
    // 2026-10-14 复检举一反三（第二处）：**机制探针（via:'probe'，睡眠器处境/指代检索）分流**——它们由宿主每回合自动跑、
    //   查询词是原话/工具名，会把高频 top 灌成噪声（实测同一长句 ×20）。计入 probes，不进检索面指标；历史行无标记不可追溯（如实）。
    if (String(rec.via || '') === 'probe') { qProbe += 1; continue; }
    qRetrieval += 1;
    if (rec.zero === true) qZero += 1;
    if (Number.isFinite(rec.ms)) { msSum += rec.ms; msN += 1; }
    const qk = String(rec.query || '').trim();
    if (qk) qTop[qk] = (qTop[qk] ?? 0) + 1;
    const ids = Array.isArray(rec.ids) ? rec.ids : [];
    if (ids.length) { refWith += 1; if (ids.some((id) => usageById[id])) refHit += 1; }
    for (const id of ids) qHot[id] = (qHot[id] ?? 0) + 1;
    if (rec.session) sessKnown += 1;
  }
  const qMin = Number.isInteger(opts.querySampleMin) ? opts.querySampleMin : 5;
  const queries = {
    total: qEntries.length,
    retrieval: qRetrieval,
    probes: qProbe,
    byCmd: qByCmd,
    zero: qZero,
    zeroRate: qRetrieval ? +(qZero / qRetrieval).toFixed(4) : null,
    avgMs: msN ? Math.round(msSum / msN) : null,
    topQueries: Object.entries(qTop).sort((a, b) => b[1] - a[1]).slice(0, 8),
    hotIds: Object.entries(qHot).sort((a, b) => b[1] - a[1]).slice(0, 10),
    referenced: { n: refHit, of: refWith, usageRefs: counters.usageRefs, minSample: qMin, rate: (refWith >= qMin && counters.usageRefs > 0) ? +(refHit / refWith).toFixed(4) : null, note: '近似：该次命中 id 是否出现在本窗口 usage 线（全域集合，不按时序先后）；样本 < ' + qMin + ' 或 usage 线为空 ⇒ null（不冒充）' },
    sessionCoverage: { known: sessKnown, total: qRetrieval, note: '检索面口径（lookup/brief/cross/recall）；会话号缺失＝宿主未把 session 传给子进程（用 ts 对 hooks 工具线归因）' }
  };
  let revisions = 0; let longest = 0; let longestId = null;
  for (const name of STORES) {
    const recs = loadStore(name).records;
    const byId = new Map(recs.map((r) => [r.id, r]));
    for (const r of recs) {
      if (!r.supersedes) continue;
      revisions += 1;
      let d = 1; let cur = r;
      while (cur.supersedes && byId.has(cur.supersedes)) { cur = byId.get(cur.supersedes); d += 1; if (d > 5000) break; }
      if (d > longest) { longest = d; longestId = r.id; }
    }
  }
  return {
    at: new Date().toISOString(), since, counters,
    memoryTools: {
      calls: memoryCalls,
      share: +(memoryCalls / Math.max(1, counters.tools)).toFixed(3),
      perTurn: +(memoryCalls / Math.max(1, counters.turnEnds)).toFixed(2),
      byTool: memoryByName
    },
    recall: recallSignals(kept, { toolTraps: recallToolTraps({ lib: { loadStore, currentRecords } }) }),
    queries,
    topToolErrors: Object.entries(toolErrorsByName).sort((a, b) => b[1] - a[1]).slice(0, 5),
    topUsage: Object.entries(usageById).sort((a, b) => b[1] - a[1]).slice(0, 10),
    revisions: { count: revisions, longest, longestId },
    revisability: revisabilityStats(opts)
  };
}

/** #28 外置 policy + #34 directive 级门控清单（2026-10-12 窗口 4）。
 *  设计：**默认内嵌**（与 gate 现行为一致的硬拦面，外加 ops_* 补面）；`policy.json`（默认 `akasha/policy.json`，可用 `opts.file` 覆盖）
 *  存在则**并集合并**（默认 ∪ 外置——外置只许更严，不许放宽默认）；**空策略 ⇒ 记 warnings，绝不假装合规**（灵枢金句照搬）。
 *  只读：本模块只做「策略加载与匹配」，真正的拦截在 gate（消费同一份规则）。 */
export const POLICY_DEFAULTS = Object.freeze({
  writeTools: Object.freeze(['edit', 'write', 'apply_patch', 'ops_replace']),
  shellTools: Object.freeze(['pwsh', 'bash', 'dsh_wsl', 'ops_bash']),
  forbidden: Object.freeze([Object.freeze({
    id: 'akasha-data-direct-write',
    pattern: '(^|/)akasha/data/.+\\.jsonl$',
    why: '数据只经校验写入（akasha CLI / MCP 工具）——直写会被门控拒绝'
  })]),
  required: Object.freeze([]),
  directives: Object.freeze([
    Object.freeze({ id: 'data-direct-write', level: 'gate', text: '禁直写 akasha\\data\\*.jsonl（gate 硬拦）' }),
    Object.freeze({ id: 'irreversible-backup', level: 'soft', text: '不可逆操作前先备份（软提示：观察期沿用）' })
  ])
});

/** 读 policy.json（缺文件/坏 JSON ⇒ 用默认并记 warnings）；外置与默认**并集**（只严不宽）。 */
export function loadPolicy(opts = {}) {
  const file = opts.file || join(ROOT, 'policy.json');
  const warnings = [];
  const merged = {
    writeTools: [...POLICY_DEFAULTS.writeTools],
    shellTools: [...POLICY_DEFAULTS.shellTools],
    forbidden: POLICY_DEFAULTS.forbidden.map((f) => ({ ...f })),
    required: [...POLICY_DEFAULTS.required],
    directives: POLICY_DEFAULTS.directives.map((d) => ({ ...d })),
    source: 'default',
    warnings
  };
  let raw = null;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) {
    if (e && e.code !== 'ENOENT') warnings.push('policy 文件存在但不可用（' + e.message + '）⇒ 回退默认');
    return merged;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warnings.push('policy 形状非法（须为对象）⇒ 回退默认'); return merged; }
  const addAll = (field, extra, uniq) => {
    if (extra === undefined) return;
    if (!Array.isArray(extra)) { warnings.push('policy.' + field + ' 须为数组'); return; }
    for (const x of extra) { const key = uniq(x); if (key !== null && !merged[field].includes(key)) merged[field].push(key); }
  };
  addAll('writeTools', raw.writeTools, (x) => (typeof x === 'string' && x.trim() ? x.trim() : null));
  addAll('shellTools', raw.shellTools, (x) => (typeof x === 'string' && x.trim() ? x.trim() : null));
  if (raw.forbidden !== undefined) {
    if (!Array.isArray(raw.forbidden)) warnings.push('policy.forbidden 须为数组');
    else for (const f of raw.forbidden) {
      if (!f || typeof f !== 'object' || !isStr(f.pattern)) { warnings.push('forbidden 条目缺 pattern（已跳过）'); continue; }
      if (merged.forbidden.some((x) => x.id === f.id || x.pattern === f.pattern)) continue;
      merged.forbidden.push({ id: isStr(f.id) ? f.id : ('external-' + merged.forbidden.length), pattern: String(f.pattern), why: isStr(f.why) ? f.why : '（外置规则）' });
    }
  }
  if (Array.isArray(raw.required)) merged.required.push(...raw.required.filter((x) => typeof x === 'string'));
  const noRules = merged.writeTools.length === 0 && merged.forbidden.length === 0;
  if (noRules) merged.warnings.push('空策略：没有可用规则 ⇒ **不假装合规**（须显式处置）');
  else if ((Array.isArray(raw.forbidden) && raw.forbidden.length === 0) || (Array.isArray(raw.writeTools) && raw.writeTools.length === 0)) {
    merged.warnings.push('空策略面：外置某面为空（已用默认兜底，勿视为"无限制"）');
  }
  merged.source = 'default+file';
  return merged;
}

export function isWriteTool(name, policy = null) {
  const p = policy && Array.isArray(policy.writeTools) ? policy : loadPolicy();
  return p.writeTools.includes(String(name));
}

/** 命中 forbidden（或未满足 required）⇒ 返回理由字符串；否则 null（不误伤）。
 *  匹配前把目标里的 `\` 归一为 `/`（正则只需写正斜杠，避免双重转义地狱）；规则 pattern 同样归一。 */
export function policyDeny(target, policy = null) {
  const p = policy && Array.isArray(policy.forbidden) ? policy : loadPolicy();
  const s = String(target ?? '').replace(/\\/g, '/');
  for (const f of p.forbidden) {
    let re = null;
    try { re = new RegExp(String(f.pattern).replace(/\\\\/g, '/'), 'i'); } catch { continue; }
    if (re.test(s)) return (f.why ? f.why + ' · ' : '') + 'rule:' + (f.id ?? f.pattern);
  }
  return null;
}

/** #33 show --expand（2026-10-12 窗口 5）：沿 `promoted_from` 回溯源头（只读）。
 *  返回 { found, id, store, origin, chain, note }；**悬空如实**（会话文件缺失/段不存在都不编，只标 dangling）。 */
export function expandRecord(store, id, opts = {}) {
  if (!STORES.includes(store)) throw new Error('未知存储：' + store);
  const file = (opts.files && opts.files[store]) || opts.file || storePath(store);
  const records = loadStore(store, file).records;
  const byId = new Map(records.filter((r) => isStr(r.id)).map((r) => [r.id, r]));
  let tip = byId.get(String(id));
  if (!tip) {                                         // 允许用旧版 id 命中链尾
    const any = records.find((r) => String(r.id) === String(id));
    if (!any) return { found: false, id: String(id), store, origin: null, chain: [], note: '未找到该 id（链上任意版本都没有）' };
    tip = any;
  }
  const seenTip = new Set([tip.id]);
  for (;;) { const next = records.find((r) => isStr(r.supersedes) && r.supersedes === tip.id); if (!next || seenTip.has(next.id)) break; seenTip.add(next.id); tip = next; }
  const sessionFile = opts.sessionFile !== undefined ? opts.sessionFile : join(DATA, 'session.jsonl');
  const segs = new Set();
  try { for (const r of loadStore('session', sessionFile).records) if (isStr(r.id)) segs.add(r.id); } catch { /* 文件缺失 ⇒ 全部标 dangling */ }
  const chain = [];
  let cur = tip; const seen = new Set();
  while (cur && isStr(cur.id) && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.promoted_from && typeof cur.promoted_from === 'object') {
      const p = cur.promoted_from;
      chain.push({ from: cur.id, store: p.store ?? null, id: p.id ?? null, session: p.session ?? null, seq: Number.isInteger(p.seq) ? p.seq : null, at: p.at ?? null,
        dangling: !(p.id && segs.has(String(p.id))) });
    }
    cur = isStr(cur.supersedes) ? byId.get(cur.supersedes) : null;
  }
  const origin = chain[0] ?? null;
  return { found: true, id: tip.id, store, origin, chain,
    note: origin
      ? (origin.dangling ? '源段不在 session.jsonl（悬空，如实标注）——可用 ptr 回原档核对' : '源段在会话层；全保真＝用 ptr 回原档（session lookup / session node）')
      : '无 promoted_from（本来就是原生条目，没有更深的源）' };
}

/** #36 fail-loud（2026-10-12 窗口 5）：数据根不健康 ⇒ **报错**，绝不静默"建空库装健康"（灵枢启示）。
 *  判据：目录存在 + 至少一个库文件存在；否则抛（带路径与修复提示）。挂载在 CLI 入口（`akasha.mjs` 启动时调用）。 */
export function assertDataRoot(dir = DATA) {
  const d = String(dir);
  if (!existsSync(d)) throw new Error('数据根不存在/不可用：' + d + '（拒绝静默建空库——请检查 AKASHA_ROOT 或先跑初始化器）');
  let hasAny = false;
  for (const s of STORES) if (existsSync(join(d, s + '.jsonl'))) { hasAny = true; break; }
  if (!hasAny) throw new Error('数据根缺少库文件：' + d + '（目录在但没有任何 *库*.jsonl ⇒ 读出来是空库，拒绝当前装作健康；先跑初始化器或指定正确根）');
  return true;
}

/** #2 负记忆两层（2026-10-12 窗口 6）：**被拒的写入**与**未决**独立留档（只记 kind/reason/短描述，不记正文）。
 *  用途：让"这条路走不通"成为可查资产（失败回查的原料）；与六库分隔（`negative.jsonl`，不进 STORES、不参与检索排序）。 */
export const NEGATIVE_KINDS = Object.freeze(['rejected-write', 'undecided']);
export function recordRejected(rec, opts = {}) {
  const kind = String(rec?.kind ?? '');
  if (!NEGATIVE_KINDS.includes(kind)) throw new Error('negative.kind 须为 ' + NEGATIVE_KINDS.join('/'));
  if (!isStr(rec?.reason)) throw new Error('negative.reason 必填（非空字符串）');
  const file = opts.file || join(DATA, 'negative.jsonl');
  const what = typeof rec.what === 'string' ? rec.what.slice(0, 200) : '';
  // 2026-10-18（GPT③ 残余 / #13）：negative 是**日志面**（不是六库）——不拒写，但至少要脱敏；
  //   旧实现原样落盘（VERIFY-H 实证 negative.jsonl 可原样收 sk-）。
  const out = redactDeep({ id: 'neg-' + createHash('md5').update(kind + '|' + String(rec.reason) + '|' + what + '|' + Date.now()).digest('hex').slice(0, 8), ts: new Date().toISOString(), kind, reason: String(rec.reason), what, ref: isStr(rec.ref) ? rec.ref : '' });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(out) + '\n', 'utf8');
  return out;
}
export function listRejected(opts = {}) {
  const file = opts.file || join(DATA, 'negative.jsonl');
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; }
  const out = [];
  for (const l of lines) { try { const r = JSON.parse(l); if (!opts.kind || r.kind === opts.kind) out.push(r); } catch { /* 坏行跳过 */ } }
  return out;
}

/** #4 BLINDSPOT 显式化（2026-10-12 窗口 6）：回答自带「这次没检的面」——不静默省略（对齐"确定不知道"的诚实口径）。 */
export function blindspotsFor(opts = {}) {
  const out = [];
  out.push({ what: '会话层（session 层）', why: '本入口只查六库（单入口设计）', action: '要查会话细节用 session lookup / session node' });
  out.push({ what: '外网检索', why: '宿主未接（search 契约已备、未实现）', action: '需要时按来源态「搜到」标注，勿当作库内证据' });
  if (opts.perspective) out.push({ what: '未标 perspective 的条目', why: '本轮按 perspective=' + opts.perspective + ' 过滤，缺标条目不参与', action: '要全量看就别带 --perspective' });
  return out;
}

/** #15 来源态校准（2026-10-12 窗口 7；外部对照启发：灵枢 metacognition）。
 *  输入：`[{confidence: 0..1（自报把握）, correct: bool（实测对不对）}]`；输出：`{gap, ece, buckets, bucketsUsed, n, ok, note}`。
 *  判据：**gap = 平均自报 − 实际正确率**（>0 = 过度自信）；`ECE = Σ(桶占比 × |桶内实际 − 桶内自信|)`。
 *  纪律：样本 < minN ⇒ `gap/ece = null` 且 `ok = null`（**绝不冒充 PASS**）。只读、纯函数。 */
export function calibrationOf(rows, opts = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.confidence === 'number' && typeof r.correct === 'boolean');
  const n = list.length;
  const minN = Number.isInteger(opts.minN) ? opts.minN : 10;
  const nb = Number.isInteger(opts.buckets) && opts.buckets > 0 ? opts.buckets : 5;
  if (n < minN) return { n, minN, buckets: [], bucketsUsed: 0, gap: null, ece: null, ok: null, note: '样本不足（' + n + ' < ' + minN + '）⇒ 不报读数（不冒充 PASS）' };
  const buckets = [];
  for (let i = 0; i < nb; i += 1) buckets.push({ lo: +(i / nb).toFixed(4), hi: +((i + 1) / nb).toFixed(4), n: 0, sumConf: 0, sumCorrect: 0, expected: null, actual: null });
  let meanConf = 0, correctN = 0;
  for (const r of list) {
    meanConf += r.confidence;
    if (r.correct) correctN += 1;
    const idx = Math.min(nb - 1, Math.max(0, Math.floor(r.confidence * nb)));
    const b = buckets[idx];
    b.n += 1; b.sumConf += r.confidence; b.sumCorrect += r.correct ? 1 : 0;
  }
  meanConf /= n;
  const actual = correctN / n;
  const gap = +(meanConf - actual).toFixed(4);
  let ece = 0;
  const used = [];
  for (const b of buckets) {
    if (!b.n) continue;
    b.expected = +(b.sumConf / b.n).toFixed(4);
    b.actual = +(b.sumCorrect / b.n).toFixed(4);
    ece += (b.n / n) * Math.abs(b.actual - b.expected);
    used.push(b);
  }
  return { n, minN, buckets: used, bucketsUsed: used.length, meanConf: +meanConf.toFixed(4), actual: +actual.toFixed(4), gap, ece: +ece.toFixed(4), ok: true, note: gap > 0.05 ? '过度自信（gap>0.05）' : (gap < -0.05 ? '欠自信' : '校准良好（|gap|≤0.05）') };
}

/** 强否定/反事实标记（#25；与「冲突检测」同一套显式撤回词，避免高频字误伤）。 */
const NEGATION_MARKERS = ['作废', '失效', '不再成立', '已废弃', '已放弃', '已推翻', '已排除', '被拒', '拒绝采纳', '撤回', '取消采用', '不采用', '不可用'];
/** #25 否定/反事实降权（2026-10-12 窗口 7）：条款含强否定 ⇒ 返回 <1 的系数（只进排序、不隐藏）。
 *  **默认关**（`lookup --negation-penalty` 才开）：修正不替代（A5）。 */
export function negationPenalty(text) {
  const s = String(text ?? '');
  const hits = NEGATION_MARKERS.filter((m) => s.includes(m));
  if (!hits.length) return 1;
  return +(0.75 ** Math.min(3, hits.length)).toFixed(4);   // 0.75 / 0.5625 / 0.4219，最多三档
}

/** #26 渐进式检索（2026-10-12 窗口 7；外部对照启发：灵枢 progressive.py）。
 *  宽（原查询）→ 逐步收窄（词数递减 + 去停用词）⇒ 每步实际跑 lookup 并计数；空/无效查询 ⇒ `deferred:true`（**DEFER ≠ 失败**）。 */
export function progressiveRecall(query, opts = {}) {
  const raw = String(query ?? '').trim();
  if (!raw) return { query: raw, steps: [], deferred: true, note: '空查询：DEFER（不是失败——给个主题词再跑）' };
  const tokens = tokenize(raw);
  if (!tokens.length) return { query: raw, steps: [], deferred: true, note: '无可检索词：DEFER（不是失败）' };
  const variants = [tokens];
  if (tokens.length >= 2) variants.push(tokens.slice(0, Math.ceil(tokens.length / 2)));
  if (tokens.length >= 3) variants.push(tokens.slice(0, 2));
  if (tokens.length >= 2) variants.push([tokens[0]]);
  const steps = [];
  const seen = new Set();
  for (const v of variants) {
    const q = v.join(' ');
    if (seen.has(q)) continue;
    seen.add(q);
    const r = lookupDetailed(q, { ...opts, contextBudget: false, __noQueryLog: true });   // I-02：分步探测不逐条落侧线（那会把监控淹掉）
    steps.push({ query: q, tokens: v.length, hits: r.hits.length, strong: r.hits.filter((h) => h.strong).length, stance: r.knowledge?.stance ?? null });
  }
  const last = steps[steps.length - 1];
  const converged = steps.length === 1 || (last.hits > 0 && last.hits <= 5);
  return { query: raw, steps, deferred: false, converged, note: converged ? '已收窄到可用面（' + last.hits + ' 条）' : '宽面仍偏大：可继续加条件或换词（DEFER 亦可）' };
}

/** #23 写入回执统一（2026-10-12 窗口 8；外部对照：灵枢把「受理」与「落盘」拆开）。
 *  语义：任何写入类调用的回执 `{ok, committed, id, reason}`——**committed=false 不得口头说「已收入」**。
 *  本函数只做**形状归一**（把已有返回值/异常统一成四元组），不改写路径本身。 */
export function committedOf(result, opts = {}) {
  if (result && typeof result === 'object' && 'committed' in result && 'ok' in result && 'reason' in result) return result;
  const id = (result && typeof result === 'object' && (result.id ?? result.record?.id ?? null)) || opts.id || null;
  return { ok: true, committed: true, id, reason: null };
}

/** #24 代际指纹（2026-10-12 窗口 8；外部对照：灵枢 cg(op=info)）。
 *  `code_generation` = 本进程启动时核心模块的源指纹（模块加载即算）；
 *  `disk_generation` = 当前盘上源指纹；不一致 ⇒ `stale_on_disk:true` + `restart_required:true`（提醒"跑的是旧代码"）。 */
const CORE_FILES = ['lib.mjs', 'session.mjs', 'sleep.mjs', 'json-redaction.mjs'];
function coreFingerprint(useMtime) {
  const parts = [];
  for (const f of CORE_FILES) {
    const p = join(ROOT, f);
    try {
      if (useMtime) parts.push(f + ':' + Math.round(statSync(p).mtimeMs));
      else parts.push(f + ':' + createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12));
    } catch { parts.push(f + ':missing'); }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
export const CODE_GENERATION = coreFingerprint(true);   // 模块加载时快照（进程内恒定）
export function generationInfo() {
  const disk = coreFingerprint(true);
  const stale = disk !== CODE_GENERATION;
  return {
    code_generation: CODE_GENERATION,
    disk_generation: disk,
    stale_on_disk: stale,
    restart_required: stale,
    note: stale
      ? '核心模块在本进程启动后有改动 ⇒ 跑的是旧代码；重启宿主/CLI 才能换代'
      : '代码与盘上一致（无需重启）'
  };
}

/** #16 盲区地图（2026-10-12 窗口 9）：给一批查询词，标出**零命中/弱命中**的（法定输出）。
 *  分级：`blind`（无强命中）· `thin`（强命中 < minStrong 但有弱命中）· `covered`（强命中足）。
 *  只读；每条带 `reason/action`（可执行），总给 `summary`（不静默）。 */
export function blindspotMap(queries, opts = {}) {
  const minStrong = Number.isInteger(opts.minStrong) ? opts.minStrong : 1;
  const list = (Array.isArray(queries) ? queries : [queries]).map((q) => String(q ?? '').trim()).filter(Boolean);
  const blind = [];
  for (const q of list) {
    const r = lookupDetailed(q, { ...opts, contextBudget: false, __noQueryLog: true });   // I-02：盲区地图是批量探测，不落侧线
    const strong = r.hits.filter((h) => h.strong).length;
    const weak = r.hits.length - strong;
    let level = 'covered';
    if (strong === 0) level = 'blind';
    else if (strong < minStrong) level = 'thin';
    blind.push({
      query: q, level, hits: r.hits.length, strong, weak,
      stance: r.knowledge?.stance ?? null,
      reason: level === 'blind' ? '无强命中（整词未命中）：可能是库内确实没有，或词面不同（换词/别名再试）'
        : (level === 'thin' ? '强命中不足（仅 ' + strong + ' 条）' : '有强命中'),
      action: level === 'covered' ? '正常用（引用 citeAllowlist 内的 id）'
        : '换用 progressiveRecall 分步收窄，或按「外网检索未接」标注来源态；确认是缺口就落 orphan'
    });
  }
  const blindCount = blind.filter((x) => x.level === 'blind').length;
  const thinCount = blind.filter((x) => x.level === 'thin').length;
  return { blind, summary: { total: blind.length, blindCount, thinCount, covered: blind.length - blindCount - thinCount,
    note: (blindCount + thinCount) ? ('有 ' + (blindCount + thinCount) + ' 条查询落在盲区/薄弱区——这是**法定输出**（不许静默省略）') : '全部查询有强命中' } };
}

/** #27 纪律单源渲染（2026-10-12 窗口 9；外部对照启发：灵枢单源纪律 + 渲染/校验双脚本）。
 *  **单源**＝下面 `DISCIPLINE` 对象；`renderDiscipline()` 出 Markdown；`verifyDiscipline(text)` 校验产物是否漂移。 */
export const DISCIPLINE = Object.freeze({
  version: 'discipline/2026-10-12.1',
  sections: Object.freeze([
    Object.freeze({ id: 'source-state', title: '来源态', items: Object.freeze(['事实性断言尽量带来源态：学过 / 接触过 / 记得·库内 / 搜到', '未标注按「学过」（未核验）处理']) }),
    Object.freeze({ id: 'ranking-nail', title: '排序钉子', items: Object.freeze(['无据的确定 ≪ 有据的不确定', '编造比承认不知道更糟']) }),
    Object.freeze({ id: 'red-line', title: '红线', items: Object.freeze(['零编造（一票否决）']) }),
    Object.freeze({ id: 'bounds', title: '库界', items: Object.freeze(['库无界·装载有界', '修订链：追加不改原文', '先注册判据再读数据·作者不自证']) }),
    Object.freeze({ id: 'write-path', title: '写入', items: Object.freeze(['数据只经校验写入（akasha CLI / MCP）；直写 data 会被门控拒绝', '写入回执看 committed（未落盘不得口头「已收入」）']) })
  ])
});
export function renderDiscipline() {
  const out = ['# 阿卡夏·纪律（单源渲染 · ' + DISCIPLINE.version + '）', '', '> 本文件由 `renderDiscipline()` 从单源生成；**勿手改**——改纪律请改单源并用 `discipline --check` 校验。', ''];
  for (const s of DISCIPLINE.sections) {
    out.push('## ' + s.title);
    for (const it of s.items) out.push('- ' + it);
    out.push('');
  }
  return out.join('\n');
}
export function verifyDiscipline(text) {
  const expect = renderDiscipline();
  const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
  if (norm(text) === norm(expect)) return { ok: true, version: DISCIPLINE.version, reason: null };
  const a = norm(expect).split('\n');
  const b = norm(text).split('\n');
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) diffs.push({ line: i + 1, expected: a[i] ?? null, actual: b[i] ?? null });
  return { ok: false, version: DISCIPLINE.version, diffs: diffs.slice(0, 10), reason: '产物与单源不一致（漂移）：' + diffs.length + ' 处差异' };
}

/** 到期复审只看当前版本（旧版 next_review 不报）。 */
export function frontierDue(today = todayLocal()) {
  return currentRecords(loadStore('frontier').records).filter((r) => r.next_review && r.next_review <= today);
}

/** I-01 复审到期清单原型（2026-10-13，批次 1；C 线 A.2）：把 `frontier due` 的机制泛化到全库。
 *  口径＝「信任级 × 时龄」：核心（T1 复现 / T2 实验，及渲染进提示的条目）30 天；一般（T3–T5）90 天；其余兜底年审 365 天。
 *  时龄锚 = last_reviewed → event_time → logged_at → created；无锚 ⇒ undated（如实三分，不静默）。
 *  只读：不写库、不裁决——输出供**人工核**（原型阶段；闭环自动化 = I-10，冻结期后）。 */
export const REVIEW_DEFAULTS = Object.freeze({
  coreDays: 30, generalDays: 90, annualDays: 365,
  stores: Object.freeze(['canon', 'mirror', 'orphan', 'pricing', 'lexicon'])
});

export function reviewDue(opts = {}) {
  const policy = { ...REVIEW_DEFAULTS, ...(opts.policy || {}) };
  const today = String(opts.today || todayLocal()).slice(0, 10);
  const dayOf = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const stores = Array.isArray(opts.stores) && opts.stores.length ? opts.stores : policy.stores;
  const items = []; const undated = [];
  let scanned = 0;
  for (const name of stores) {
    if (!STORES.includes(name)) continue;
    for (const r of currentRecords(recordsOf(name, opts))) {
      if (!isStr(r.id)) continue;
      scanned += 1;
      // 渲染进提示的条目（用法条 / 自我层）＝最高看读强度 ⇒ 与核心同档（信任分级不豁免复审）。
      const rendered = name === 'canon' && (isProtocolId(r.id) || (Array.isArray(r.tags) && r.tags.map(String).includes('自我')));
      const tier = name === 'canon' && r.source ? (TIER_OF_SOURCE[r.source.type] ?? null) : null;
      const intervalDays = rendered || tier === 'T1' || tier === 'T2' ? policy.coreDays : (tier ? policy.generalDays : policy.annualDays);
      let anchor = null;
      for (const k of ['last_reviewed', 'event_time', 'logged_at', 'created']) { const d = dayOf(r[k]); if (d) { anchor = { field: k, day: d }; break; } }
      const row = {
        store: name, id: r.id, tier, cls: rendered ? 'rendered' : (tier ? 'tier' : 'fallback'),
        anchor: anchor ? anchor.field : null, anchorDay: anchor ? anchor.day : null, intervalDays
      };
      if (!anchor) { undated.push(row); continue; }
      row.ageDays = Math.floor((Date.parse(today) - Date.parse(anchor.day)) / 86400000);
      row.overdueDays = Math.max(0, row.ageDays - intervalDays);
      if (row.ageDays > intervalDays) items.push(row);
    }
  }
  items.sort((a, b) => (b.overdueDays - a.overdueDays) || a.store.localeCompare(b.store) || String(a.id).localeCompare(String(b.id)));
  return {
    today, policy, counts: { scanned, due: items.length, undated: undated.length },
    items, undated: undated.slice(0, 20)
  };
}

// ── 批次 1 诊断工具（2026-10-13）：I-03 记忆 diff + I-04 矛盾显现 ──

/** 取日期前缀（YYYY-MM-DD）；非字符串/非日期 ⇒ null。 */
function daySlice(v) {
  if (typeof v !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}/.test(v)) return null;
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) return v;              // 纯日期：作者原样
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v.slice(0, 10) : todayLocal(d);  // ISO 时刻：本地日切
}

/** 两版之间「改了什么」（字段级）。id / supersedes / logged_at 是修订机制本身的字段，不算内容变化。 */
function diffFields(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    if (k === 'id' || k === 'supersedes' || k === 'logged_at') continue;
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out.push(k);
  }
  return out.sort();
}

/** I-03 记忆 diff（2026-10-13，批次 1；B 线 P1-①）：对比任意两时点，输出「库变了什么」。
 *  轴＝logged_at（何时被写 / 被改）；缺戳回退 event_time（记 anchor）；两无 ⇒ 不入窗、计入 undated（如实三分，不静默）。
 *  窗口按日、**含两端**（本地日）。分类：added（链根）/ revised（修订版，附与前一版的变化字段）/ retired（墓碑）。
 *  只读——不改数据。 */
export function memoryDiff(opts = {}) {
  const today = todayLocal();
  const since = String(opts.since || opts.from || today).slice(0, 10);
  const until = String(opts.until || opts.to || since).slice(0, 10);
  if (!(Date.parse(since) <= Date.parse(until))) throw new Error('diff 窗口非法：since > until（' + since + ' > ' + until + '）');
  const stores = (Array.isArray(opts.stores) && opts.stores.length ? opts.stores : STORES).filter((n) => STORES.includes(n));
  const lineOf = (name, r) => String(PRIMARY_LINE[name] ? PRIMARY_LINE[name](r) : '').slice(0, 84);
  const out = {}; const totals = { added: 0, revised: 0, retired: 0, revoked: 0, undated: 0 };
  for (const name of stores) {
    const records = recordsOf(name, opts);
    const byId = new Map(records.filter((r) => isStr(r.id)).map((r) => [r.id, r]));
    const b = { added: [], revised: [], retired: [], revoked: [], undated: { count: 0, samples: [] } };
    for (const r of records) {
      if (!isStr(r.id)) continue;
      const day = daySlice(r.logged_at) || daySlice(r.event_time);
      const anchor = daySlice(r.logged_at) ? 'logged_at' : (daySlice(r.event_time) ? 'event_time' : null);
      // 2026-10-14 整体复检修：**撤销记录（revokes）单列一类**——此前落进 'added'，复核时间线会把「撤销退役」误读成「新增条目」。
      const kind = r.revokes !== undefined ? 'revoked' : (r.retires !== undefined ? 'retired' : (isStr(r.supersedes) ? 'revised' : 'added'));
      if (!day) { b.undated.count += 1; if (b.undated.samples.length < 5) b.undated.samples.push({ id: r.id, kind }); continue; }
      if (day < since || day > until) continue;
      if (kind === 'retired') b.retired.push({ id: r.id, target: r.retires, day, anchor, reason: r.retired_reason ?? null });
      else if (kind === 'revoked') b.revoked.push({ id: r.id, target: r.revokes, day, anchor, reason: r.revoked_reason ?? null });
      else if (kind === 'revised') {
        const prev = byId.get(r.supersedes);
        b.revised.push({ id: r.id, supersedes: r.supersedes, day, anchor, changed: prev ? diffFields(r, prev) : null, line: lineOf(name, r) });
      } else b.added.push({ id: r.id, day, anchor, line: lineOf(name, r) });
    }
    const byDay = (x, y) => (x.day === y.day ? String(x.id).localeCompare(String(y.id)) : (x.day < y.day ? -1 : 1));
    b.added.sort(byDay); b.revised.sort(byDay); b.retired.sort(byDay); b.revoked.sort(byDay);
    totals.added += b.added.length; totals.revised += b.revised.length; totals.retired += b.retired.length; totals.revoked += b.revoked.length; totals.undated += b.undated.count;
    out[name] = b;
  }
  return { since, until, stores: out, totals };
}

/** I-04-a 修订链对比视图（2026-10-13，批次 1）：把一条链（含墓碑）按时序摆开，逐步标「这一步改了什么」。
 *  入参可用任意版本 id **或**链根 id；跨库查找；找不到 ⇒ null。只读。 */
export function chainView(id, opts = {}) {
  if (!isStr(id)) return null;
  const rootOf = (s) => String(s).replace(/-retired$/i, '').replace(/-r\d+[a-z]*$/i, '');   // 兼容 -rN 与 -rNsr 后缀
  for (const name of STORES) {
    const records = recordsOf(name, opts);
    const byId = new Map(records.filter((r) => isStr(r.id)).map((r) => [r.id, r]));
    const rec = byId.get(id) || records.find((r) => rootOf(r.id) === rootOf(id));
    if (!rec) continue;
    let root = rec; const seen = new Set();
    while (root && isStr(root.supersedes) && byId.has(root.supersedes) && !seen.has(root.id)) { seen.add(root.id); root = byId.get(root.supersedes); }
    const chain = []; let cur = root; const guard = new Set();
    while (cur && !guard.has(cur.id)) {
      guard.add(cur.id); chain.push(cur);
      const tomb = records.find((r) => r.retires === cur.id);
      if (tomb) { chain.push(tomb); break; }                                  // 墓碑进链、并终止
      const next = records.find((r) => r.supersedes === cur.id);
      if (!next) break;
      cur = next;
    }
    const curSet = new Set(currentRecords(records).map((r) => r.id));
    const currentId = [...chain].reverse().find((r) => curSet.has(r.id))?.id ?? null;
    const revokedTomb = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
    const activeTomb = chain.some((r) => typeof r.retires === 'string' && r.retires !== '' && !revokedTomb.has(r.id));
    const contentTip = [...chain].reverse().find((r) => !isStr(r.retires) && !isStr(r.revokes));
    const proposed = currentId === null && !activeTomb && contentTip?.status === 'proposed';
    return {
      store: name, root: root.id,
      currentId,
      state: currentId ? 'current' : proposed ? 'proposed' : 'retired',
      proposed,
      retired: !currentId && !proposed,
      versions: chain.map((r, i) => ({
        id: r.id,
        day: daySlice(r.logged_at) || daySlice(r.event_time),
        tombstone: r.retires !== undefined ? r.retires : null,
        changed: i > 0 ? diffFields(r, chain[i - 1]) : null,
        line: String(PRIMARY_LINE[name] ? PRIMARY_LINE[name](r) : '').slice(0, 100)
      })),
      ids: chain.map((r) => r.id)
    };
  }
  return null;
}

/** I-04-b 矛盾显现查询（2026-10-13，批次 1；B 线 P1-②）：给 id ⇒ 链视图 + 涉该链的冲突候选；给主题词 ⇒ 主题相关冲突清单。
 *  复用 #18 detectConflicts（机械对照、只提示不裁决、同题多源不合并）：**先全库扫描、再按相关性过滤**（避免只在前 20 对里碰运气）。只读。 */
export function conflictReport(input, opts = {}) {
  const q = String(input ?? '').trim();
  if (!q) return { query: '', kind: 'none', chain: null, pairs: [], matched: 0, note: '给一个 id 或主题词。' };
  const chain = chainView(q, opts);
  const toks = tokenize(q.toLowerCase());
  const allRecs = {}; const matchIds = new Set();
  for (const name of STORES) {
    const rows = currentRecords(recordsOf(name, opts));
    allRecs[name] = rows;
    for (const r of rows) {
      const hay = (LOOKUP_FIELDS[name] || []).map((f) => (Array.isArray(r[f]) ? r[f].join(' ') : (r[f] || ''))).join(' | ').toLowerCase();
      if (scoreTokens(hay, toks).score > 0) matchIds.add(r.id);
    }
  }
  const allPairs = detectConflicts(allRecs, { top: Number.isInteger(opts.scan) ? opts.scan : 200, max: opts.max });
  const relevant = new Set([...matchIds, ...(chain ? chain.ids : [])]);
  const pairs = allPairs.filter((p) => (p.a && relevant.has(p.a)) || (p.b && relevant.has(p.b))).slice(0, Number.isInteger(opts.top) ? opts.top : 20);
  try { recordQuery({ cmd: 'conflict', query: q, hits: pairs.length }, opts); } catch { /* K3 计数失败不影响查询 */ }
  return {
    query: q, kind: chain ? 'id' : 'topic', chain, matched: matchIds.size, pairs,
    note: pairs.length ? '只提示不裁决：作废侧与同题另一条并存，是否真冲突请人工裁定（修订链处置）。' : '无机械候选（0 候选 ≠ 无矛盾：词法级先行）。'
  };
}

// ── 读路径三档（2026-10-14）· 指针 → 摘要 → 全文 ─────────────────────────────
// 体裁隔离是**渲染策略**，不是删记忆：JSONL 原文不动。
// **默认全文**（不传 depth ＝ 与 main 零行为差）。三档是显式 opt-in：`--depth summary|pointer`。
// `--reflect` / `reflect:true` / `rawProcess` / `depth:'full'` ＝高保真（不截断、不剥皮、不受剂量闸）。
// 硬顶（show 1500 / cross 300 / brief 字段 400 / 指针 80）只在 depth 为 summary 或 pointer 时生效。
export const READ_TIER = Object.freeze({
  depth: 'full',
  pointerChars: 80,
  lookupSummaryChars: 120, // lookup 的既有短 snippet；不传 depth / full / reflect 都停在这里
  summaryChars: 400,       // 仅 depth=summary|pointer 时，brief / 会话 gist 主字段截断
  crossLineChars: 300,     // 仅 depth=summary 时的 cross 行宽；默认不截断
  claimCapChars: 1500,     // 仅 depth=summary 时的 show 单条硬顶
  briefPerStore: 3,        // 与 main 相同；不随档变
  // ①（GPT 第四轮·token 开刀）：**有界档的总量上界**——只作用于 depth=summary|pointer（默认 full 仍全量，不动裁定）。
  boundedPerStore: 12,
  boundedTotal: 50
});

/** 未显式传 depth 时返回 `'full'`。reflect / rawProcess / depth:full 也是全文。 */
export function readDepthOf(opts = {}) {
  if (opts.reflect === true || opts.rawProcess === true || opts.depth === 'full') return 'full';
  if (opts.depth === 'pointer') return 'pointer';
  if (opts.depth === 'summary') return 'summary';
  return 'full';
}

/** 硬顶 / 字段投影只在调用方显式要摘要或指针时打开。省略 depth 不算。
 *  N14（GPT 第三轮）：**按有效档位判定**——`depth:'pointer' + reflect:true` 的有效档是 full（readDepthOf），
 *  旧实现直接看 `opts.depth` ⇒ 标签 full 但投影按 pointer 截断（组合参数回归）。 */
export function readTierActive(opts = {}) {
  const d = readDepthOf(opts);
  return d === 'pointer' || d === 'summary';
}

/** 高保真：跳过剥皮与剂量闸。省略 depth 不是高保真（默认仍剥、仍受闸，与 main 一致）。 */
export function highFidelityRead(opts = {}) {
  return opts.reflect === true || opts.rawProcess === true || opts.depth === 'full';
}

/** 该次结果是否走体裁渲染（剥皮 / 非全文）。反思通道＝false，便于侧线分清「召回差」与「剥皮」。 */
export function genreRenderOf(opts = {}) {
  return opts.reflect !== true && opts.rawProcess !== true && opts.depth !== 'full';
}

/** 非全文投影。未超出则原样返回（不加省略号）。 */
export function projectText(text, depth, cap) {
  const s = String(text ?? '');
  if (depth === 'full') return s;
  const n = Number.isInteger(cap) && cap > 0 ? cap
    : (depth === 'pointer' ? READ_TIER.pointerChars : READ_TIER.summaryChars);
  const limit = Math.min(n, READ_TIER.claimCapChars);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '…';
}

const BRIEF_TEXT_FIELDS = ['claim', 'title', 'situation', 'outcome', 'story', 'summary', 'behavior', 'resolution', 'term'];
const SHOW_TEXT_FIELDS = Object.freeze({
  canon: ['claim'],
  mirror: ['situation', 'behavior', 'outcome', 'social_reaction', 'emotion', 'story'],
  orphan: ['summary', 'observed', 'hypothesis'],
  pricing: ['behavior'],
  lexicon: ['term', 'resolution', 'behavior'],
  frontier: ['title', 'topic']
});

/** 浅拷贝后截主字段。全文档返回原对象（不拷、不改库内记录）。 */
export function projectRecord(rec, store, depth) {
  if (!rec || depth === 'full') return { record: rec, truncated: false };
  const cap = depth === 'pointer' ? READ_TIER.pointerChars : READ_TIER.claimCapChars;
  const copy = { ...rec };
  let truncated = false;
  for (const f of (SHOW_TEXT_FIELDS[store] || ['claim', 'summary', 'title'])) {
    if (typeof copy[f] !== 'string') continue;
    const next = projectText(copy[f], depth, cap);
    if (next !== copy[f]) { copy[f] = next; truncated = true; }
  }
  return { record: copy, truncated };
}

export function projectHitFields(hit, depth, cap) {
  if (!hit || depth === 'full') return hit;
  const out = { ...hit };
  let truncated = false;
  for (const f of BRIEF_TEXT_FIELDS) {
    if (typeof out[f] !== 'string') continue;
    const next = projectText(out[f], depth, cap);
    if (next !== out[f]) { out[f] = next; truncated = true; }
  }
  if (truncated) out.truncated = true;
  return out;
}

/** 读侧年龄前缀。锚＝event_time，否则 logged_at，否则 time。不写库。 */
export function agePrefix(rec, opts = {}) {
  const raw = rec && (rec.event_time || rec.logged_at || rec.time || null);
  if (!raw) return '[日期未知]';
  const s = String(raw);
  // 日期只按「日历日」比：纯日期用原文；ISO 时刻按本地日切。不能拿 UTC 午夜去减本地现在（本地 00:00–08:00 会误报未来）。
  let day;
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) day = s.slice(0, 10);
  else { const d = new Date(s); if (Number.isNaN(d.getTime())) return '[日期未知]'; day = todayLocal(d); }
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) return '[日期未知]';
  const anchor = opts.today ? String(opts.today).slice(0, 10)
    : (opts.now != null ? todayLocal(new Date(Number(opts.now))) : todayLocal());
  const days = Math.round((Date.parse(anchor + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z')) / 86400000);
  if (!Number.isFinite(days)) return '[日期未知]';
  if (days < 0) return `[未来·${-days}天]`;
  return `[过去·${days}天]`;
}

export function citeRows(hits) {
  return (Array.isArray(hits) ? hits : []).filter((h) => h && isStr(h.id)).map((h) => ({
    id: h.id, store: h.store ?? null, tier: h.tier ?? null, strong: !!h.strong
  }));
}

/**
 * 轻量 L4：核对「引用 id ⊆ 本轮 citeAllowlist」。
 * 只返回 { ok, outside }，**不拦截**任何读/写通道——先能核对，再谈闸门。
 * cited / allowlist 元素可以是 id 字符串，或 `{id}`。
 */
export function checkCitations(cited, allowlist) {
  const allowed = new Set();
  for (const x of Array.isArray(allowlist) ? allowlist : []) {
    if (typeof x === 'string' && x) allowed.add(x);
    else if (x && isStr(x.id)) allowed.add(x.id);
  }
  const ids = [];
  for (const x of Array.isArray(cited) ? cited : []) {
    if (typeof x === 'string' && x) ids.push(x);
    else if (x && isStr(x.id)) ids.push(x.id);
  }
  const outside = [...new Set(ids.filter((id) => !allowed.has(id)))];
  return { ok: outside.length === 0, outside, allowed: [...allowed] };
}

/** 宪章原文（复审抽样与协议共用；审计只读挂钩，不施压）。 */
export const REVIEW_CHARTER_NO_PRESSURE = '不给压力：复审是对照，不是考核。子 agent 不必凑出问题才算完成；「维持」与「没有更好的解法」是合格结论。不设「必须找出 N 处错误」的配额，不因零疑点而重审，不把到期条数当成未完成的债。小样本（5–10 条核心到期）按排期做完即可停。';

/** 只读：从复审到期清单里取核心档小样本（目标 5–10，不足则全取，不编造）。不写库、不派审。 */
export function reviewSample(opts = {}) {
  const due = opts.due || reviewDue(opts);
  const coreDays = due && due.policy ? due.policy.coreDays : REVIEW_DEFAULTS.coreDays;
  const core = (due && Array.isArray(due.items) ? due.items : []).filter((x) => x && x.intervalDays === coreDays);
  const want = Number.isInteger(opts.limit) ? opts.limit : 8;
  const takeN = Math.min(10, Math.max(0, want));
  const items = core.slice(0, takeN);
  return {
    charter: REVIEW_CHARTER_NO_PRESSURE,
    window: { min: 5, max: 10, taken: items.length, coreDue: core.length },
    items,
    steps: ['排期（audit --due / reviewSample）', '审查（review pack → fresh 子 agent）', '修订链追加（revise；维持则只打复审戳）', 'review-cycle 留痕（review log）'],
    note: '只读抽样，不写库、不自动派审。样本不足 5 条时如实少取，不凑数。'
  };
}

// ── 批次 2 · 体裁隔离 P0（2026-10-13；设计 = `research/genre-isolation-design-20261013.md` §7）──

/** P0-② **符号骨架剥皮**（读侧渲染专用；单点实现，CLI / MCP 桥 / 会话层共用）：
 *  「保信息、去模板」——`⇒`→`→`；`✓`→删除（规整空格）；`好。`→`。`（行首/句末吞并）。
 *  **白名单机制**：只剥枚举内的完成态符号；**其余字符零改动**；**幂等**（重复运行结果一致）。
 *  作用域＝**读侧渲染**：库内原文一字不动；**反思通道不调用本函数**（`--reflect` / `--raw-process` 给原文）。
 *  依据：案发相变样本即符号（≈50 个 ⇒ / 36 个 ✓）；工业对应＝Letta 的显示格式防护同族（三线逆向）。 */
export function stripGenre(text) {
  let s = String(text ?? '');
  if (!s) return s;
  s = s.replace(/⇒/g, '→');
  s = s.replace(/[ \t]*✓[ \t]*/g, ' ').replace(/ {2,}/g, ' ');
  // 2026-10-15 全量检查（S-core-2，P2 复核确认并降档为「读侧渲染篡改」）：原第二条是无锚全局替换 `/好。/g`，
  // 会把词尾的「好」一起吃掉——真库实测 627 字段受影响 / 18 处（偏好。→偏。；你好。→你。；正好。→正。）。
  // 现改为**带左边界锚**：只在「行首 / 标点后 / 空白后」才吞并（＝填充语用法），词尾的「好」不再动。
  // ⚠ 语义收窄是有意的：夹具样本 `嗯好。继续`（好 紧跟"嗯"）从"会被吞"变成"不该吞"，已同批换样本。
  s = s.replace(/(^|[\n。！？；：，、\s])好。/gmu, '$1');
  s = s.replace(/[ \t]+$/gm, '');
  return /^\s*$/.test(s) ? '' : s;
}

/** I-12 P1-③ **剂量闸**（2026-10-13，批次 2）：单次回读的「符号负荷」限幅——累计超阈 ⇒ 后续条目改摘要（保 id 与指针）。
 *  「对齐侧音电平」：不看有没有标签，只看负荷；**反思通道**（reflect / raw-process）不受限；`doseThreshold: 0` 关闸。
 *  工业对应＝OpenViking `trigger/clear_at_least`、MemGPT 双阈值（三线逆向）。 */
export const GENRE_DOSE_DEFAULTS = Object.freeze({
  threshold: 15,        // 常规阈值（被剥符号等效量：⇒ / ✓ / 好。 计数）
  strictThreshold: 8,   // 任务门控「收紧档」（长会话等信号自动触发，2026-10-13 见 §4.2 P1-④）
  summaryChars: 60,     // 超阈后「摘要」＝前 N 字 + …（保信息骨架、去正文样板）
  longSessionSegs: 2000 // 长会话自判阈值（会话层用；可 options 覆写便于自测）。
                        // 标定（2026-10-13 复查·举一反三）：真库 21 会话中 ≥3000 段仅 1 个，而**案发会话＝2179 段**
                        // ⇒ 原 3000 会把已知风险类漏在外面；取 2000 覆盖案发会话＋两个更长的（3/21）。仍是经验值，随观测再校。
});

/** 符号负荷计数（与 stripGenre **同一白名单**：⇒ / ✓ / 好。）。 */
export function skeletonCount(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let n = 0;
  for (const ch of s) if (ch === '⇒' || ch === '✓') n += 1;
  n += (s.match(/(^|[\n。！？；：，、\s])好。/gmu) || []).length;   // 2026-10-15：与 stripGenre 同锚（原先无锚 ⇒ 词尾「好」也计数，污染剂量闸）
  return n;
}

/** 剂量闸判定（纯函数）：按顺序累计负荷；返回首个越限位置（该条起＝「后续条目」）。
 *  `cutoff=null` ⇒ 未越限；否则 `texts[cutoff..]` 应被摘要化。 */
export function doseGate(texts, { threshold = GENRE_DOSE_DEFAULTS.threshold } = {}) {
  const counts = (Array.isArray(texts) ? texts : []).map((t) => skeletonCount(t));
  let run = 0; let cutoff = null;
  for (let i = 0; i < counts.length; i += 1) {
    run += counts[i];
    if (run > threshold) { cutoff = i; break; }
  }
  return { counts, total: counts.reduce((a, b) => a + b, 0), cutoff, threshold };
}

/** 剂量闸的「摘要形式」：前 N 字 + …（不改语义、只做限幅）。 */
export function doseSummary(text, opts = {}) {
  const n = Number.isInteger(opts.summaryChars) && opts.summaryChars > 0 ? opts.summaryChars : GENRE_DOSE_DEFAULTS.summaryChars;
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** 各库「主文本字段」（剂量闸计数与摘要的对象；与 brief 的展示面一致）。 */
export const DOSE_TEXT_FIELD = Object.freeze({ canon: 'claim', mirror: 'situation', orphan: 'summary', pricing: 'behavior', lexicon: 'resolution', frontier: 'title' });

/** #1 自治读数族（2026-10-12 窗口 3；外部对照启发：灵枢 metacognition）。
 *  纪律（用户口径「只读·如实」）：**样本不足 ⇒ 值=null（ok:null），绝不冒充 PASS**；缺失项在 missing 里点名，不静默。
 *  五读数：① 漏召率（失败前未查库占比）② 工具失败率 ③ 反驳率（verifier refute 占比）④ 同坑复发（同工具同错误码出现 ≥2 次的组数）⑤ 回滚弧（修订链中含 rollback_of 的链数）。
 *  只读：由 metrics(store 面) + hooks 已解析行驱动，不改任何数据。 */
export function autonomyReadings(opts = {}) {
  const m = opts.metrics && typeof opts.metrics === 'object' ? opts.metrics : metrics(opts);
  const minN = Number.isInteger(opts.minN) ? opts.minN : 5;
  const safeRate = (num, den) => (den >= minN ? +(num / den).toFixed(4) : null);
  const r = m.recall ?? {};
  const c = m.counters ?? {};
  // ③④：从 hooks 行现取（metrics 不保留逐行；此处只读重扫一遍）
  //  夹具路径：显式给 opts.toolErrors（数组）⇒ 不扫真日志（结果可控、测试可复现）。
  let refute = 0, revisionsTotal = 0, chainsWithRollback = 0, chainsTotal = 0;
  const allToolErr = new Map();
  const injectedErr = Array.isArray(opts.toolErrors) ? opts.toolErrors
    : (opts.metrics && Array.isArray(opts.metrics.topToolErrors) ? opts.metrics.topToolErrors : null);
  if (injectedErr) {
    for (const [k, n] of injectedErr) allToolErr.set(String(k), Number(n) || 0);
  } else {
    try {
      const lines = readFileSync(opts.log || join(LOGS_DIR, 'hooks.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        let rec; try { rec = JSON.parse(l); } catch { continue; }
        if (rec.kind === 'tool' && rec.ok === false) { const k = String(rec.tool ?? '?'); allToolErr.set(k, (allToolErr.get(k) ?? 0) + 1); }
        if (typeof rec.kind === 'string' && rec.kind.startsWith('verifier')) { revisionsTotal += 1; if (String(rec.verdict ?? rec.result ?? '') === 'refute') refute += 1; }
      }
    } catch { /* 缺日志 ⇒ 读数照常给 null */ }
  }
  const pitGroups = (Array.isArray(m.topToolErrors) ? m.topToolErrors : []).filter(([, n]) => Number(n) >= 2);   // 同坑复发组（top5 视角）
  const allPits = [...allToolErr.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);              // 全扫视角（更准）
  for (const s of STORES) {
    try {
      const recs = loadStore(s).records;
      const byId = new Map(recs.filter((x) => isStr(x.id)).map((x) => [x.id, x]));
      const seen = new Set();
      for (const x of recs) {
        if (!isStr(x.id) || !isStr(x.supersedes) || seen.has(x.id)) continue;
        seen.add(x.id);
        chainsTotal += 1;
        let cur = x;
        while (cur && isStr(cur.supersedes) && byId.has(cur.supersedes)) { if (cur.rollback_of !== undefined) { chainsWithRollback += 1; break; } cur = byId.get(cur.supersedes); }
      }
    } catch { /* 读不到就缺 */ }
  }
  const read = {
    recallMissRate: { value: Number.isFinite(r.missRate) && Number(r.failureTurns ?? 0) >= minN ? r.missRate : safeRate(Number(r.misses ?? 0), Number(r.failureTurns ?? 0)), num: r.misses ?? 0, den: r.failureTurns ?? 0, note: '失败回合里「失败前未先查库」的占比（越低越好；来自 hooks 回查线）' },
    toolFailureRate: { value: safeRate(Number(c.toolErrors ?? 0), Number(c.tools ?? 0)), num: c.toolErrors ?? 0, den: c.tools ?? 0, note: '工具调用失败率' },
    refuteRate: { value: safeRate(refute, revisionsTotal), num: refute, den: revisionsTotal, note: 'verifier 判 refute 占比（数据源：logs/hooks.jsonl 的 verifier 行；当前线未铺 ⇒ null）' },
    samePitRecurrence: { value: (pitGroups.length || allPits.length) ? new Set([...pitGroups.map(([k]) => k), ...allPits.map(([k]) => k)]).size : null, num: new Set([...pitGroups.map(([k]) => k), ...allPits.map(([k]) => k)]).size, den: allToolErr.size, note: '同坑复发：**全扫** hooks 后「同一工具错误出现 ≥2 次」的工具数（非只看 top5）；明细 top 见同返回 stats' },
    rollbackChains: { value: safeRate(chainsWithRollback, chainsTotal), num: chainsWithRollback, den: chainsTotal, note: '含回滚版（rollback_of）的修订链占比' }
  };
  const missing = Object.entries(read).filter(([, v]) => v.value === null).map(([k]) => k);
  return { at: new Date().toISOString(), minSample: minN, readings: read, missing, ok: missing.length ? null : true, note: missing.length ? '样本不足/' + missing.length + ' 项缺失 ⇒ ok=null（**不报 PASS**）' : '全读数可算' };
}

/** #19 回滚命令化（2026-10-12 窗口 3）：把「某日（或某前缀之后）追加的修订」整体回退。
 *  纪律：**追加反向修订、绝不删原文**（append-only 不破）；回滚记录带 `rollback_of`（可事后辨认、且不会被二次回滚）。
 *  语义：对每条候选（= 指定日期起的**修订版**，且已有前一版），追加一条 id 同前版的记录（内容=前一版）、`supersedes` 接在被打版之后。
 *  返回计划/结果数组：dry（默认）只读；`apply:true` 才写。**幂等**：已回滚过即跳过（重跑无事可做）。 */
export function rollbackBatch(store, opts = {}) {
  if (!STORES.includes(store)) throw new Error('未知存储：' + store);
  if (isProtocolId(opts.id) || isProtocolId(opts.since)) throw new Error('协议条不可批量回滚（用法条改写须人工 --allow-protocol）');
  const file = opts.file || storePath(store);
  const day = opts.since ? dayArg(opts.since, 'since') : todayLocal();
  const need = opts.apply === true;
  return withFileLock(file, () => {
    const records = loadStore(store, file).records;
    const byId = new Map(records.filter((r) => isStr(r.id)).map((r) => [r.id, r]));
    const rolledIds = new Set(records.filter((r) => r.rollback_of !== undefined).map((r) => r.rollback_of));
    // 「已回滚」的判定看**后继**：谁把它 rollback_of 了；不能只看 id（回滚版 id ≠ 前版 id）。
    const rolledBy = new Set();
    for (const r of records) if (r.rollback_of !== undefined && isStr(r.supersedes)) rolledBy.add(r.supersedes);
    // N06（GPT 第三轮）：**覆盖范围判定**——每次 rollback 在记录里写 `rolled_back`（本次撤掉的窗口内修订），
    //   重跑/扩窗一律按「窗口内是否还有**未被覆盖**的修订」判，不再用日期短路（原实现把扩窗误当重复请求）。
    const coveredIds = new Set();
    for (const r of records) if (Array.isArray(r.rolled_back)) for (const x of r.rolled_back) if (isStr(x)) coveredIds.add(x);
    const plan = [];
    // R6（GPT 复核二轮 · 2026-10-14）：**退役链不可经 rollback 复活**——链上（根或任意版本）被墓碑 `retires` 时，
    //   恢复必须走**明确的恢复操作**（revokeRetire / sleep --revoke）；否则 rollback 会把记录以新版本悄悄带回当前集，
    //   而墓碑仍挂着 ⇒ current 与 retires 打架（复现：revise→retire→rollback ⇒ current 出现 `…-r1r1`）。
    // N05（GPT 第三轮）：**有效退役状态统一**——已被显式 revoke 的墓碑不再算「已退役」；否则明确恢复后的记录
    //   仍被 rollback 当退役链永久拒绝（复现：revise→retire→revokeRetire→revise→rollback ⇒ refused:retired）。
    const tombstoned = new Set();
    const revokedTombIds = new Set(records.map((r) => (isStr(r.revokes) ? r.revokes : null)).filter(Boolean));
    for (const t of records) {
      if (!isStr(t.retires)) continue;
      if (revokedTombIds.has(t.id)) continue;
      tombstoned.add(t.retires);
      const r0 = byId.get(t.retires);
      if (r0) { let c = r0; while (c.supersedes && byId.has(c.supersedes)) c = byId.get(c.supersedes); tombstoned.add(c.id); }
    }
    // F03（2026-10-14 外部审查 · GPT）：**按链聚合**——同一条链在窗口内多次修订时，只从**当前链尾**追加
    //   **一次**恢复（内容 = 「窗口内第一个修订」的前一版）。原实现逐修订各补一条 ⇒ 一条链出现两个
    //   「当前版本」（分叉，且 check 无感）⇒ 后续召回可能拿到冲突版本。
    const roots = new Map();
    for (const r of records) {
      if (!isStr(r.id)) continue;
      let c = r;
      while (c.supersedes && byId.has(c.supersedes)) c = byId.get(c.supersedes);
      if (!roots.has(c.id)) roots.set(c.id, c);
    }
    for (const [rootId, root] of roots) {
      const ch = [root];
      let c = root;
      const seenChain = new Set([root.id]);
      for (;;) { const n = records.find((x) => x.supersedes === c.id); if (!n || seenChain.has(n.id)) break; seenChain.add(n.id); c = n; ch.push(n); }
      const tip = ch[ch.length - 1];
      if (!isStr(tip.id) || tip.id === rootId) continue;                                          // 只有追加、无修订 ⇒ 无可回滚
      // R12 幂等由 N06 的 coveredIds 统一接管（重跑：窗口内修订全被覆盖 ⇒ 无候选 ⇒ 零新增）。
      // 候选 = 窗口内「未回滚过的修订」（rollback 记录自身不是候选、已覆盖的不再算）。
      const firstIdx = ch.findIndex((x, k) => k > 0 && x.rollback_of === undefined && (recordDay(x) || '') >= day && !rolledBy.has(x.id) && !coveredIds.has(x.id));
      if (firstIdx < 1) continue;                                                                 // 窗口内无未覆盖修订 ⇒ 无可回滚
      const restore = ch[firstIdx - 1];
      if (isProtocolId(rootId) || isProtocolId(tip.id) || isProtocolId(restore.id)) {             // F01：协议链回滚须人工 --allow-protocol
        plan.push({ store, id: tip.id, restores: restore.id, refused: 'protocol' });
        continue;
      }
      if (tombstoned.has(rootId) || ch.some((v) => tombstoned.has(v.id))) {                       // R6：退役链拒绝回滚（走 revoke 明确恢复）
        plan.push({ store, id: tip.id, restores: restore.id, refused: 'retired' });
        continue;
      }
      if (restore.status === 'proposed') {                                                         // 回滚到提案会让当前集归零
        plan.push({ store, id: tip.id, restores: restore.id, refused: 'proposed' });
        continue;
      }
      const coveredHere = ch.slice(firstIdx).map((x) => x.id).filter((x) => (recordDay(byId.get(x) || {}) || '') >= day);
      plan.push({ store, id: tip.id, restores: restore.id, covered: coveredHere, claim: restore.claim ?? restore.summary ?? restore.behavior ?? restore.title ?? '' });
    }
    if (!need) return plan;
    const done = [];
    for (const p of plan) {
      if (p.refused) continue;
      if (rolledBy.has(p.id) || rolledIds.has(p.id)) continue;
      const prev = byId.get(p.restores);
      // id 必须新（重复 id 是硬错误）：内容=前一版，id = **链尾 + r1**。
      const targetId = p.id + 'r1';
      if (records.some((x) => x.id === targetId)) continue;                                       // 幂等（重跑时目标已存在 ⇒ 跳过）
      const rec = { ...prev, id: targetId, supersedes: p.id, rollback_of: p.id, rolled_back: Array.isArray(p.covered) ? p.covered : [] };   // N06：覆盖范围随记录持久化
      delete rec.logged_at;                                                                        // 回滚=一次新写入 ⇒ 盖新戳
      appendRecord(store, rec, { file, locked: true });
      rolledIds.add(p.id);
      done.push({ id: targetId, rollback_of: p.id, restores: p.restores, claim: p.claim ?? '' });
    }
    return done;
  });
}

export function price({ severity, irreversibility, cost, good }) {
  const clamp = v => Math.min(5, Math.max(1, Math.round(Number(v) || 1)));
  const s = clamp(severity); const i = clamp(irreversibility); const c = clamp(cost);
  const raw = s * i * c;
  return {
    formula: '严重度 × 不可逆性 × 代价',
    severity: s, irreversibility: i, cost: c,
    price_raw: raw,
    arousal: +(raw / 125).toFixed(3),
    valence: good === true ? 1 : good === false ? -1 : 0
  };
}

export function stats(opts = {}) {   // 2026-10-15：加可选参数以便真正吃 opts.files 注入（原先无参 ⇒ 注入无处可进）
  // 2026-10-15 全量检查（S-core-1）：本函数声称支持 `opts.files` 数据面注入，实际不带路径读真库 ⇒ 接上注入
  const L = (n) => loadStore(n, (opts.files && opts.files[n]) || storePath(n));
  const out = {};
  const cur = (name) => currentRecords(L(name).records);
  const superseded = (name, current) => L(name).records.filter((r) => r.status !== 'proposed').length - current.length;
  const proposedCount = (name) => pendingProposalCount(L(name).records);
  const canon = cur('canon');
  out.canon = {
    total: canon.length,
    proposed: proposedCount('canon'),
    superseded: superseded('canon', canon),
    by_source: canon.reduce((m, r) => { const k = (r.source && r.source.type) || '?'; m[k] = (m[k] || 0) + 1; return m; }, {})
  };
  const mirrors = cur('mirror');
  out.mirror = { total: mirrors.length, proposed: proposedCount('mirror'), superseded: superseded('mirror', mirrors) };
  const orphans = cur('orphan');
  out.orphan = {
    total: orphans.length,
    proposed: proposedCount('orphan'),
    superseded: superseded('orphan', orphans),
    by_severity: orphans.reduce((m, r) => { m[r.severity] = (m[r.severity] || 0) + 1; return m; }, {})
  };
  const priceRows = cur('pricing');
  out.pricing = { total: priceRows.length, superseded: superseded('pricing', priceRows) };
  const lex = cur('lexicon');
  out.lexicon = { total: lex.length, superseded: superseded('lexicon', lex) };
  const fronts = cur('frontier');
  out.frontier = {
    total: fronts.length,
    superseded: superseded('frontier', fronts),
    by_status: fronts.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {})
  };
  return out;
}

/** 相对时间文本（纯函数）。 */
export function ageText(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '未知';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

// 库脉搏（纯读）：六库计数 / 当前版本数 / 每库最后一条 id / 全库最近写入（含相对时间）。
// 「写→可见」通道的数据源：任何会话/脚本写入后，条子下一回合即可命名新内容（可立即 lookup/brief）。
export function pulse(opts = {}) {   // 2026-10-15（GPT N1）：吃 opts.files 注入——summary 的注入面必须贯穿到 newest/mtime
  const stores = {};
  let newest = null;
  const now = Date.now();
  for (const name of STORES) {
    const file = (opts.files && opts.files[name]) || storePath(name);
    const { records } = loadStore(name, file);
    let mtime = null;
    try { mtime = statSync(file).mtimeMs; } catch { /* 容缺 */ }
    const last = records.length ? records[records.length - 1] : null;
    stores[name] = { count: records.length, current: currentRecords(records).length, lastId: last ? last.id : null, mtime };
    if (mtime !== null && (newest === null || mtime > newest.mtime)) newest = { store: name, id: last ? last.id : null, mtime };
  }
  if (newest) { newest.ageMs = Math.max(0, now - newest.mtime); newest.ageText = ageText(newest.ageMs); }
  return { at: new Date().toISOString(), stores, newest };
}

/** 内置时钟（2026-10-14；用户令「给大肥鱼搞个内置时钟，工作时可主动查询时间，为自我行为提供时间依据与对照」）。
 *  只读。返回 now（本地/UTC/星期/偏移/unix）+ refs（**时间对照锚**：最近写入 / 上次睡眠）+ at（把给定时点换算成距今）。
 *  opts.now 可注入（测试）；opts.at＝字符串或数组；`YYYY-MM-DD` 按 **UTC 午夜**解析（如实口径，daysAgo 可能带小数）。 */
export function nowSnapshot(opts = {}) {
  const d = opts.now instanceof Date ? opts.now : new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const offStr = (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
  const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const age = (ms) => (Number.isFinite(ms) ? ageText(Math.max(0, ms)) : null);
  const refs = { lastWrite: null, lastSleep: null };
  try {
    const p = pulse();
    if (p && p.newest) refs.lastWrite = { store: p.newest.store, id: p.newest.id, age: p.newest.ageText ?? age(d.getTime() - p.newest.mtime) };
  } catch { /* 容缺 */ }
  try {
    const st = JSON.parse(readFileSync(join(LOGS_DIR, 'sleep-state.json'), 'utf8'));
    if (st && st.lastRunAt) refs.lastSleep = { at: String(st.lastRunAt).slice(0, 16) + 'Z', age: age(d.getTime() - Date.parse(st.lastRunAt)) };
  } catch { /* 容缺 */ }
  const list = Array.isArray(opts.at) ? opts.at : (opts.at ? [opts.at] : []);
  const at = list.filter((x) => typeof x === 'string' && x.trim()).map((x) => {
    const t = Date.parse(x.trim());
    if (!Number.isFinite(t)) return { input: x, error: '无法解析（用 ISO 或 YYYY-MM-DD）' };
    const delta = d.getTime() - t;
    return { input: x, day: x.trim().slice(0, 10), age: age(delta), direction: delta >= 0 ? '过去' : '未来', daysAgo: +(delta / 86400000).toFixed(2) };
  });
  return {
    now: {
      local: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      weekday: WD[d.getDay()], tzOffset: offStr, utc: d.toISOString(), unix: Math.floor(d.getTime() / 1000)
    },
    refs, at
  };
}

// 机械审计（抽样审计的可机检部分）：到期复审 / 陈旧复核 / 重复链接 / 孤案积压。
// ── I-10 记忆复审机制（2026-10-14）：输入包 / 留痕线 / 读取 ─────────────────────
export function reviewLogPathOf(opts = {}) {
  return opts.file || join(LOGS_DIR, 'review-log.jsonl');
}

/** 追加一行 `review-cycle` 留痕（谁审的 / 审的哪条 / 结论）。加锁 + 单行 append；失败抛出（调用侧决定是否容错）。 */
export function appendReviewLog(entry, opts = {}) {
  const file = reviewLogPathOf(opts);
  mkdirSync(dirname(file), { recursive: true });
  // 2026-10-18（GPT③ 残余 / #13）：review-log 是日志面——不拒写，但要脱敏（旧实现原样落盘）。
  const row = redactDeep({ ts: new Date().toISOString(), ...entry });
  withFileLock(file, () => appendFileSync(file, JSON.stringify(row) + '\n', 'utf8'));
  return { ok: true, file, row };
}

/** 读留痕线（默认最近 20 条；`since` 按日过滤——追加序即时间序，早于 since 即停）。 */
export function readReviewLog(opts = {}) {
  const file = reviewLogPathOf(opts);
  let lines = [];
  try { lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; }
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
  const since = typeof opts.since === 'string' && opts.since ? opts.since.slice(0, 10) : null;
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    if (since && String(r.ts ?? '').slice(0, 10) < since) break;
    out.push(r);
  }
  return out.reverse();
}

/** 复审输入包（只读）：条目全文 + 来源证据 + 必要上下文（因果 / 修订链邻居）+ 审查协议（交给 **fresh 子 agent**）。
 *  设计＝《复审机制》A.2「输入三件」；子 agent 以**零上下文**派出（对照参照的价值所在），输出结构化审查报告。 */
export function reviewPack(id, opts = {}) {
  // 复审要看链尾全文（高保真）。日常 show 的摘要硬顶不适用于输入包；体裁剥皮仍由 CLI/MCP 渲染层决定。
  const s = show(String(id), { ...opts, depth: 'full' });
  if (!s || !s.record) return { found: false, id: String(id), note: (s && s.note) || '未找到' };
  // 复审对象＝**当前版本**：show 契约不自动跳转 ⇒ 这里显式沿 supersedes 走到链尾（2026-10-14 复查补齐）。
  let tip = s.record;
  try {
    const recs = loadStore(s.store).records;
    const seenRecs = new Set([tip.id]);
    for (;;) {
      const next = recs.find((r) => r && r.supersedes === tip.id);
      if (!next || seenRecs.has(next.id)) break;
      seenRecs.add(next.id);
      tip = next;
    }
  } catch { /* 读不出就退回所查版本 */ }
  const rec = tip;
  const rel = [];
  for (const f of ['caused_by', 'led_to']) if (Array.isArray(rec[f])) rel.push(...rec[f]);
  // 链信息（版本数）——单独给，不混进「相关条目」（自身历史 ≠ 外部上下文）。
  let versions = 1;
  try {
    const recs = loadStore(s.store).records;
    let cursor = rec;
    while (cursor && isStr(cursor.supersedes)) { const prev = recs.find((r) => r && r.id === cursor.supersedes); if (!prev) break; versions += 1; cursor = prev; }
  } catch { /* ignore */ }
  const related = [];
  for (const x of [...new Set(rel.map(String))]) {
    const t = show(x, opts);
    related.push(t && t.record
      ? { id: t.id, store: t.store, line: String(t.record.claim ?? t.record.summary ?? t.record.situation ?? t.record.title ?? '').slice(0, 240) }
      : { id: x, missing: true });
  }
  return {
    found: true, id: s.id, current: rec.id, store: s.store, record: rec,
    chain: { root: s.id, current: rec.id, versions },
    source: rec.source ?? null,
    related,
    protocol: {
      reviewer: 'fresh 子 agent（零上下文；独立视角不带主会话先见）',
      questions: [
        '事实性核对：对照来源证据（source.ref）与现状，结论是否仍成立？',
        '方法审查：有没有更好的解法（升级建议）？',
        '幻觉 / 失效 / 被推翻：有无证据表明它已过时或被替代？'
      ],
      output: '结构化审查报告：结论 / 疑点 / 升级建议 / 理由 / 建议动作（修正 | 升级 | 维持）',
      landing: '主会话裁决 → 修订链追加（修正 / 升级 / 维持注记「YYYY-MM-DD 已复审」）→ `review log` 留痕'
    }
  };
}

// ── 2026-10-15 全量检查（门档 P2 前置）：两个**两端共用**的入参闸 ──────────────────
// 起因（已实证）：① `today` 的校验只打在 MCP 面 ⇒ CLI `audit --today bogus` exit 0、且 'bogus' 词法大于一切 ISO 日期
//   ⇒ 2027 年的条目被判「到期」；② 数字入参无上下界 ⇒ `summary --per 1e9` 出 185KB（剂量闸可被合法输入绕过）。
// 口径：**校验下沉到 lib**（CLI/MCP/程序化调用共用一处），而不是在各端各加一份（那正是"改半边"的温床）。
/** 日期参数闸：非法即抛（带字段名的可读消息）；合法返回归一后的 YYYY-MM-DD；缺省返回 undefined。 */
export function dayArg(v, field = '日期') {
  if (v === undefined || v === null || v === '') return undefined;
  const r = normalizeDateArg(v);
  if (!r.ok) throw new Error(`${field} 必须是 YYYY-MM-DD（或可归一的日期）：${JSON.stringify(String(v)).slice(0, 40)}`);
  return r.day;
}
/** 整数参数闸：钳到 [min,max]（默认 1..1000）；非数字/NaN 用 dflt（或 min）。 */
export function boundedInt(v, { min = 1, max = 1000, dflt = undefined } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt === undefined ? min : dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function audit(opts = {}) {
  // 2026-10-15 全量检查（S-core-1）：本函数声称支持 `opts.files` 数据面注入，实际不带路径读真库 ⇒ 接上注入
  const L = (n) => loadStore(n, (opts.files && opts.files[n]) || storePath(n));
  const today = dayArg(opts.today, 'today') || todayLocal();   // 2026-10-15：校验下沉到 lib（原先只有 MCP 面校，CLI 透传 ⇒ 'bogus' 词法大于一切 ISO 日期）
  const days = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
  const findings = [];

  const fronts = currentRecords(L('frontier').records);
  const due = fronts.filter(r => r.next_review && r.next_review <= today);
  if (due.length) findings.push({ level: 'warn', code: 'frontier-due', detail: due.map(r => `${r.id}(${r.next_review})`) });

  const urls = new Map();
  for (const r of fronts) {
    if (!r.url) continue;
    if (!urls.has(r.url)) urls.set(r.url, []);
    urls.get(r.url).push(r.id);
  }
  const dupUrls = [...urls.entries()].filter(([, ids]) => ids.length > 1);
  if (dupUrls.length) findings.push({ level: 'info', code: 'duplicate-url', detail: dupUrls.map(([u, ids]) => `${ids.join(' = ')} @ ${u}`) });

  const canon = currentRecords(L('canon').records);
  // 分类滥用防线（2026-10-22 设计稿）：安全类占比 >40% ⇒ 报警（不自动改分类、不阻断）。
  const categorized = [];
  for (const name of STORES) for (const r of currentRecords(L(name).records)) if (r.category) categorized.push(r.category);
  if (categorized.length >= 10) {
    const safety = categorized.filter((c) => c === '安全').length;
    if (safety / categorized.length > 0.4) findings.push({ level: 'warn', code: 'category-abuse', detail: [`安全类 ${safety}/${categorized.length} > 40%：分类可能被滥用，请抽样人读`] });
  }
  const stale = canon.filter(r => r.last_reviewed && days(r.last_reviewed, today) > 365);
  if (stale.length) findings.push({ level: 'warn', code: 'canon-stale', detail: stale.map(r => r.id) });

  const orphans = currentRecords(L('orphan').records);
  const aging = orphans.filter(r => r.created && days(r.created, today) > 90);
  if (aging.length) findings.push({ level: 'info', code: 'orphan-aging', detail: aging.map(r => r.id) });
  // I-08 热缓冲溢出（2026-10-14）：孤儿＝热缓冲；超阈值即报（**只报不裁**；压缩流程见 PROTOCOL「孤儿热缓冲」）。
  const backlogN = Number.isInteger(opts.orphanBacklogN) ? opts.orphanBacklogN : ORPHAN_BACKLOG_DEFAULTS;
  if (orphans.length > backlogN) findings.push({ level: 'info', code: 'orphan-backlog', detail: orphans.map(r => r.id) });
  // I-15 可信度衰减建议（2026-10-14；**建议而非自动**——长期无复现 / 无引用的条目 ⇒ 输出「降权 / 复核建议」）。
  //   判据（三项全中才算，可注入便于自测）：① 时龄 ≥ decayDays（默认 90；锚＝last_reviewed → event_time，无锚跳过）；
  //   ② 链上**无 verification**（replay/experiment/doc/incident 任一）；③ 使用窗口内**零引用**。
  //   ⚠ 引用侧读不到（usage.missing）时**不假报零**：此项整体跳过（宁可不出建议，不可出假建议）。
  const decayDays = Number.isInteger(opts.decayDays) ? opts.decayDays : 90;
  if (decayDays > 0 && canon.length) {
    let usageById = null;
    try {
      const uw = resolveUsageWindow(opts);
      if (uw && uw.missing !== true && uw.byId instanceof Map) usageById = uw.byId;
    } catch { usageById = null; }
    if (usageById) {
      const verifiedRoots = new Set();
      for (const x of L('canon').records) if (x && x.verification) verifiedRoots.add(rootIdOf(x.id) || x.id);
      const decay = [];
      for (const r of canon) {
        const anchor = credDay(r.last_reviewed) || credDay(r.event_time);
        if (!anchor || days(anchor, today) < decayDays) continue;
        if (verifiedRoots.has(rootIdOf(r.id) || r.id)) continue;
        if ((usageById.get(rootIdOf(r.id) || r.id) ?? 0) > 0) continue;
        decay.push(r.id);
      }
      if (decay.length) findings.push({ level: 'info', code: 'credibility-decay', detail: decay });
    }
  }

  for (const name of STORES) {
    const { errors } = L(name);
    // 文件不存在（line 0）是空安装，不是损坏。只有解析失败的行才算丢行。
    const bad = errors.filter((e) => e.line > 0);
    if (bad.length) findings.push({ level: 'warn', code: 'bad-jsonl', detail: bad.map((e) => `${name}:${e.line}:${e.error}`) });
  }

  // I-01 复审到期清单原型（2026-10-13 批次 1）：信任级 × 时龄——**只报不裁决**（level: info，不动 ok）。
  const review = reviewDue({ ...opts, today });
  if (review.counts.due) findings.push({ level: 'info', code: 'review-due', detail: review.items.slice(0, 12).map((x) => `${x.store}/${x.id}（龄 ${x.ageDays}d > ${x.intervalDays}d）`) });

  return {
    today, ok: findings.every(f => f.level !== 'warn'), findings, summary: stats({ files: opts.files, today }),
    review: { counts: review.counts, policy: review.policy, top: review.items.slice(0, 20), undated: review.undated, sample: reviewSample({ due: review }) }
  };
}

// 起床包：开工前一次装配——睡眠摘要 + 待办（inbox）+ 当前审计 + 库况 + 提示。
// stateFile / inboxFile 可注入（测试用）；默认读 logs\sleep-state.json 与 logs\inbox.jsonl。
export function kit(opts = {}) {
  const stateFile = opts.stateFile || join(LOGS_DIR, 'sleep-state.json');
  const inboxFile = opts.inboxFile || join(LOGS_DIR, 'inbox.jsonl');
  const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
  const readLines = (f) => { try { return readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } };

  const sleepState = readJson(stateFile);
  const sleep = sleepState ? {
    lastRunAt: sleepState.lastRunAt ?? null,
    trigger: sleepState.lastTrigger ?? null,
    todo: sleepState.lastTodo ?? 0,
    audit: sleepState.lastAudit ?? null,
    report: sleepState.lastReport ?? null,
    counters: sleepState.lastCounters ?? null
  } : null;

  const inboxLines = readLines(inboxFile);
  // 消费记账：promote 转正后向 inbox 追加 kind:"consumed"（带 upTo 行位）；
  // 待办只统计最后一条 consumed 之后的批次——已消费的历史批次不再重复计数（2026-10-07 修）
  const parsedInbox = inboxLines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  let consumedUpTo = 0;
  parsedInbox.forEach((rec, i) => {
    if (rec && rec.kind === 'consumed') {
      consumedUpTo = Number.isInteger(rec.upTo) ? Math.max(consumedUpTo, Math.min(rec.upTo, parsedInbox.length)) : Math.max(consumedUpTo, i + 1);
    }
  });
  let totalItems = 0;
  let latest = [];
  let pendingBatches = 0;
  for (let i = consumedUpTo; i < parsedInbox.length; i++) {
    const rec = parsedInbox[i];
    if (!rec) continue;
    const n = rec.items?.length ?? 0;
    if (n) { totalItems += n; pendingBatches += 1; latest = rec.items; }
  }
  const inbox = { batches: pendingBatches, totalItems, latest: latest.slice(0, 5) };

  const auditResult = audit({ today: opts.today });
  const review = {
    today: auditResult.today,
    ok: auditResult.ok,
    findings: auditResult.findings.map(f => ({ level: f.level, code: f.code, count: f.detail.length }))
  };

  const s = stats();
  const library = {
    canon: s.canon.total, mirror: s.mirror.total, orphan: s.orphan.total,
    pricing: s.pricing.total, lexicon: s.lexicon.total, frontier: s.frontier.total,
    frontier_by_status: s.frontier.by_status
  };

  const hints = [];
  if (!sleep) hints.push('睡眠从未运行：等待首个空闲（或 timer 兜底）触发，或检查 @akasha-book/akasha-sleep 是否激活。');
  if (inbox.totalItems > 0) hints.push(`待办 ${inbox.totalItems} 条（logs\\inbox.jsonl）：按「失败回查 / 孤案候选 / 召回复盘（recall-miss）」处理或转正式条目。`);
  for (const f of review.findings) if (f.level === 'warn') hints.push(`审计警告：${f.code} ×${f.count}（akasha_audit / akasha_frontier_due 可查明细）。`);
  hints.push('开工姿势：相关主题先 brief；事实性断言带来源态（学过 / 接触过 / 记得·库内 / 搜到）。');

  const historyItems = [];
  for (const name of STORES) {
    for (const r of currentRecords(loadStore(name).records)) {
      if (typeof r.valence === 'number' && r.valence < 0) {
        historyItems.push({
          store: name, id: r.id, valence: r.valence,
          arousal: typeof r.arousal === 'number' ? r.arousal : 0,
          line: String(PRIMARY_LINE[name] ? PRIMARY_LINE[name](r) : '').slice(0, 100)
        });
      }
    }
  }
  historyItems.sort((a, b) => b.arousal - a.arousal || a.valence - b.valence);
  const history = historyItems.slice(0, 3);

  const out = {
    at: new Date().toISOString(),
    protocol: '来源态四标签（学过 / 接触过 / 记得·库内 / 搜到）；无据的确定 ≪ 有据的不确定；编造比承认不知道更糟。',
    sleep, inbox, review, library, hints, history
  };
  // A2：可选上下文预算（默认关；不改 library/排序语义）
  if (contextBudgetEnabled(opts)) {
    out.contextBudget = allocateContextBudget({
      contextBudget: true,
      totalTokens: opts.budgetTokens,
      signals: opts.budgetSignals,
      records: opts.budgetRecords,
      params: opts.budgetParams,
      nowMs: opts.nowMs
    });
  }
  return out;
}

// 工具用法噪声（2026-10-22）：这类失败是**我自己调用工具的方式不对**（工具名/参数/读后改/old_string），
// 不是环境或记忆层的异常。它们可以计数、可以在观测线里看，但**不该转正成孤案**——
// 否则睡眠会把“操作失误”当“环境记忆”，清账时又得成批退役（本次 15 条返工的直接原因）。
// 只匹配**主诊断位于错误开头**的模板；不能因为复合错误的后半段引用了 old_string 就把整条丢成噪声
// （2026-10-22 复审 P2-2：`ENOENT ...; previous attempt: old_string was not found` 必须保留）。
export const TOOL_USAGE_NOISE_RE = /^工具失败 [^:]+: (?:unknown tool\s+"|invalid arguments:\s*(?:unknown key|missing required property|must contain at most|timeout 必须为)|old_string was not found|old_string matched \d+ times|old_string and new_string must differ|offset \d+ is out of range|file has not been read|file changed since it was read|cannot (?:modify|edit|write) "[^"]+": file has not been read|cannot (?:modify|edit|write) "[^"]+": file changed since it was read)/i;
export function isToolUsageNoise(samples) {
  const arr = Array.isArray(samples) ? samples : [samples];
  return arr.length > 0 && arr.every((s) => TOOL_USAGE_NOISE_RE.test(String(s ?? '')));
}

// 候选转正：把 sleep/inbox 的孤案候选（失败回查素材）机械落成孤案条目（零权重留档）。
// 幂等：id = code + 样本摘要（orphan-b<8hex>），已存在跳过；dry=true 只报不写。
export function promoteInbox(opts = {}) {
  const inboxFile = opts.inboxFile || join(LOGS_DIR, 'inbox.jsonl');
  const storeFile = opts.storeFile;
  const today = dayArg(opts.today, 'today') || todayLocal();   // 2026-10-15：校验下沉到 lib（原先只有 MCP 面校，CLI 透传 ⇒ 'bogus' 词法大于一切 ISO 日期）
  const lines = (() => { try { return readFileSync(inboxFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } })();
  const existing = new Set(loadStore('orphan', storeFile).records.map(r => r.id));
  const promoted = []; const wouldPromote = []; const skipped = [];
  for (const line of lines) {
    let batch;
    try { batch = JSON.parse(line); } catch { continue; }
    for (const item of batch.items ?? []) {
      if (item.kind !== 'orphan-candidate') continue;
      const rawSamples = Array.isArray(item.samples) ? item.samples : [];
      // 2026-10-22 P2-1：历史混合候选（usage + 真实错误）不能整条丢，也不能把 usage 一起写进 observed。
      // 逐样过滤后：一个有效样本都没有才跳过；有有效样本则只落有效部分，但 id/digest 仍用原始 samples（保持幂等）。
      const validSamples = item.code === 'tool-error'
        ? rawSamples.filter((s) => String(s ?? '').trim() !== '' && !isToolUsageNoise([s]))
        : rawSamples;
      if (item.code === 'tool-error' && rawSamples.length > 0 && validSamples.length === 0) {
        const why = 'tool-usage-noise';
        if (!skipped.includes(why)) skipped.push(why);
        continue;
      }
      // 2026-10-13（举一反三·类⑤）：去重键的**身份**必须能区分两条「都没证据」的候选。
      // 旧键 = md5(code|JSON.stringify(samples ?? note ?? '')) —— 无 samples 无 note 时是 md5(code|"\"\"")，
      //   于是**同 code 的多批会撞同一个 id**，第二条被当作「已存在」静默跳过（实测：count 5 与 7 的两批 → 只落 1 条）。
      // 新键 = 归一 code + 证据指纹（有证据时用 samples/note，无用**整批内容**兜底 ⇒ 不同批次天然不同、重跑同批仍幂等）。
      const evidence = rawSamples.length
        ? JSON.stringify(rawSamples)
        : (typeof item.note === 'string' && item.note.trim() ? item.note.trim() : '');
      const digestSeed = evidence || JSON.stringify({ c: item.count ?? 1, n: item.note ?? null, t: batch.ts ?? null });
      const digest = createHash('md5').update(String(item.code ?? '?') + '|' + digestSeed).digest('hex').slice(0, 8);
      const id = `orphan-b${digest}`;
      if (existing.has(id)) { if (!skipped.includes(id)) skipped.push(id); continue; }   // 同族去重（2026-10-14）：已存在清单同样不得重复列
      // I-08 复查补齐（2026-10-14）：**dry 列表去重**——同批同码、无证据的候选归一到同一 id（这是对的），
      //   但列表曾把它们逐个列出（实测「将转正 17 条」里同 id 重复 6 次）⇒ 清单会骗人；`--apply` 侧本就幂等（existing.add）。
      if (opts.dry) { if (!wouldPromote.includes(id)) wouldPromote.push(id); continue; }
      const observedSamples = item.code === 'tool-error' ? validSamples : rawSamples;
      const rec = {
        id,
        summary: `[inbox候选] ${item.code ?? '?'} ×${item.count ?? 1}`,
        observed: (item.code === 'tool-error' && observedSamples.length
          ? observedSamples.join('；')
          : String(item.note || (observedSamples.length ? observedSamples.join('；') : ''))).slice(0, 500) || '（见 inbox.jsonl 对应批次）',
        hypothesis: '（待补：由 sleep 候选自动入库，待复盘）',
        would_confirm: '（待补）',
        would_refute: '（待补）',
        severity: item.code === 'agent-error' ? '中' : '低',
        created: today
      };
      // 诚实标注（类⑤ 同族）：**零证据**的候选落库时显式打标，别让后人把它当成真观测（真实空洞 ≠ 有证据的孤案）。
      if (!evidence) {
        rec.evidence = 'none';
        rec.observed = '（无具体样本：仅计数聚合；原文见 logs/inbox.jsonl 对应批次）';
        rec.severity = '低';
      }
      appendRecord('orphan', rec, storeFile ? { file: storeFile } : {});
      existing.add(id);
      promoted.push(id);
    }
  }
  const consumed = promoted.length + skipped.length;
  // dry 只读不改：即使是 dry，也不得落消费记账（否则一次 dry 复检=整批待办静默消失，
  // 缺陷会被记录层抹掉——不得用 dry 试探未消费批次）。
  if (!opts.dry && consumed > 0) {
    // 消费记账：向 inbox 追加 consumed 行（upTo=本次读入的行数）——kit 的待办计数以此为界（2026-10-07 修）
    try {
      appendFileSync(inboxFile, JSON.stringify({ ts: new Date().toISOString(), kind: 'consumed', by: 'promote', count: promoted.length, skipped: skipped.length, upTo: lines.length }) + '\n', 'utf8');
    } catch { /* 记账失败不回滚转正：promote 幂等，重跑可补记 */ }
  }
  return { promoted, wouldPromote, skipped, dry: !!opts.dry, consumed: consumed > 0 };
}

// —— 修订链：append-only 之上的「追加式更正」——
// 约定：修订记录携带 supersedes:<被修订 id>；「当前版本」= 没有被任何记录 supersedes 的记录。
// 退役（2026-10-08）：墓碑记录携带 retires:<被退役 id>；被退役 id 及其墓碑都不进「当前集」——
// 于是 lookup / brief / summary / audit / stats 全部自动不再看见它（它们都走 currentRecords）。
export function pendingProposals(records) {
  const superseded = new Set(records.map((r) => r.supersedes).filter((v) => isStr(v)));
  const revoked = new Set(records.map((r) => r.revokes).filter((v) => isStr(v)));
  const retired = new Set(records.filter((r) => isStr(r.retires) && !revoked.has(r.id)).map((r) => r.retires));
  return records.filter((r) => r.status === 'proposed' && !superseded.has(r.id) && !retired.has(r.id) && !isStr(r.retires) && !isStr(r.revokes));
}
export function pendingProposalCount(records) { return pendingProposals(records).length; }

export function currentRecords(records) {
  const superseded = new Set(records.map((r) => r.supersedes).filter((v) => typeof v === 'string' && v !== ''));
  // revokes（2026-10-14 实现 SCHEMA §P4）：撤销记录 `revokes: <墓碑 id>` —— 被撤销的墓碑不再算退役；
  //   撤销记录本身是**元数据**（同墓碑），不进当前集。
  const revoked = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
  const retired = new Set(records.filter((r) => typeof r.retires === 'string' && r.retires !== '' && !revoked.has(r.id)).map((r) => r.retires));
  return records.filter((r) => r.status !== 'proposed' && !superseded.has(r.id) && !retired.has(r.id) && !isStr(r.retires) && !isStr(r.revokes));
}

export function retiredIds(records) {
  const revoked = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
  return new Set(records.filter((r) => typeof r.retires === 'string' && r.retires !== '' && !revoked.has(r.id)).map((r) => r.retires));
}

// 历史 id 集合（含被 supersedes / 被退役 / 墓碑）：**幂等判重必须用它**。
// 2026-10-08 事故：某脚本用 currentRecords 判重 → 已退役 id 不在当前集 → 被重新追加（复活 + 重复 id）。
export function allIds(records) {
  return new Set(records.map((r) => r.id).filter((v) => typeof v === 'string' && v !== ''));
}

export function checkSupersedes(store, records) {
  const ids = new Set(records.map((r) => r.id));
  const errors = [];
  for (const r of records) {
    if (r.supersedes !== undefined && !ids.has(r.supersedes)) {
      errors.push({ store, id: r.id, errors: ['supersedes 指向不存在的 id：' + r.supersedes] });
    }
  }
  return errors;
}

// 追加一版修订：从任意链上版本出发都落到链尾的下一版；未打补丁的字段自动保留。
const PROTOCOL_ROOT = 'canon-akasha-usage';
export function isProtocolId(id) {
  const s = String(id ?? '');
  return s === PROTOCOL_ROOT || s.startsWith(PROTOCOL_ROOT + '-r');
}


function idempotencyLogPath(file) { return join(dirname(file), 'idempotency.jsonl'); }
function sha256Of(text) { return createHash('sha256').update(String(text)).digest('hex'); }
function stableStringify(value) {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return '[' + value.map((item) => item === undefined ? 'null' : stableStringify(item)).join(',') + ']';
  if (kind === 'object') return '{' + Object.keys(value).filter((key) => value[key] !== undefined && typeof value[key] !== 'function' && typeof value[key] !== 'symbol').sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  return 'null';
}
function requestHashOf(id, patch, expectedId) {
  return sha256Of(stableStringify({ id, patch, expectedId: expectedId ?? null }));
}
function idemError(code, message) { const error = new Error(message); error.code = code; return error; }
function receiptExists(path) {
  try { lstatSync(path); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw idemError('idempotency_io', `idempotency_io：无法判定回执文件（${e.code || e.message}）`); }
}
function readReceipts(path) {
  if (!receiptExists(path)) return [];
  const raw = readFileSync(path, 'utf8');
  if (raw && !raw.endsWith('\n')) throw idemError('idempotency_log_corrupt', 'idempotency_log_corrupt：回执文件尾行不完整，拒绝自动重试');
  return raw.split('\n').filter(Boolean).map((line, index) => {
    let rec;
    try { rec = JSON.parse(line); } catch { throw idemError('idempotency_log_corrupt', `idempotency_log_corrupt：第 ${index + 1} 行不可解析`); }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw idemError('idempotency_log_corrupt', `idempotency_log_corrupt：第 ${index + 1} 行不是回执对象`);
    if (typeof rec.key === 'string' && rec.keyHash == null) throw idemError('idempotency_log_legacy', 'idempotency_log_legacy：检测到旧格式回执，请先备份并清理 data/idempotency.jsonl 后再重试');
    if (typeof rec.keyHash !== 'string' || typeof rec.store !== 'string' || typeof rec.fileHash !== 'string' || typeof rec.requestHash !== 'string') throw idemError('idempotency_log_corrupt', `idempotency_log_corrupt：第 ${index + 1} 行回执字段不完整`);
    return rec;
  });
}
function lookupIdempotency(file, store, keyHash, requestHash) {
  if (!keyHash) return null;
  const path = idempotencyLogPath(file);
  if (!receiptExists(path)) return null;
  return withFileLock(path, () => {
    const fileHash = sha256Of(resolve(file));
    const matches = readReceipts(path).filter((rec) => rec.keyHash === keyHash && rec.store === store && rec.fileHash === fileHash);
    if (!matches.length) return null;
    const records = loadStore(store, file).records;
    for (const rec of matches) {
      if (!rec.result || typeof rec.result.id !== 'string' || typeof rec.result.supersedes !== 'string') throw idemError('idempotency_log_corrupt', 'idempotency_log_corrupt：回执缺少 result.id/supersedes');
      if (rec.requestHash !== requestHash) throw idemError('idempotency_conflict', 'idempotency_conflict：同一 key 对应不同请求');
      const body = records.find((row) => row.id === rec.result.id);
      if (!body) throw idemError('idempotency_receipt_stale', 'idempotency_receipt_stale：回执指向的记录已不存在');
      if (body._akasha_write_key !== keyHash || body._akasha_request_hash !== requestHash || body._akasha_store !== store || body.supersedes !== rec.result.supersedes) throw idemError('idempotency_receipt_stale', 'idempotency_receipt_stale：回执与正文凭据不一致');
    }
    return matches[0];
  });
}
function rememberIdempotency(file, store, keyHash, result, requestHash) {
  if (!keyHash) return;
  const path = idempotencyLogPath(file);
  mkdirSync(dirname(path), { recursive: true });
  withFileLock(path, () => {
    if (receiptExists(path)) {
      const raw = readFileSync(path, 'utf8');
      if (raw && !raw.endsWith('\n')) throw idemError('idempotency_log_corrupt', 'idempotency_log_corrupt：回执文件尾行不完整，拒绝追加');
    }
    const fd = openSync(path, 'a');
    try { writeSync(fd, JSON.stringify({ keyHash, store, fileHash: sha256Of(resolve(file)), requestHash, result, at: new Date().toISOString() }) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
  });
}

export function revise(store, id, patch = {}, opts = {}) {
  // patch 类型校验（2026-10-15，E 题审计确证 V4；同日二轮审计 D6 收紧）：字符串/数组/null 会被后续 `{...patch}` 静默展开成垃圾键
  // （实证：patch:'zzz' ⇒ 落库多出 {"0":"z","1":"z","2":"z"} 三个键）。**D6 补充**：仅挡 null/数组/非 object 还不够——
  // Date/Map/RegExp 都是 typeof 'object' 且非数组，放行后 `{...patch}` 展开为 `{}` ⇒ 落一条与链尾**内容完全相同**的假修订
  // （污染修订链）。故按「普通对象」字面口径校验：原型必须是 Object.prototype 或 null。
  const badKind = patch === null ? 'null' : Array.isArray(patch) ? 'array' : typeof patch;
  const proto = (patch !== null && typeof patch === 'object') ? Object.getPrototypeOf(patch) : null;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || (proto !== Object.prototype && proto !== null)) {
    throw new Error(`revise：patch 必须是普通对象（收到 ${badKind}${proto && proto !== Object.prototype ? '/' + (proto.constructor?.name ?? 'exotic') : ''}）`);
  }
  if (!STORES.includes(store)) throw new Error('未知存储：' + store);
  if (isProtocolId(id) && !opts.allowProtocol) {
    throw new Error('拒绝修订 ' + id + '：该条渲染进系统提示。模型路径（MCP）不可改；人工确认后用 CLI --allow-protocol。');
  }
  // 2026-10-14：文件参数统一——`opts.file` 为主、`opts.storeFile` 兼容旧写法（promote 侧仍用 storeFile）。
  const file = opts.file || opts.storeFile || storePath(store);
  for (const field of ['expectedId', 'idempotencyKey']) {
    if (!Object.prototype.hasOwnProperty.call(opts, field)) continue;
    const value = opts[field];
    if (value === undefined) continue; // CLI/MCP 总会构造该字段；undefined = 未提供
    if (typeof value !== 'string' || value.length === 0) throw idemError('invalid_' + field, field + ' 必须是非空字符串（显式提供时不得为空）');
  }
  return withFileLock(file, () => {
    const keyHash = opts.idempotencyKey ? sha256Of(opts.idempotencyKey) : null;
    const requestHash = requestHashOf(id, patch, opts.expectedId);
    const cached = lookupIdempotency(file, store, keyHash, requestHash);
    if (cached) return { ...cached.result, idempotent: true };
    const result = reviseUnlocked(store, id, patch, { ...opts, file, keyHash, requestHash });
    if (result && !result.already && (result.idempotent !== true || result.recovered === true)) {
      try { rememberIdempotency(file, store, keyHash, result, requestHash); }
      catch (e) { return { ...result, receiptWarning: String(e.message) }; }
    }
    return result;
  });
}

export function acceptProposal(store, id, opts = {}) {
  if (!['canon', 'orphan'].includes(store)) throw new Error('accept 只适用于 canon / orphan');
  const file = opts.file || opts.storeFile || storePath(store);
  return withFileLock(file, () => {
    const records = loadStore(store, file).records;
    const superseded = new Set(records.map((r) => r.supersedes).filter((v) => typeof v === 'string' && v !== ''));
    const revoked = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
    const retired = new Set(records.filter((r) => typeof r.retires === 'string' && r.retires !== '' && !revoked.has(r.id)).map((r) => r.retires));
    const current = records.find((r) => r.id === id && !superseded.has(r.id) && !retired.has(r.id) && !r.retires && !r.revokes);
    if (!current) throw new Error('找不到当前提案：' + id);
    if (current.status !== 'proposed') throw new Error('该记录不是 proposed：' + id);
    return reviseUnlocked(store, id, { status: 'accepted', accepted_by: opts.accepted_by || 'cli', accepted_at: new Date().toISOString() }, { ...opts, file, proposalToken: ACCEPT_PROPOSAL_TOKEN, expectedId: id });
  });
}

function reviseUnlocked(store, id, patch, opts) {
  const records = loadStore(store, opts.file).records;
  // recog 等调用方的「锁内守卫」：在读到最新记录后、写任何一版前执行。
  if (typeof opts.guard === 'function') {
    const g = opts.guard(records);
    if (g && g.already) return { store, id, already: true, guard: g };
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  const found = byId.get(id);
  if (!found) throw new Error('找不到记录：' + id);
  // F01（2026-10-14 外部审查 · GPT）：**状态迁移字段不得经普通修订写入**——否则可借普通条目的 patch 夹带
  //   `retires:<协议条>` 把受保护协议条从当前集抹掉（且 check 零报错）。supersedes / rollback_of 同理：
  //   它们只由 revise / retire / revoke / rollback 这些**专门函数**生成，普通 patch 一律只许内容字段。
  const STATE_FIELDS = ['supersedes', 'retires', 'revokes', 'rollback_of', 'rolled_back', 'retired_at', 'retired_reason'];
  const illegal = STATE_FIELDS.filter((k) => patch && patch[k] !== undefined);
  if (illegal.length) throw new Error('状态迁移字段不可经普通修订写入（' + illegal.join(' / ') + '）：退役用 retire、撤销用 revoke、回滚用 rollback、修订用 revise');
  const proposalPatch = ['status', 'proposed_by'].filter((k) => Object.prototype.hasOwnProperty.call(patch || {}, k));
  if (proposalPatch.length && opts.proposalToken !== ACCEPT_PROPOSAL_TOKEN) throw new Error('提案状态字段不可经普通修订写入（' + proposalPatch.join(' / ') + '）：提案走 add，采纳走 accept');
  let tip = found;
  const seenRevise = new Set([tip.id]);
  for (;;) {
    const next = records.find((r) => r.supersedes === tip.id);
    if (!next || seenRevise.has(next.id)) break;
    seenRevise.add(next.id);
    tip = next;
  }
  // F14（2026-10-14 外部审查 · GPT）：**退役链默认拒绝普通修订**——否则用历史 id 修订会悄悄生成新版本复活
  //   （无显式 revoke）。恢复走显式通道（revokeRetire / sleep --revoke），或显式 allowRetired。
  const revokedSet = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
  if (opts.allowRetired !== true && records.some((r) => r.retires === tip.id && !revokedSet.has(r.id))) {
    throw new Error('该链已退役（' + tip.id + '）——普通修订不复活退役记忆；恢复请先 revoke（revokeRetire / sleep --revoke），或显式 allowRetired:true');
  }
  const chain = [tip];
  let cursor = tip;
  while (cursor.supersedes && byId.has(cursor.supersedes)) { cursor = byId.get(cursor.supersedes); chain.unshift(cursor); }
  if (opts.keyHash) {
    const previous = records.filter((r) => r._akasha_write_key === opts.keyHash && r._akasha_store === store);
    if (previous.length) {
      if (previous.some((r) => r._akasha_request_hash !== opts.requestHash)) throw idemError('idempotency_conflict', 'idempotency_conflict：同一 key 对应不同请求');
      const hit = previous[0];
      let hitRoot = hit;
      while (hitRoot.supersedes && byId.has(hitRoot.supersedes)) hitRoot = byId.get(hitRoot.supersedes);
      return { store, id: hit.id, supersedes: hit.supersedes, root: hitRoot.id, idempotent: true, recovered: true };
    }
  }
  if (opts.expectedId != null && String(opts.expectedId) !== tip.id) {
    const error = new Error(`stale_input：期望链尾 ${opts.expectedId}，实际 ${tip.id}`);
    error.code = 'stale_input';
    throw error;
  }
  const root = chain[0];
  const newId = `${root.id}-r${chain.length}`;
  if (byId.has(newId)) throw new Error('修订 id 冲突：' + newId);
  const next = { ...tip, ...patch, id: newId, supersedes: tip.id };
  delete next._akasha_write_key;
  delete next._akasha_request_hash;
  delete next._akasha_store;
  if (opts.keyHash) { next._akasha_write_key = opts.keyHash; next._akasha_request_hash = opts.requestHash; next._akasha_store = store; }
  // R13（GPT 复核二轮）：**内容修订不继承状态事件元数据**——tip 若是回滚产物（带 `rollback_of`），普通 revise 复制它
  //   会让后续 rollback 把这条内容修订当「回滚事件自身」跳过（"回滚后编辑无法再次回滚"）。一次性状态字段在此清除。
  delete next.rollback_of;
  // 修订 = 一次新写入：logged_at 不继承旧版（SCHEMA：修订链每行都有 ⇒「何时被改」可查）；补丁显式自带则保留
  if (patch.logged_at === undefined) delete next.logged_at;
  const errs = validateRecord(store, next);
  if (errs.length) throw new Error('校验失败：' + errs.join('；'));
  appendRecord(store, next, { file: opts.file, locked: true });
  return { store, id: newId, supersedes: tip.id, root: root.id };
}

export function checkRetires(store, records) {
  const ids = new Set(records.map((r) => r.id));
  const errors = [];
  for (const r of records) {
    if (r.retires !== undefined && !ids.has(r.retires)) {
      errors.push({ store, id: r.id, errors: ['retires 指向不存在的 id：' + r.retires] });
    }
    if (r.revokes !== undefined && !ids.has(r.revokes)) {
      errors.push({ store, id: r.id, errors: ['revokes 指向不存在的 id：' + r.revokes] });
    }
  }
  return errors;
}

/** #3 不适用条件过滤（2026-10-12 窗口 2；依赖 #9 条件谓词化）：只读、不改原数组。
 *  - 无 `not_applicable` 字段的条目不受影响（旧数据零破坏）；
 *  - ctx 为空/缺省 ⇒ 不过滤（缺上下文不等于"不适用"）；
 *  - 命中 ⇒ 排除，并在 excluded 里留痕（id + reason，可审计）；非法条件由 validateCondition 抛错（绝不静默放宽）。 */
export function filterNotApplicable(rows, ctx = null) {
  const list = Array.isArray(rows) ? rows : [];
  if (ctx === null || typeof ctx !== 'object') return { matched: list.slice(), excluded: [] };
  if (!Object.keys(ctx).length) return { matched: list.slice(), excluded: [] };
  const matched = [];
  const excluded = [];
  for (const r of list) {
    if (r && r.not_applicable !== undefined) {
      if (evalCondition(r.not_applicable, ctx)) { excluded.push({ id: r.id ?? null, reason: 'not-applicable' }); continue; }
    }
    matched.push(r);
  }
  return { matched, excluded };
}

/** #18 冲突检测（2026-10-12 窗口 1）：同主题**机械对照**，只提示不裁决。
 *  只读、不改写、不合并（同题多源不合并红线）；候选对上限以常数封顶，防大库爆量。 */
/** 显式撤回/更正类标记（2026-10-12 真库校准：**不用**「不/无」等高频字——凡长文皆有，判据失效）。
 *  语义方向固定：「一侧显式宣布某结论作废/不再成立」+「另一侧讲同一件事」⇒ 报候选。 */
const CONFLICT_MARKERS = ['作废', '失效', '不再成立', '已废弃', '已放弃', '已推翻', '已排除', '被拒', '拒绝采纳', '撤回', '取消采用'];
export function detectConflicts(storeRecords, opts = {}) {
  const GENERIC = new Set(['同一', '主题', '相关', '内容', '记录', '问题', '进行', '使用', '可以', '需要', '当前', '已经', '不是', '没有']);
  /** 对照用 token：词级（tokenize）+ **CJK 二字组**（中文无空格 ⇒ 词级撞不上；对齐检索侧 bigram 回退同一思路）。 */
  const conflictTokens = (hay) => {
    const out = new Set();
    for (const t of tokenize(hay)) {
      if (t.length >= 2 && !GENERIC.has(t)) out.add(t);
      for (let i = 0; i + 2 <= t.length; i += 1) {
        const g = t.slice(i, i + 2);
        if (!CJK_RE.test(g)) continue;
        if (/[。，、；：（）「」『』！？—…·]/.test(g)) continue;   // 去标点混入（真库校准：。结 / 度） 这类不算词）
        if (g.length === 2 && !GENERIC.has(g)) out.add(g);
      }
    }
    return out;
  };
  const markerHits = (t) => CONFLICT_MARKERS.filter((m) => t.includes(m)).sort();
  const out = [];
  const cap = Number.isInteger(opts.max) ? opts.max : 200;
  const minOverlap = Number.isInteger(opts.minOverlap) ? opts.minOverlap : 3;
  const minRatio = typeof opts.minRatio === 'number' ? opts.minRatio : 0.02;    // Jaccard 下限（真库校准：只有"真讲同一件事"才越过）
  const rareCapAbs = Number.isInteger(opts.rareCapAbs) ? opts.rareCapAbs : 3;   // 稀有词绝对频率上限（比 5% 份额更严：真库 260 条时 5%≈13 太宽）
  const topN = Number.isInteger(opts.top) ? opts.top : 20;
  for (const [store, rows] of Object.entries(storeRecords ?? {})) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === 'object' && isStr(r.id)).slice(0, 5000); // 大库封顶（超上限不静默——见下 note）
    const hays = list.map((r) => [r.claim, r.summary, r.title, r.gist, r.line, r.behavior, r.term].filter((x) => typeof x === 'string').join(' '));
    const toks = hays.map((h) => conflictTokens(h));
    // 稀有词过滤（2026-10-12 真库校准）：高频泛用词（文件/可用/解析…）不构成「同一件事」的证据。
    const df = new Map();
    for (const s of toks) for (const t of s) df.set(t, (df.get(t) || 0) + 1);
    const keep = (t) => (df.get(t) || 0) <= rareCapAbs;
    const byId = new Map(list.map((r) => [r.id, r]));
    // 已被修订链显式处置的关系（B 是 A 的祖先或后代）不算候选——那是「已裁决」，不是「待裁决」。
    const relatedByChain = (x, y) => {
      let c = byId.get(x); const seen = new Set();
      while (c && isStr(c.supersedes) && !seen.has(c.id)) { seen.add(c.id); if (c.supersedes === y) return true; c = byId.get(c.supersedes); }
      return false;
    };
    // 语义方向：只从「显式撤回侧」出发（一侧宣布作废 + 另一侧讲同一件事 ⇒ 候选）。
    const marked = [];
    for (let i = 0; i < list.length; i += 1) { const m = markerHits(hays[i]); if (m.length) marked.push([i, m]); }
    for (const [i, mi] of marked) {
      for (let j = 0; j < list.length; j += 1) {
        if (j === i) continue;
        if (relatedByChain(list[i].id, list[j].id) || relatedByChain(list[j].id, list[i].id)) continue;
        const keepI = [...toks[i]].filter(keep);
        const common = keepI.filter((x) => toks[j].has(x) && keep(x));
        if (common.length < minOverlap) continue;
        const jRare = [...toks[j]].filter(keep).length;
        const ratio = common.length / Math.max(1, keepI.length + jRare - common.length);   // Jaccard（稀有词面）
        if (ratio < minRatio) continue;
        out.push({ store, a: list[i].id, b: list[j].id, overlap: common.length, ratio: +ratio.toFixed(4), common: common.slice(0, 6), markers: { a: mi, b: markerHits(hays[j]) }, note: '只提示不裁决：作废侧与同题另一条并存，是否真冲突请人工裁定（修订链处置）' });
      }
    }
    if (list.length >= 5000 && out.length < cap) out.push({ store, a: null, b: null, note: '已截断：本库超过 5000 条，本轮只对前 5000 条做候选对照（未静默）' });
  }
  out.sort((x, y) => (y.ratio - x.ratio) || (y.overlap - x.overlap));
  const seenPair = new Set();   // A×B 与 B×A 只留一条（质量高者在前，见排序）
  const uniq = [];
  for (const p of out) {
    const key = [p.a, p.b].sort().join('|');
    if (seenPair.has(key)) continue;
    seenPair.add(key); uniq.push(p);
    if (uniq.length >= topN) break;
  }
  return uniq;
}
/**
 * #6 关系边（2026-10-12 窗口 1）：关系目标悬空检查。
 *  解析规则（两层，防「修订 id 误报」）：① 精确命中任何行 id；② 按修订 id 形状 `root-rN` 解析到根 id（记录里存在该根）。
 *  只查**同库**（canon/orphan 等互引留待需要时再开跨库；孤儿引用在源库即错）。无该字段的记录零成本跳过。 */
export function checkRelations(store, records) {
  const ids = new Set(records.map((r) => r.id));
  const roots = new Set(records.map((r) => String(r.id ?? '').replace(/-r\d+$/, '')));
  const resolve = (t) => ids.has(t) || roots.has(String(t).replace(/-r\d+$/, ''));
  const errors = [];
  for (const r of records) {
    const bad = [];
    for (const t of (Array.isArray(r.relates_to) ? r.relates_to : [])) {
      if (!resolve(t)) bad.push('relates_to 指向不存在的 id：' + t);
    }
    for (const it of (Array.isArray(r.relations) ? r.relations : [])) {
      if (!it || typeof it !== 'object') continue;
      if (isStr(it.id) && !resolve(it.id)) bad.push('relations[].id 指向不存在的 id：' + it.id);
    }
    if (bad.length) errors.push({ store, id: r.id, errors: bad });
  }
  return errors;
}

// 退役（2026-10-08，用户裁定）：把一条记录（及其整条修订链）移出「当前集」。
//   hard=false（默认）：追加墓碑记录（克隆链尾 + id 后缀 -retired + retires 指针）——append-only 不破，
//                        可追溯「谁在何时因何退役」，且不再出现在任何 currentRecords 视图里。
//   hard=true         ：把该 id 的整条链与墓碑行从文件里删掉，删前把被删行备份到 data/_trash/<日期>-<store>.jsonl。
// 返回值：{ store, id, retired, tombstone?, hard, removed?, trash? }
export function retireRecord(store, id, opts = {}) {
  if (!STORES.includes(store)) throw new Error('未知存储：' + store);
  const file = opts.file || storePath(store);
  // wave1：读→判→写整段持锁（此前硬删在锁外整文件重写——与并发 appendRecord 竞争时会吞掉新行）。
  return withFileLock(file, () => retireRecordUnlocked(store, id, opts, file));
}

function retireRecordUnlocked(store, id, opts, file) {
  quarantineTail(file);   // 2026-10-19 审查 P1-4：硬删会整文件重写——先把坏尾搬走，避免坏行被静默丢弃
  const hard = opts.hard === true;
  const reason = typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : '';
  const records = loadStore(store, file).records;
  // recog 等调用方的「锁内守卫」：在读到最新记录后、写墓碑前执行。
  if (!hard && typeof opts.guard === 'function') {
    const g = opts.guard(records);
    if (g && g.already) return { store, id, retired: id, already: true, hard: false, guard: g };
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  if (!byId.has(id)) throw new Error('找不到记录：' + id);

  // 链尾（与 revise 同语义：从任意链上版本出发都落到链尾）
  let tip = byId.get(id);
  const seenTip2 = new Set([tip.id]);
  for (;;) {
    const next = records.find((r) => r.supersedes === tip.id);
    if (!next || seenTip2.has(next.id)) break;
    seenTip2.add(next.id);
    tip = next;
  }
  // 已退役的判定只对「软退役」短路（2026-10-08 二次修复：硬删必须继续走下去——
  // 否则对已退役条目执行 --hard 会静默返回 already、什么也不删，复活出来的重复行就清不掉）。
  // 2026-10-14 复检：already 判定须**忽略已被撤销的墓碑**——否则 revoke 之后再退役会静默 no-op（revoke→再 apply 断开）。
  const revokedSet = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
  if (!hard && records.some((r) => r.retires === tip.id && !revokedSet.has(r.id))) {
    return { store, id: tip.id, retired: tip.id, already: true, hard: false };
  }

  // 该 id 名下全部版本
  const chainIds = new Set([tip.id]);
  let cursor = tip;
  while (cursor.supersedes && byId.has(cursor.supersedes)) { cursor = byId.get(cursor.supersedes); chainIds.add(cursor.id); }

  if (hard) {
    const dropIds = new Set(chainIds);
    // F15（2026-10-14 外部审查 · GPT）：闭包 = 链版本 ∪ **全部墓碑（含已撤销）** ∪ **指向被删墓碑的撤销元数据行**
    //   ——否则残留 '-retired-revoked' 行并造成 revokes / retires 悬空引用（checkAll 报错，链删除不完整）。
    for (const r of records) if (isStr(r.retires) && dropIds.has(r.retires)) dropIds.add(r.id);
    for (let grew = true; grew;) {
      grew = false;
      for (const r of records) if (isStr(r.revokes) && dropIds.has(r.revokes) && !dropIds.has(r.id)) { dropIds.add(r.id); grew = true; }
    }
    const removed = records.filter((r) => dropIds.has(r.id));
    const keep = records.filter((r) => !dropIds.has(r.id));
    // 回收站跟着存储文件走（真库 = DATA/_trash，与此前一致）；此前固定写 DATA/_trash，
    // 用临时 opts.file 的自检会把夹具行写进示例库目录。
    const trashDir = join(dirname(file), '_trash');
    mkdirSync(trashDir, { recursive: true });
    const trash = join(trashDir, todayLocal() + '-' + store + '.jsonl');
    // 顺序：先落回收站（fsync）再原子替换——任一步崩溃都不丢数据（最坏是回收站多一份）。
    if (removed.length) {
      const fd = openSync(trash, 'a');
      try { writeSync(fd, removed.map((r) => JSON.stringify(r)).join('\n') + '\n'); fsyncSync(fd); }
      finally { closeSync(fd); }
    }
    writeFileAtomic(file, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    return { store, id: tip.id, retired: tip.id, hard: true, removed: removed.length, trash };
  }

  let tombId = tip.id + '-retired';
  for (let n = 2; records.some((r) => r.id === tombId); n += 1) tombId = tip.id + '-retired-' + n;   // 复检：再退役（撤销之后）须落新墓碑、不撞 id
  const tomb = { ...tip, id: tombId, retires: tip.id, retired_at: new Date().toISOString() };
  if (reason) tomb.retired_reason = reason;
  // N03（GPT 第三轮）：`extra` = **背景字段**（如 sleep_plan_id / sleep_op_id）随墓碑持久化——归属可核（结构化匹配）。
  if (opts.extra && typeof opts.extra === 'object') for (const [k, v] of Object.entries(opts.extra)) if (tomb[k] === undefined) tomb[k] = v;
  delete tomb.logged_at;   // 与 revise 一致：墓碑自成一版，盖自己的写入时间戳
  appendRecordUnlocked(store, tomb, file, {});   // 已在 retireRecord 的锁内（锁不可重入）
  return { store, id: tip.id, retired: tip.id, tombstone: tomb.id, hard: false, reason };
}

// 撤销退役（2026-10-14；SCHEMA §P4「revokes」语义落地）：**追加一条元数据记录** `{id: <墓碑>-revoked, revokes: <墓碑 id>}`——
//   原文一字不动、墓碑保留（可追溯），`currentRecords`/`retiredIds` 视该墓碑为未退役 ⇒ 该链回到当前集。
//   id 入参可以是「被退役的原 id」或「墓碑 id」；幂等：已撤销 ⇒ { already:true }；未退役 ⇒ note 说明。
export function revokeRetire(store, id, opts = {}) {
  if (!STORES.includes(store)) throw new Error('未知存储：' + store);
  const file = opts.file || storePath(store);
  return withFileLock(file, () => {
    const records = loadStore(store, file).records;
    const revoked = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
    const target = String(id);
    const tomb = records.find((r) => r.id === target && typeof r.retires === 'string')
      // 复检修（2026-10-14）：按原 id 找墓碑时**优先未撤销的那枚**——双重退役（retire→revoke→retire）场景下，
      //   首个墓碑可能早已被撤，直接 find 会命中旧墓碑而误报 already。
      || records.find((r) => r.retires === target && !revoked.has(r.id))
      || records.find((r) => r.retires === target);
    if (!tomb) return { store, id: target, revoked: null, already: false, note: '找不到该 id 的墓碑（可能未退役）' };
    if (revoked.has(tomb.id)) return { store, id: target, revoked: tomb.id, already: true };
    const base = { ...tomb };
    delete base.retires; delete base.retired_at; delete base.retired_reason; delete base.logged_at;
    const rec = { ...base, id: tomb.id + '-revoked', revokes: tomb.id, revoked_at: new Date().toISOString() };
    if (typeof opts.reason === 'string' && opts.reason.trim()) rec.revoked_reason = opts.reason.trim();
    appendRecordUnlocked(store, rec, file, { allowResurrect: true });
    return { store, id: target, revoked: tomb.id, record: rec.id };
  });
}

/** 字段级敏感值检查（2026-10-17，四项待裁之四，用户裁 A「拒写」）。
 *  写入门控此前只挡"直写 akasha/data/*.jsonl"（**文件面**），挡不住"经合法写入口把凭据写进记录"。
 *  - 只挡**高置信度**模式（实测六库 0 命中 ⇒ 不误伤、无需迁移历史）；JWT 等中置信度不在此列（会误伤靶场类内容）。
 *  - **拒绝**而不是静默脱敏：脱敏会让"写进去了"这件事消失，反而更危险。
 */
const SECRET_PATTERNS = [
  // 2026-10-18（VERIFY-D D3）：`sk-` 放行 `_ -` ⇒ sk-proj-/sk-svcacct 不再漏网；16 字符短样例仍不误伤（{20,}）。
  [/\bsk-[A-Za-z0-9_-]{20,}\b/, 'sk- 长串'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, 'GitHub PAT'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  // 私钥块：含 PGP / OPENSSH / ENCRYPTED 变体（`(?: BLOCK)?` 覆盖 PGP 的尾巴）。
  // 2026-10-18（VERIFY-F F6）：**要求正文**——只"提到 PEM 头"的文档不得整条拒（误伤 4/14）。
  //   在 JSON 文本里换行是 `\n` 两字符 ⇒ 用 `[\s\S]{0,8}` 跨过换行/转义，再要求 ≥16 位 base64 正文。
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8}[A-Za-z0-9+/=]{16,}/, '私钥块'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/, 'GitLab token'],
];
/** 字段级敏感拒写（六库写入路径）。2026-10-18 起导出：会话层写路径用它做**同一把尺子**的自检/测试。 */
export function assertNoSecrets(store, record) {
  var text = '';
  // 2026-10-18（VERIFY-F F5）：**序列化失败不得 fail-open**——带 stateful `toJSON` 的对象可让检查静默跳过、
  //   随后被写入。序列化不了 ⇒ 拒绝（写不进去比写进去更安全）。
  try { text = JSON.stringify(record); } catch (e) {
    throw new Error('拒绝写入：' + store + ' 记录无法序列化检查（' + String((e && e.message) || e).slice(0, 80) + '）。');
  }
  for (var i = 0; i < SECRET_PATTERNS.length; i += 1) {
    var re = SECRET_PATTERNS[i][0], label = SECRET_PATTERNS[i][1];
    var m = text.match(re);
    if (m) {
      throw new Error('拒绝写入：' + store + ' 记录里疑似凭据（' + label + '：' + String(m[0]).slice(0, 10) + '…）。'
        + '凭据不得入库；确有"脱敏样例"需要，请写成不构成完整模式的样式（如 sk-***）。');
    }
  }
}

function appendRecordUnlocked(store, obj, file, opts = {}) {
  // 2026-10-18（VERIFY-H H2b）：**检查与写盘必须是同一份数据**。带可变脸 `toJSON` 的对象可让
  //   检查时（第 1 次 stringify）返回安全值、写盘时（第 2 次）换成含凭据的值 ⇒ 原样落库。
  //   入口深拷贝一次（序列化即定型），之后 check / redact / write 都只碰这份纯对象。
  let record;
  try { record = JSON.parse(JSON.stringify(obj)); } catch (e) {
    throw new Error('拒绝写入：' + store + ' 记录无法序列化检查（' + String((e && e.message) || e).slice(0, 80) + '）。');
  }
  assertNoSecrets(store, record);
  // 防复活（2026-10-08）：已退役的 id 不得被静默重新追加——这正是当晚的实际事故
  // （脚本拿 currentRecords 判重 → 退役 id 不在当前集 → 被当新条目追加重放）。
  if (!opts.allowResurrect) {
    const existing = loadStore(store, file).records;
    if (retiredIds(existing).has(record.id)) {
      throw new Error(`id 已退役，拒绝复活：${record.id}（确需重加请传 { allowResurrect: true }，或改用一个新 id）`);
    }
    if (existing.some((r) => r.id === record.id)) throw new Error('重复 id：' + record.id);
  } else {
    // P4 立场（2026-10-14 实现）：**退役已被撤销**（存在 revokes 该墓碑）的 id，即便 allowResurrect 也拒绝再追加——
    //   它已恢复为当前版本，再追加会造成重复 id；要改内容请走 revise。
    const existing = loadStore(store, file).records;
    const revoked = new Set(existing.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
    if (existing.some((r) => r.retires === record.id && revoked.has(r.id))) {
      throw new Error('该 id 的退役已被撤销、已恢复为当前版本，要改走 revise：' + record.id);
    }
  }
  // 双时态（2026-10-07）：记录时间（logged_at）由写入路径统一盖戳——缺则盖、自带保留；
  // 事件时间（event_time）由作者写，不强制、不回填历史。
  if (record.logged_at === undefined) record.logged_at = new Date().toISOString();
  // 写入侧**深度**脱敏（2026-10-11 手检补）：原本只洗**顶层字符串** ⇒ 嵌套对象与数组元素**漏洗** ✗
  //   （实证：{ nested:{deep:'npm_…'} } / { arr:['npm_…'] } 都能原样落盘）⇒ 改为递归。
  const deep = redactDeep(record);
  for (const k of Object.keys(deep)) record[k] = deep[k];
  if (record.source && typeof record.source.ref === 'string') record.source = { ...record.source, ref: redact(record.source.ref) };
  const errs = validateRecord(store, record);
  if (errs.length) throw new Error('校验失败：' + errs.join('；'));
  mkdirSync(dirname(file), { recursive: true });
  const quar = quarantineTail(file);
  if (quar && quar.quarantined) console.error('[akasha] 已隔离损坏尾行 ' + quar.bytes + 'B → ' + quar.quarantined);
  const fd = openSync(file, 'a');
  try { writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  // P3 补（2026-10-20）：quarantineTail 截断长度可与新行列抵消 ⇒ 主动失效（O(1)）；其余写入签名本就必变。
  invalidateStoreCache(store);
  return { store, file, id: record.id, ...(quar && quar.quarantined ? { quarantine: quar } : {}) };
}

export function appendRecord(store, obj, opts = {}) {
  if (!STORES.includes(store)) throw new Error('未知存储：' + store);
  const file = opts.file || storePath(store);
  // P3（2026-10-20）：这里**不需要**主动 invalidate —— append 必然改变文件长度，
  //   而签名含 size ⇒ 下次 loadStore 必然 miss。
  //   首版曾在此调用 invalidateStoreCache，变异自证发现「删掉后三条守卫仍全绿」⇒ 判为冗余，已删。
  //   （invalidateStoreCache 仍导出，留给「原地重写且长度不变」的未来写入路径；当前无此路径。）
  return opts.locked ? appendRecordUnlocked(store, obj, file, opts) : withFileLock(file, () => appendRecordUnlocked(store, obj, file, opts));
}

/** 审核戳链校验（tripwire，2026-10-17）——**独立于工作区**的完整性守卫。
 *
 *  威胁模型：只比文件 sha 的旧口径发现不了"戳被回滚/替换"——把 REVIEW-STAMP.json 换回旧版，
 *  所有文件 sha 都对得上 ⇒ 旧实现照样报"无滞后"。这里用**追加式链**补这一层：
 *    ① 当前戳的 sha 必须等于链尾记录的 sha（否则＝戳被换过）
 *    ② 链内每条 prev 必须等于上一条 sha（否则＝链被改过）
 *    ③ 戳在而链不在 ⇒ 链被删（比 mtime 回拨更便宜的伪造路径）
 *  引导期：旧戳没有 `prev` 字段 ⇒ 返回 null（戳链尚未启用），避免首次部署假红。
 *
 *  @returns {string|null} 异常原因；null = 正常
 */
export function verifyStampChain(stampPath, chainPath) {
  if (!existsSync(stampPath)) return null;          // 没戳：调用方按 SKIP 处理（若链在，调用方 fail-closed——见 review-lag）
  let raw;
  try { raw = readFileSync(stampPath); } catch (e) { return '戳不可读：' + e.message; }
  let stamp = null;
  try { stamp = JSON.parse(raw.toString('utf8')); } catch { return '戳文件不可解析（JSON 坏了）'; }
  // P1（2026-10-18 VERIFY-D）：引导期豁免只对"链也还没有"成立；链已有内容而戳无 prev ⇒ 链头锚缺失（旧戳可无限复活）。
  if (!stamp || !stamp.prev) {
    if (existsSync(chainPath)) {
      let t = '';
      try { t = readFileSync(chainPath, 'utf8').trim(); } catch { /* 链读不了：交给下面"链缺失/不可读"分支 */ }
      if (t) return '戳缺 prev，但戳链存在（引导期不成立 ⇒ 链头锚缺失）';
    }
    return null;
  }
  const sha = createHash('sha256').update(raw).digest('hex');
  if (!existsSync(chainPath)) return '戳存在但 `stamp-chain.jsonl` 不在（链被删？）';
  let lines = [];
  try { lines = readFileSync(chainPath, 'utf8').split('\n').filter((l) => l.trim()); } catch (e) { return '戳链不可读：' + e.message; }
  if (!lines.length) return '戳链为空';
  // P1：**链长度锚**。戳记下"写戳后链应有几条"；删头/截断/只留尾都会让长度不符（自洽重写仍挡不住——那需要外锚，已知弱项）。
  if (!Number.isInteger(stamp.chainLen) || stamp.chainLen <= 0) return '戳缺 chainLen（链长度锚缺失 ⇒ 链可被截断/删头）';
  if (lines.length !== stamp.chainLen) return `链长度不符：现有 ${lines.length} 条 ≠ 戳记 ${stamp.chainLen} 条（截断 / 删头 / 异常增长？）`;
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    try { entries.push(JSON.parse(lines[i])); } catch { return `戳链第 ${i + 1} 行不可解析`; }
  }
  const last = entries[entries.length - 1];
  if (last.sha !== sha) return `戳与链不一致：当前戳 sha=${sha.slice(0, 16)}… ≠ 链尾 sha=${String(last.sha).slice(0, 16)}…（戳被回滚/替换？）`;
  for (let i = 1; i < entries.length; i += 1) {
    if (entries[i].prev !== entries[i - 1].sha) return `戳链断裂：第 ${i + 1} 条 prev 与第 ${i} 条 sha 不符`;
  }
  return null;
}
