// 阿卡夏之书 · 会话层（session layer）—— 单会话记忆（读取 / 抽取 / 索引 / 检索）。
// 设计稿：docs\superpowers\specs\2026-10-07-session-akasha-design.md（v0.4）
// 计划：docs\superpowers\plans\2026-10-07-session-layer-v0.md（阶段 1）
// 读取器移植自 ..\tools\session-scan.mjs（多帧 zstd 容器：按**帧结构**逐帧解压；2026-10-17 B-⑤ 起不再用魔数扫边界）。
import { readFileSync, appendFileSync, writeFileSync, readdirSync, mkdirSync, openSync, readSync, fstatSync, statSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';
import { homedir } from 'node:os';
import { skipTagsFor, resolvePorts } from './companion.mjs';
import { ROOT, DATA, STORES, loadStore, readJsonlLinesReverse, parseJsonlStream, storePath, tokenize, scoreTokens, matchParts, redact, redactDeep, writeFileAtomic, appendRecord, retiredIds, withFileLock, quarantineTail, validateRecord, stripGenre, GENRE_DOSE_DEFAULTS, doseGate, doseSummary, recordQuery, readDepthOf, projectText, agePrefix, READ_TIER, genreRenderOf, todayLocal } from './lib.mjs';

export const SESSION_DEFAULTS = {
  // 2026-10-15（GPT 复核 session N1）：默认值必须与核心**同口径**——`AKASHA_ROOT` 指向放 jsonl 的目录本身；
  // 原先写 join(ROOT,'data') 只认源码树 ⇒ 「指沙箱跑」时读面默认仍开真库（环境隔离失效）。默认布局下与旧值等价。
  storeFile: join(DATA, 'session.jsonl'),
  metaFile: join(DATA, 'session-meta.json'),
  sessionsRoot: process.env.AKASHA_SESSIONS_ROOT || join(process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'sessions')
};

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** zstd 能力探测（2026-10 复查）：`zlib.zstdDecompressSync` 自 Node v23.8.0 / v22.15.0 起才有。
 *  改为命名空间导入 + 调用时探测——旧 Node 上只有会话层报清楚的错，lib / CLI / MCP 其余功能照常加载。 */
export const ZSTD_MIN_NODE = '>=22.15.0（或 >=23.8.0）';
export function hasZstd() { return typeof zlib.zstdDecompressSync === 'function'; }
function zstdDecompressSync(buf) {
  if (!hasZstd()) throw new Error(`当前 Node ${process.version} 不支持 zstd 解压（会话层需要 Node ${ZSTD_MIN_NODE}）`);
  return zlib.zstdDecompressSync(buf);
}

/** 解析一帧的**结构边界**（帧头 + 块头；只读结构、不解压）。返回 `{ end, reason }`，end<0 表示结构性失败。
 *  依据 RFC 8878：Magic(4) + Frame_Header_Descriptor(1) + [Window_Descriptor] + [Dictionary_ID] +
 *  [Frame_Content_Size] + 若干 Block(3B 头 + 数据) + [Content_Checksum(4)]。
 *  块头：bit0=Last_Block，bit1-2=Type(0 Raw/1 RLE/2 Compressed/3 Reserved)，bit3-23=Block_Size。 */
function zstdFrameEnd(buf, start) {
  let p = start + 4;
  if (p >= buf.length) return { end: -1, reason: 'header' };
  const desc = buf[p++];
  if ((desc & 0x18) !== 0) return { end: -1, reason: 'reserved' };        // bit4 unused / bit3 reserved 必须为 0
  const fcsFlag = desc >>> 6, single = (desc >>> 5) & 1, checksum = (desc >>> 2) & 1, dictFlag = desc & 3;
  if (!single) p += 1;                                                    // Window_Descriptor
  p += [0, 1, 2, 4][dictFlag];                                            // Dictionary_ID
  p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];          // Frame_Content_Size
  if (p > buf.length) return { end: -1, reason: 'header' };
  let last = 0;
  while (!last) {
    if (p + 3 > buf.length) return { end: -1, reason: 'block-header' };
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    last = h & 1;
    const type = (h >>> 1) & 3, size = h >>> 3;
    p += 3;
    if (type === 3) return { end: -1, reason: 'block-reserved' };
    p += type === 1 ? 1 : size;                                           // RLE=1B；Raw/Compressed=size B
    if (p > buf.length) return { end: -1, reason: 'block-overrun' };
  }
  if (checksum) p += 4;
  if (p > buf.length) return { end: -1, reason: 'checksum' };
  return { end: p, reason: 'ok' };
}

/** skippable frame（magic 0x184D2A50..0x184D2A5F）的结束偏移；不是则 -1。合法容器允许它夹在帧之间。 */
function skippableFrameEnd(buf, p) {
  if (p + 8 > buf.length) return -1;
  const magic = buf.readUInt32LE(p);
  if (magic < 0x184d2a50 || magic > 0x184d2a5f) return -1;
  return p + 8 + buf.readUInt32LE(p + 4);
}

/** 读会话档案（多帧 zstd 拼接容器；单帧兼容）。坏容器抛错。
 *
 *  2026-10-17（B-⑤，审核「合法 zstd 帧被误报截断」）：帧边界改为**按帧结构走**，不再拿负载里的魔数当边界。
 *  旧实现的两处魔数启发式都能被**完全合法**的帧打红，且各自丢数据：
 *   ① 多帧分支把负载中出现的 `28 B5 2F FD` 当成新帧起点 ⇒ 合法单帧被切成两段：首段解压失败/半解、尾段必失败，
 *      既报 frameFails/frameTruncated，又把后半内容静默丢掉（实测：21 字节负载只读出前 8 字节）；
 *   ② 单帧分支把 `28 B5 2F` 前缀当「残缺第二帧」——但 raw block 可原样携带任意字节 ⇒ 合法负载命中即假红。
 *  启发式无法区分「压缩数据里的字节」与「真帧头」；唯一可靠判据是结构化证据。
 *  新口径：帧头/块头解析不出，或解压**真的**失败，才算坏（frameFails）；
 *  截断末帧照旧容错——不炸、能收多少内容收多少（v24.19 部分解压），置 frameTruncated=1，下游按 parseFails 丢半行。
 *  `frameMagicCandidates` 保留为纯观测计数（裸 `28 B5`），**不参与任何判定**。 */
export function readSessionArchive(filePath) {
  const buf = readFileSync(filePath);
  const hasMagic = (p) => p + 4 <= buf.length
    && buf[p] === ZSTD_MAGIC[0] && buf[p + 1] === ZSTD_MAGIC[1] && buf[p + 2] === ZSTD_MAGIC[2] && buf[p + 3] === ZSTD_MAGIC[3];
  // 观测计数：裸两字节命中（含负载里的巧合），仅供诊断；判定一律走结构。
  let magicCandidates = 0;
  for (let i = 1; i + 1 < buf.length; i += 1) if (buf[i] === 0x28 && buf[i + 1] === 0xb5) magicCandidates += 1;
  if (!hasZstd()) zstdDecompressSync(buf); // 能力缺失 → 抛清楚的版本错误（不被下面的「不是有效容器」吞掉）

  let firstMagic = -1;
  for (let i = 0; i + 4 <= buf.length; i += 1) if (hasMagic(i)) { firstMagic = i; break; }
  if (firstMagic < 0 && skippableFrameEnd(buf, 0) < 0) {
    // 一个完整魔数都没有、且**也不是**以 skippable 帧打头 ⇒ 整档当单帧解（空文件 ⇒ 空文本；非容器 ⇒ 抛错）。
    // 2026-10-17 复核 H1（低危真洞）：原来只看 `firstMagic < 0`，于是一个**只含 skippable**的容器会掉进这条遗留分支，
    //   绕过全部结构校验——声明 100B 实际 10B 的截断 skippable（18B 文件）仍报 trunc=0。补上第二个条件后走结构循环。
    let text = '';
    try {
      text = zstdDecompressSync(buf).toString('utf8');
    } catch (e) {
      throw new Error('不是有效的 zstd 会话容器：' + filePath + '（' + e.message + '）');
    }
    const tail = text.slice(text.lastIndexOf('\n') + 1).trim();
    let frameTruncated = 0;
    if (tail) { try { JSON.parse(tail); } catch { frameTruncated = 1; } }
    return { text, frames: 1, frameFails: 0, frameTruncated, frameMagicCandidates: magicCandidates };
  }

  // 从腐烂区之后找回下一个「结构可解析且真能解码」的帧（不把负载里孤立的魔数当真边界）。
  const findNextFrame = (from) => {
    for (let i = from; i + 4 <= buf.length; i += 1) {
      if (!hasMagic(i)) continue;
      const { end } = zstdFrameEnd(buf, i);
      if (end < 0) continue;
      try { zstdDecompressSync(buf.subarray(i, end)); return i; } catch { /* 假候选：结构像帧但解不开 */ }
    }
    return -1;
  };

  const parts = [];
  let frames = 0;
  let frameFails = 0;
  let frameTruncated = 0;
  let p = 0;
  while (p < buf.length) {
    const skipEnd = skippableFrameEnd(buf, p);
    if (skipEnd > 0) {
      if (skipEnd > buf.length) { frameFails += 1; frameTruncated = 1; break; }
      p = skipEnd; continue;
    }
    if (!hasMagic(p)) {
      // 帧与帧之间的残渣（例：帧1 + `28 B5 2F FE` + 帧2去头）⇒ 该区确实无法解码。
      frameFails += 1; frameTruncated = 1;
      const next = findNextFrame(p + 1);
      if (next < 0) break;
      p = next; continue;
    }
    frames += 1;
    const { end } = zstdFrameEnd(buf, p);
    if (end < 0) {
      // 结构截断（半写末帧）：不炸；v24.19 对截断帧会返回部分解压字节，收下它（v24.21 只回完整帧/抛错则可收为空）。
      frameFails += 1; frameTruncated = 1;
      try { const partial = zstdDecompressSync(buf.subarray(p)); if (partial.length) parts.push(partial); } catch { /* 无可用内容 */ }
      const next = findNextFrame(p + 1);
      if (next < 0) break;
      p = next; continue;
    }
    try {
      parts.push(zstdDecompressSync(buf.subarray(p, end)));
    } catch {
      frameFails += 1; frameTruncated = 1; // 结构完整但解压失败（损坏）：跳过不中断（Review Focus #1）
    }
    p = end;
  }

  const text = Buffer.concat(parts).toString('utf8');
  if (!frameTruncated) {
    // 文本完整性兜底：末行非空且 JSON 解析不出 ⇒ 截断（跨 node 版本稳健，v24.19 部分解压时用它兜底）。
    const tail = text.slice(text.lastIndexOf('\n') + 1).trim();
    if (tail) { try { JSON.parse(tail); } catch { frameTruncated = 1; } }
  }
  return { text, frames: frames || 1, frameFails, frameTruncated, frameMagicCandidates: magicCandidates };
}

/** 按会话 id 在 sessionsRoot 递归找档案，并回报**布局类型**：`{ file, child }`；未命中 null。
 *
 *  2026-10-17 修（session-index-error「未找到会话档案」全是子代理）：宿主有**两种**目录布局——
 *    ① 主会话：`session-<uuid>/session.v4.jsonl.zstd`（带前缀）
 *    ② 子代理：`<uuid>/session.v4.jsonl.zstd`（**裸 uuid，无前缀**）
 *  原实现假设"目录名恒为 `session-<id>`"，对子代理恒返回 null ⇒ 每回合刷一条错误。
 *  实测（<LOCAL_PATH>\official-home\sessions\--H-Harness--）：176 目录 = 157 带前缀（主）+ 19 裸 uuid（今日子代理）。
 *  `child:true` 表示命中的是裸名目录 ⇒ 调用方据此**跳过**（子代理转录不是"我的会话"，不该进小阿卡夏）。 */
export function resolveSessionArchive(sessionsRoot, sessionId) {
  const needle = String(sessionId ?? '');
  if (!needle) return null;
  const bare = needle.startsWith('session-') ? needle.slice('session-'.length) : needle;
  const names = ['session-' + bare, bare];   // ① 主会话布局 ② 子代理布局
  let incomplete = false;   // 有分支读不了 ⇒ 即使没找到也不能断言"确认不存在"
  const walk = (dir, isRoot) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (err) {
      // 2026-10-23 GPT 审查必改：根目录扫描失败 ≠ 档案不存在。
      //   原实现一律 return null ⇒ 调用方把"路径异常/无权限"误判为 not-found 并降级成 skip，掩盖真问题。
      //   根目录失败抛错（调用方 catch 后记 session-index-error）；子目录不可读仍视为"这一支没有"。
      if (isRoot) {
        const e = new Error('sessionsRoot 不可读：' + (err && err.message ? err.message : err));
        e.code = 'SCAN_FAILED';
        throw e;
      }
      incomplete = true;   // GPT 审查：普通子树读不了也要标记，否则会把"扫不全"当成"不存在"
      return null;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (!e.isDirectory()) continue;
      const idx = names.indexOf(e.name);
      if (idx !== -1) {
        try {
          for (const f of readdirSync(p)) if (f.endsWith('.zstd')) return { file: join(p, f), child: idx === 1 };
        } catch (err) {
          // 2026-10-23 GPT 审查（第二条必改）：命中目录名但读不了 ⇒ 不能断言"档案不存在"。
          //   与根目录同口径抛 SCAN_FAILED，由调用方记 session-index-error（而非降级成 skip）。
          const e = new Error('会话目录不可读：' + p + '：' + (err && err.message ? err.message : err));
          e.code = 'SCAN_FAILED';
          throw e;
        }
      }
      const deeper = walk(p, false);
      if (deeper) return deeper;
    }
    return null;
  };
  const hit = walk(sessionsRoot, true);
  if (!hit && incomplete) {
    const e = new Error('会话扫描不完整：存在不可读分支，无法断定档案不存在');
    e.code = 'SCAN_FAILED';
    throw e;
  }
  return hit;
}

/** 兼容旧调用：只要文件路径。 */
export function resolveSessionFile(sessionsRoot, sessionId) {
  return resolveSessionArchive(sessionsRoot, sessionId)?.file ?? null;
}

/** 折叠空白（纯函数）。 */
function cleanText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 首行（≤120 字，供 why）。 */
function firstLine(s) {
  const line = String(s ?? '').split(/\r?\n/).map((x) => x.trim()).find((x) => x);
  return line ? (line.length > 120 ? line.slice(0, 119) + '…' : line) : '';
}

/** 毫秒时间 → ISO（缺则空串）。 */
function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

/** 截断（超长加 …，总长 ≤ n）。 */
function cut(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** 机械关键词抽取：工具名 → 路径 → 「」引文 → ASCII 标识符 → 中文高频 bigram；去重 ≤12。 */
// 2026-10-18（VERIFY-G G2/R1）：**抽词前先剥掉私钥块整体**（含无 END 的截断块）——正文行/片段不会进入 token 流。
//   不按"词形"事后猜（KEY_BODY_RE 已由 G4 证伪并回退：会误删 45 字母词 / SHA-1 / SHA-256）；只影响派生索引 keywords。
const PEM_STRIP_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
// 2026-10-18 (VERIFY-K K4): JSON transcripts escape newlines as literal `\n`. extractSegments used to
// cut args/result BEFORE redaction, so a valid JSON-embedded PEM became an unparseable fragment and
// the armor rules (which require whitespace) missed it -- the body reached the gist. Strip armor from
// the FULL text first, tolerating real and JSON-escaped newlines, and require a body (>=16 base64 chars).
const PEM_ARMOR_STRIP_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,16}?(?:(?:\\[rn])|\s)*[A-Za-z0-9+/=]{16,}[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g;
function stripPemArmor(s) { return String(s ?? '').replace(PEM_ARMOR_STRIP_RE, '[redacted-private-key]'); }
function extractKeywords(text, tools = []) {
  const src = String(text ?? '').replace(PEM_STRIP_RE, ' ');
  const out = [];
  const seen = new Set();
  const add = (k) => {
    const v = String(k || '').trim();
    if (!v || seen.has(v) || out.length >= 12) return;
    seen.add(v);
    out.push(v);
  };
  for (const t of tools) add(t);
  for (const m of src.matchAll(/[A-Za-z]:\\[^\s"'|<>]+/g)) add(m[0].replace(/[。，、；：）？!.,;:)]+$/, ''));
  for (const m of src.matchAll(/「([^」]{1,40})」/g)) add(m[1]);
  for (const m of src.matchAll(/[A-Za-z][A-Za-z0-9_.-]{4,}/g)) add(m[0]);
  const bigrams = new Map();
  for (const m of src.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = m[0];
    for (let i = 0; i < run.length - 1; i += 1) {
      const g = run.slice(i, i + 2);
      bigrams.set(g, (bigrams.get(g) ?? 0) + 1);
    }
  }
  for (const [g, n] of [...bigrams.entries()].filter(([, n]) => n >= 2)) add(g);
  return out;
}

const KIND_LIMIT = { intent: 400, conclusion: 400, action: 360, process: 200 };

/** 体裁隔离 P0-②（2026-10-13）：哪些段类型属「模型产出」（＝读侧剥皮对象）——
 *  conclusion＝assistant 正文（produced-doc）· process＝思维链（thinking-raw）· node＝弧线树节点（机械摘要）。
 *  intent（用户原话＝user-said）与 action（工具/外部记录）**不剥**（错标/误剥哨兵）。 */
const SEG_STRIP_KINDS = new Set(['conclusion', 'process', 'node']);

// ── 脚手架过滤（2026-10-11 立；2026-10-11 深夜**前移到索引时**）──
// 原只用于"主题推断"，但索引侧同样中招：宿主的注入块（<system-reminder>、<hindsight_knowledge>、
// runtime context、库脉脉冲行、【起床包】、[坑前提示]…）会作为 `user/message` 落进 intent 段
// ⇒ 框架注入污染检索与主题统计。故本常量提到模块级、**生成意图段时一并过滤**（DRY，一处定义两处用）。
// 口径：**只影响派生索引**（session.jsonl），**原始会话日志一字不动** ✓（索引可重建，原文即真源）。
const SCAFFOLD_BASE = [
  '<system-reminder>', 'Current runtime context',
  '【阿卡夏·起床包】', '阿卡夏·睡眠：', '阿卡夏·库脉搏', '阿卡夏·称呼：', '小阿卡夏·会话层：',
  '[极限观测', '[约定]', '[坑前提示', '<memory uri=', 'This is an automatically generated checkpoint',
];
// 2026-10-19 CompanionPort：skipTags 由端口提供（默认含未来 ledger/persona 标签），不再写死单一品牌。
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const SCAFFOLD_RE = new RegExp([...SCAFFOLD_BASE, ...skipTagsFor(resolvePorts())].map(escapeRe).join('|'));

/** 轻量内容指纹（djb2 → 8 hex）：同内容幂等、变内容追加新版（F2 漂移修复；不引 crypto）。 */
function fp8(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** 会话 id 归一（2026-10-15，P1 审计）：宿主两种形态（裸 uuid / `session-<uuid>`）经 resolveSessionFile
 *  解析到**同一档案**，而我们历史上按两种形态分别落段 ⇒ 库里出现孪生（真库跨键同内容 5376 行）。
 *  约定：**入口一律存裸形态**；读侧用 sessionMatches 兼容老键（两种形态都能查到同一批段）。 */
export function normalizeSid(s) { return String(s ?? 'unknown').replace(/^session-/, '') || 'unknown'; }
// 2026-10-15 全量检查（Lead 修）：`sessionMatches` 原先**只归一左边**（`normalizeSid(v) === sid`）——
// 当库里两种写法**并存**时（真库：裸 37012 行 + 前缀 2820 行），`resolveSessionPrefix` 会提前返回**前缀形态**的键，
// 于是右侧的 `sid` 是前缀、左侧归一后是裸 ⇒ **恒不匹配**（实测：前缀写法命中 0）。两边都归一才对。
function sessionMatches(v, sid) { return normalizeSid(v) === normalizeSid(sid); }

function makeSeg(sid, sid8, { seq, time, turn, step, kind, gist, why, keywords, tools, ptr }) {
  const rec = {
    store: 'session',
    session: sid,
    seq,
    time: time || '',
    turn: Number.isInteger(turn) ? turn : null,
    step: Number.isInteger(step) ? step : null,
    kind,
    // ⚠️ 索引写入路径**必须**脱敏（2026-10-11 手检实证：intent 路径曾绕过本函数 ⇒ 真 npm token 明文落进 session.jsonl ✗）。
    //    凡在此之外内联构造段的地方，gist 同样要套 redact（见下方三处）✓
    gist: redact(cut(cleanText(stripPemArmor(gist)), KIND_LIMIT[kind] ?? 400))
  };
  if (why) rec.why = redact(cut(cleanText(stripPemArmor(why)), 120));
  // 2026-10-18（VERIFY-G G4）：**不做**按"整词形态"过滤 keyword 的封口——实测会把 45 字母单词 / SHA-256(64 hex) /
  //   SHA-1(40 hex) 一起删掉，且对真实 PEM（+/ 被切碎成长 24–28 片段）无效 ⇒ 代价实、收益虚，已回退。
  //   正解在下一批：**抽词前剥 PEM 块**（BEGIN..END 整段正则），而不是事后按词形猜。
  rec.keywords = (keywords ?? []).map((k) => redact(k));
  rec.tools = tools ?? [];
  rec.ptr = ptr ?? {};
  rec.id = `seg-${sid8}-${seq}-${fp8(JSON.stringify([rec.kind, rec.gist, rec.why ?? '', rec.tools]))}`;   // 2026-10-15（GPT 复核 session N3）：指纹原先用 `|` 裸拼接 ⇒ gist 里带分隔符即边界位移、可撞；改为与内容键同口径的转义
  return rec;
}

const contentText = (content) =>
  Array.isArray(content) ? content.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join(' ') : '';

/** 记录数组 → 段数组（纯函数；v0.1 机械启发式）。段序：assistant 内 conclusion 先、process 后。
 *  emitFrom：**配对/状态按传入的全量记录维护**（修复「中途索引切批 → 调用与结果分属两批」的漏配），
 *  但只输出「须新产出」的段：emitFrom=0 ⇒ 全量输出（--full 重建）。判定按下面两条**明确规则**（2026-10-12 二次复查同步注释）：
 *    ① 未配对冲刷（pending 残余）：`callSeq > emitFrom` **且** `callSeq ∉ recordedUnpaired`（后者防全量重建重复冲刷，靠 id 去重是最后兜底而非唯一防线）；
 *    ② 配对完成版：`resultSeq > emitFrom` **或** `callSeq ∉ completedCallSeqs`（后者即「迟到结果补发」修复，见下）。
 *  completedCallSeqs（2026-10-12 配对 emit 门修复）：库中**已有完成版**的 ptr.callSeq 集合。
 *  修复的洞：冲刷推进水位后，迟到结果（seq ≤ emitFrom）此前被整条吞掉 ⇒ **完成版永不落库**（注释「结果后到 → 走完成版」与实现不符）。
 *  修法（消除闸门、不绕幂等）：结果配对成功且 `callSeq ∉ completedCallSeqs` ⇒ **强制 emit**（与 emitFrom 无关）；已在集内 ⇒ 照旧跳过（靠 id 去重兜底）。 */
export function extractSegments(records, { session, emitFrom = 0, completedCallSeqs = null, recordedUnpaired = null } = {}) {
  const sid = normalizeSid(session);
  // 会话短键（2026-10-15，E 题审计确证 V2；同日二轮审计 D1 修正）：原 `sid.slice(0, 8)` 在 `session-` 前缀上**恒等于 `session-`**。
  // 二轮修正要点：**指纹必须取全 8 hex**——`fp8(sid).slice(0,4)` 是 djb2 高 16 位，对「仅末尾 1 字符不同」的 id **恒定不敏感**
  // （实测 4/4 高 4 hex 相同）⇒ 只加 4 hex 等于没修。全 8 hex 的低位含末字符信息，敏感 ✓
  const sid8 = `${sid.slice(0, 8)}-${fp8(sid)}`;
  const out = [];
  const pending = new Map();
  const lastReasoning = new Map();
  const doneSet = completedCallSeqs && typeof completedCallSeqs.has === 'function' ? completedCallSeqs : null;
  const unpairedSet = recordedUnpaired && typeof recordedUnpaired.has === 'function' ? recordedUnpaired : null;
  // 迟到结果是否值得补发：配对成功且库中尚无完成版 ⇒ 强制 emit（消除「水位推进吞掉结果」的闸门；幂等靠 id 去重）。
  const emitPair = (rSeq, callSeq) => (rSeq > emitFrom || (doneSet != null && !doneSet.has(callSeq)));
  const list = Array.isArray(records) ? records : [];
  list.forEach((rec, i) => {
    if (!rec || typeof rec !== 'object') return;
    const seq = Number.isInteger(rec.seq) ? rec.seq : i + 1;
    const time = iso(rec.time);
    const d = rec.data ?? {};
    const turn = d.turn ?? null;
    const step = d.step ?? null;
    if (rec.type === 'user/message') {
      const text = contentText(d.content);
      // 脚手架过滤（2026-10-11 深夜修）：注入块不是用户意图 ⇒ 不生成 intent 段（详见 SCAFFOLD_RE 注释）。
      if (text && seq > emitFrom && !SCAFFOLD_RE.test(text)) out.push(makeSeg(sid, sid8, { seq, time, turn, step, kind: 'intent', gist: redact(text), keywords: extractKeywords(text), ptr: { seq } }));
    } else if (rec.type === 'assistant/message') {
      const items = Array.isArray(d.message?.content) ? d.message.content : [];
      const textItem = items.find((x) => x && x.type === 'text' && typeof x.text === 'string');
      const reasoningItem = items.find((x) => x && (x.type === 'reasoning' || x.type === 'thinking') && typeof x.text === 'string');
      if (reasoningItem) lastReasoning.set(`${turn}:${step}`, firstLine(reasoningItem.text));
      if (textItem && seq > emitFrom) out.push(makeSeg(sid, sid8, { seq, time, turn, step, kind: 'conclusion', gist: redact(textItem.text), keywords: extractKeywords(textItem.text), ptr: { seq } }));
      if (reasoningItem && seq > emitFrom) out.push(makeSeg(sid, sid8, { seq, time, turn, step, kind: 'process', gist: redact(reasoningItem.text), keywords: extractKeywords(reasoningItem.text), ptr: { seq } }));
    } else if (rec.type === 'tool/call') {
      const callId = d.callId ?? `seq-${seq}`;
      pending.set(callId, { seq, time, turn, step, name: String(d.name ?? '?'), args: String(d.arguments ?? '') });
    } else if (rec.type === 'tool/result') {
      const callId = d.toolCallId ?? d.message?.toolCallId;
      const p = callId ? pending.get(callId) : null;
      if (p) {
        pending.delete(callId);
        if (emitPair(seq, p.seq)) {
          const resultText = contentText(d.content) || contentText(d.message?.content);
          const why = lastReasoning.get(`${p.turn}:${p.step}`) ?? '';
          const argsSafe = stripPemArmor(p.args);
          const resultSafe = stripPemArmor(resultText);
          const gist = `${p.name}：${cut(cleanText(argsSafe), 120)} ↳ ${cut(cleanText(resultSafe), 160)}`;
          out.push(makeSeg(sid, sid8, { seq, time, turn: p.turn, step: p.step, kind: 'action', gist, why, keywords: extractKeywords(gist + ' ' + argsSafe, [p.name]), tools: [p.name], ptr: { seq, callSeq: p.seq } }));
        }
      }
    }
  });
  for (const p of pending.values()) {
    if (p.seq <= emitFrom) continue;                                   // 旧批未配对不再重复冲刷（其残更早已留档）
    if (unpairedSet != null && unpairedSet.has(p.seq)) continue;        // 已有「（无结果）」记录 ⇒ 不重复冲刷（全量重建友好，见函数头②）
    const why = lastReasoning.get(`${p.turn}:${p.step}`) ?? '';
    const argsSafe = stripPemArmor(p.args);
    const gist = `${p.name}：${cut(cleanText(argsSafe), 120)}（无结果）`;
    out.push(makeSeg(sid, sid8, { seq: p.seq, time: p.time, turn: p.turn, step: p.step, kind: 'action', gist, why, keywords: extractKeywords(gist + ' ' + argsSafe, [p.name]), tools: [p.name], ptr: { seq: p.seq, callSeq: p.seq } }));
  }
  return out;
}

/** 段批量追加（append-only；自动盖 logged_at）。 */
export function appendSegments(storeFile, segs) {
  mkdirSync(dirname(storeFile), { recursive: true });
  quarantineTail(storeFile);   // 2026-10-19 审查 P1-7：最大 append-only 文件也要防「半行 + 后续追加粘行」（调用方持锁）
  const existing = existingRecordDigests(storeFile);
  let added = 0;
  let skipped = 0;
  let redacted = 0;
  for (const seg of segs) {
    const rec = { ...seg };
    if (rec.logged_at === undefined) rec.logged_at = new Date().toISOString();
    // 2026-10-18（VERIFY-D D3）：会话层是**外部转录的派生索引**——拒绝写入会让索引卡死，
    //   故此路径走**脱敏**（六库仍是拒写）；凭据形态由 REDACT_RES 覆盖（含 sk-proj / PEM / PGP 变体）。
    const safe = redactDeep(rec);
    if (JSON.stringify(safe) !== JSON.stringify(rec)) redacted += 1;
    const prior = typeof safe.id === 'string' ? existing.get(safe.id) : null;
    if (prior && prior.digest === stableDigest(safe)) { skipped += 1; continue; }
    appendFileSync(storeFile, JSON.stringify(safe) + '\n', 'utf8');
    if (typeof safe.id === 'string') existing.set(safe.id, { digest: stableDigest(safe), treegen: Number(safe.treegen) || 0 });
    added += 1;
  }
  return { added, skipped, redacted };
}

function readMeta(metaFile) {
  let source;
  try { source = readFileSync(metaFile, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const meta = JSON.parse(source);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)
      || (meta.sessions !== undefined && (!meta.sessions
          || typeof meta.sessions !== 'object' || Array.isArray(meta.sessions)))) {
    throw new TypeError('invalid session meta shape');
  }
  return meta;
}

// Keep the migration key independent of segment ID shape and delimiter contents.
function segmentContentKey(r) {
  return Number.isInteger(r.seq)
    ? JSON.stringify([r.seq, r.kind, r.gist, r.why ?? '', Array.isArray(r.tools) ? r.tools : String(r.tools ?? '')])
    : `id:${r.id}`;
}

function readIndexSnapshot(storeFile, sid) {
  const snapshot = {
    existing: new Set(), existingKeys: new Set(), completedCallSeqs: new Set(),
    recordedUnpaired: new Set(), ownedIds: new Set(), conclIds: new Set(),
  };
  // All IDs remain global; only this session's content/pair/count keys are retained.
  scanSessionStore(storeFile, (r) => {
    snapshot.existing.add(r.id);
    if (!sessionMatches(r.session, sid)) return;
    snapshot.existingKeys.add(segmentContentKey(r));
    snapshot.ownedIds.add(r.id);
    if (r.kind === 'conclusion') snapshot.conclIds.add(r.id);
    if (r.kind === 'action' && Number.isInteger(r.ptr?.callSeq)) {
      const gist = String(r.gist ?? '');
      if (gist.includes('↳')) snapshot.completedCallSeqs.add(r.ptr.callSeq);
      if (gist.includes('（无结果）')) snapshot.recordedUnpaired.add(r.ptr.callSeq);
    }
  });
  return snapshot;
}

/** 索引一个会话档案：水位 + id 去重 + meta 记账；full=true 忽略水位重扫（仍按 id 去重）。
 *  lock（默认 true）：先锁 storeFile、再锁 metaFile，串行化整个「读水位 → 追加 → 记账」序列（worker 与 CLI 互斥）。
 *  锁序与 marks 路径一致（store → meta），无反向取锁；appendSegments 本身不再取锁，调用方必须持 storeFile。
 *  timeout 20s：大档案解压 + 58MB store load 约 2.5s，默认 5s 余量偏小（2026-10-19 复审 P2-5）。 */
export function indexSession({ file, session, storeFile = SESSION_DEFAULTS.storeFile, metaFile = SESSION_DEFAULTS.metaFile, full = false, lock = true } = {}) {
  // 会话 id 归一（2026-10-15，P1 审计）：两种形态解析到同一档案 ⇒ 入口统一存裸形态，杜绝孪生重复。
  const sid = normalizeSid(session);
  const { text, frameFails, frameTruncated } = readSessionArchive(file);
  const records = [];
  let parseFails = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { records.push(JSON.parse(s)); } catch { parseFails += 1; }
  }
  // 2026-10-19 人工复检：档案读取/解压/JSON 解析移到锁外；锁内做「store 载入 → 水位/去重/段提取 → 追加 → 记账」。
  const run = () => {
    const seqOf = (rec, i) => (Number.isInteger(rec.seq) ? rec.seq : i + 1);
    const meta = readMeta(metaFile);
    const prev = meta.sessions?.[sid] ?? {};
    const lastSeq = Number.isInteger(prev.lastSeq) ? prev.lastSeq : 0;
    let maxSeq = lastSeq;
    records.forEach((rec, i) => { const seq = seqOf(rec, i); if (seq > maxSeq) maxSeq = seq; });
    // 配对按「全量记录」维护（修复中途索引切批的漏配）；产出只取新：emitFrom=lastSeq（--full 时 0）。
    // 已完成集合（2026-10-12 emit 门修复）：库中已有完成版（gist 含 ↳）的 callSeq —— 修复「水位推进后迟到结果被吞」。
    const { existing, existingKeys, completedCallSeqs, recordedUnpaired, ownedIds, conclIds } = readIndexSnapshot(storeFile, sid);
    const segs = extractSegments(records, { session: sid, emitFrom: full ? 0 : lastSeq, completedCallSeqs, recordedUnpaired });
    // 迁移安全去重（2026-10-15，配合 sid8 方案变更）：段 id 变了以后老段按 id 认不出 ⇒ `--full` 会整批重复追加。
    // 故**同时**按「本会话的 (seq, kind, gist, why, tools) 内容键」比对——与 id 字符串形状解耦：
    //   同内容（无论老 id 新 id）⇒ 跳过（幂等不变）；变内容 ⇒ 仍追加新版（F2 漂移语义不破）。
    //   seq 非整数的手工段回退按 id 比对（绝不把两条不同段误并成一条）。
    const incoming = segs.filter((x) => !existing.has(x.id) && !existingKeys.has(segmentContentKey(x)));
    const skipped = segs.length - incoming.length;
    appendSegments(storeFile, incoming);
    for (const r of incoming) {
      ownedIds.add(r.id);
      if (r.kind === 'conclusion') conclIds.add(r.id);
    }
    const next = {
      ...meta,
      version: 1,
      sessions: {
        ...(meta.sessions ?? {}),
        [sid]: { lastSeq: maxSeq, segments: ownedIds.size, conclusions: conclIds.size, indexedAt: new Date().toISOString(), source: file }
      }
    };
    writeFileAtomic(metaFile, JSON.stringify(next, null, 2));
    return { session: sid, added: incoming.length, skipped, lastSeq: maxSeq, parseFails, frameFails, frameTruncated };
  };
  return lock ? withFileLock(storeFile, () => withFileLock(metaFile, run), { timeoutMs: 20000 }) : run();
}

/** 动作版本归并（**读取视图**；存储仍 append-only）：同一 call（session:ptr.callSeq）默认只回一版——
 *  优先「已完成」（gist 含 ↳），同态取最新 logged_at；all=true 时原样返回（历史可见）。 */
export function collapseActionVersions(records) {
  const done = (v) => (String(v.gist ?? '').includes('↳') ? 1 : 0);
  const actions = new Map();
  const rest = [];
  for (const r of records) {
    if (r.kind !== 'action') { rest.push(r); continue; }
    // 2026-10-15（GPT 复核 session N2）：版本归并键必须**归一**——裸 / `session-` 前缀两形态并存时，
    // 同一次调用的两版会落进两个桶（「优先完成版、只回一版」的读取契约失效）。
    const key = `${normalizeSid(r.session)}|${r.ptr?.callSeq ?? r.ptr?.seq ?? r.seq}`;
    const prev = actions.get(key);
    if (!prev) { actions.set(key, r); continue; }
    const better = done(r) > done(prev) || (done(r) === done(prev) && String(r.logged_at ?? '') >= String(prev.logged_at ?? ''));
    if (better) actions.set(key, r);
  }
  return [...rest, ...actions.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/** 会话层检索：默认 意图/动作/结论/节点（结论 +1.0 优先）；process 仅 includeProcess 或显式 kind；level='nodes'|'segs' 过滤；节点只取当前代。
 *  all=true：动作不做版本归并（用于看历史版本）。 */
/** 会话名前缀解析（2026-10-11）：f362b992 → 完整 id。唯一匹配才展开；多义/无匹配原样返回（不猜）。 */
export function resolveSessionPrefix(records, session) {
  const s = String(session ?? '').trim();
  if (!s) return s;
  const ids = new Set(records.map((r) => String(r.session ?? '')));
  if (ids.has(s)) return s;
  // 归一匹配（2026-10-15，P1 审计）：`abcd…` 与 `session-abcd…` 指向同一档案 ⇒ 先按归一形态找**唯一键**，
  // 让下游 `sessionMatches(r.session, sess)` 这类比较自然命中（读侧兼容老键；入口已统一存裸形态）。
  const ns = normalizeSid(s);
  const normMatches = [...ids].filter((id) => normalizeSid(id) === ns);
  if (normMatches.length === 1) return normMatches[0];
  const matches = [...ids].filter((id) => id.startsWith(s));
  if (matches.length === 1) return matches[0];
  // 2026-10-15（GPT 复核 session N2·短 id 展开遗漏）：历史库只含 `session-<短>` 形态时裸短串前缀匹配不到 ⇒ 归一后再试。
  const normPrefix = [...ids].filter((id) => normalizeSid(id).startsWith(ns));
  return normPrefix.length === 1 ? normPrefix[0] : s;
}

export function lookupSegments(query, opts = {}) {
  return lookupSegmentsDetailed(query, opts).hits;
}

/** (a) 带覆盖度的会话层检索（2026-10-11）：返回 {hits, matched, sessionTotal, offset, nextOffset, exhausted}
 *  —— matched = 主题相关段总数（裁剪前），sessionTotal = 本次作用域内段总数（用户可据此知道自己看了多少）。 */
export function lookupSegmentsDetailed(query, { storeFile = SESSION_DEFAULTS.storeFile, session, kind, since, until, includeProcess = false, rawProcess = false, reflect = false, doseThreshold, longSessionSegs, limit = 10, offset = 0, level, all = false, storeRecords = null, depth, via, queryLog, today } = {}) {
  // 体裁隔离 P0-①（2026-10-13）：`rawProcess` ＝**反思通道**（显式要过程）——含过程段、且**不剥皮**（§4.7 原则 3）。
  // `reflect` 同样走全文（不剥、不截）；过程段是否纳入仍只看 rawProcess / includeProcess。
  // 省略 depth 仍剥皮、仍受剂量闸（与 main 零差）。高保真只认 reflect / rawProcess / 显式 depth:full。
  // 硬顶只在显式 summary|pointer。返回的 depth 缺省是 full。
  const reflectOn = rawProcess || reflect === true;
  const highFidelity = reflectOn || depth === 'full';
  const tierOn = depth === 'pointer' || depth === 'summary';
  const readDepth = readDepthOf({ reflect, rawProcess, depth });
  const incProcess = includeProcess || rawProcess;
  const q = String(query ?? '').trim();
  const empty = { hits: [], matched: 0, sessionTotal: 0, offset: 0, nextOffset: 0, exhausted: true, citeAllowlist: [], depth: readDepth, reflect: reflectOn, withheld: null };
  if (!q) return empty;
  const tokens = tokenize(q);
  if (!tokens.length) return empty;
  // (1) 2026-10-11：**默认面只给 conclusion + intent**——实测发现动作段（646 条）gist 是工具调用参数，
  //     排到结论前会把"我调过什么"误读成"我们想过什么"。要动作/节点/过程须显式指定（kind / level / --actions）。
  const SEG_KINDS = ['intent', 'action', 'conclusion', ...(incProcess ? ['process'] : [])];
  let kinds;
  if (kind != null) kinds = (Array.isArray(kind) ? kind : String(kind).split(',')).map((x) => String(x).trim()).filter(Boolean);
  else if (level === 'nodes') kinds = ['node'];
  else if (level === 'segs') kinds = SEG_KINDS;
  else if (all) kinds = [...SEG_KINDS, 'node'];          // all=true＝看历史全貌，回宽面（与"不做版本归并"同义）
  else kinds = ['conclusion', 'intent', 'node', ...(incProcess ? ['process'] : [])];   // 默认：结论+意图+节点；process 仍须显式（includeProcess / rawProcess）
  const records = loadStore('session', storeFile).records;
  const sess = resolveSessionPrefix(records, session);
  const view = all ? records : collapseActionVersions(records);
  let genBy = null;
  const activeBySession = new Map();
  const committedGenBySession = new Map();
  const fallbackAllBySession = new Set();
  if (kinds.includes('node')) {
    genBy = new Map(); // 各会话各取最新代——跨会话查询不得互相遮挡（终局复核 F1）；键归一（GPT N2：混形旧树不得各算一代）
    const manifestGen = new Map();
    for (const r of records) {
      if (r.kind !== 'node' || (sess && !sessionMatches(r.session, sess))) continue;
      const gk = normalizeSid(r.session);
      genBy.set(gk, Math.max(genBy.get(gk) ?? -1, Number(r.treegen) || 0));
    }
    for (const r of records) {
      if (r.kind !== 'tree-manifest' || (sess && !sessionMatches(r.session, sess))) continue;
      const gk = normalizeSid(r.session);
      const gen = Number(r.treegen) || 0;
      if (gen >= (manifestGen.get(gk) ?? -1)) { manifestGen.set(gk, gen); activeBySession.set(gk, new Set(Array.isArray(r.active_ids) ? r.active_ids : [])); committedGenBySession.set(gk, gen); }
    }
    const nodeGenBySession = new Map();
    for (const r of records) {
      if (r.kind !== 'node' || typeof r.session !== 'string' || typeof r.id !== 'string') continue;
      const gk = normalizeSid(r.session);
      if (!nodeGenBySession.has(gk)) nodeGenBySession.set(gk, new Map());
      const byId = nodeGenBySession.get(gk);
      byId.set(r.id, Math.min(byId.get(r.id) ?? Infinity, Number(r.treegen) || 0));
    }
    for (const [gk, ids] of activeBySession) {
      const committed = committedGenBySession.get(gk);
      const byId = nodeGenBySession.get(gk);
      if ([...ids].some((id) => (byId?.get(id) ?? Infinity) > committed)) { activeBySession.delete(gk); committedGenBySession.delete(gk); fallbackAllBySession.add(gk); }
    }
  }
  const projectedNodes = new Map();
  if (kinds.includes('node')) {
    for (const r of records) {
      if (r.kind !== 'node' || (sess && !sessionMatches(r.session, sess)) || typeof r.id !== 'string') continue;
      const gk = normalizeSid(r.session);
      const committed = committedGenBySession.get(gk);
      if (committed != null && (Number(r.treegen) || 0) > committed) continue;
      const active = activeBySession.get(gk);
      if (active && !active.has(r.id)) continue;
      const key = gk + '::' + r.id;
      const prior = projectedNodes.get(key);
      if (!prior || (Number(r.treegen) || 0) >= (Number(prior.treegen) || 0)) projectedNodes.set(key, r);
    }
  }
  const hits = [];
  for (const r of view) {
    if (sess && !sessionMatches(r.session, sess)) continue;
    if (!kinds.includes(r.kind)) continue;
    if (r.kind === 'node') {
      const gk = normalizeSid(r.session);
      const active = activeBySession.get(gk);
      const committed = committedGenBySession.get(gk);
      if (committed != null && (Number(r.treegen) || 0) > committed) continue;
      const key = gk + '::' + r.id;
      if (active) { if (!active.has(r.id) || projectedNodes.get(key) !== r) continue; }
      else if (fallbackAllBySession.has(gk)) { if (projectedNodes.get(key) !== r) continue; }
      else if ((Number(r.treegen) || 0) !== genBy.get(gk)) continue;
    }
    if (since || until) {
      const day = String((r.kind === 'node' ? r.time_from : r.time) || '').slice(0, 10);
      if (!day) continue;
      if (since && day < String(since).slice(0, 10)) continue;
      if (until && day > String(until).slice(0, 10)) continue;
    }
    const gistL = String(r.gist ?? '').toLowerCase();
    const extraKeywords = (r.keywords ?? []).filter((k) => !gistL.includes(String(k).toLowerCase()));
    const hay = [r.gist, r.extra, r.why, extraKeywords.join(' ')].filter(Boolean).join(' ').toLowerCase();
    // 与主库同一把尺子（scoreTokens）：整词 ×1 + 回退合计封顶 0.9。结论 +1 只进排序权重。
    // 2026-10-18（排名缺陷 canon-session-rank-nodeflood-20261018）：node 的 gist 是长摘要，"整词按出现次数累加"
    //   会让重复词洪水压过精确结论（实测「复核」×20 ⇒ node 20.9 vs 精确结论 8.9，目标被压到第 8）。
    //   ⇒ **node 侧整词分每 token 封顶 1**（node 是摘要：讲"有没有"，不讲"出现几次"）；结论/意图保持原尺。
    const sc = scoreTokens(hay, tokens, r.kind === 'node' ? { capWhole: 1 } : undefined);
    if (sc.score <= 0) continue;
    const score = sc.score;
    const weight = score + (r.kind === 'conclusion' ? 1.0 : 0);
    // 体裁隔离（2026-10-13）：读侧剥皮（P0-②）与剂量闸（P1-③）统一在**排序后**做——
    //   ⚠ 实测教训：先在构造时剥皮 ⇒ 剂量闸拿到的是已剥文本 ⇒ 负荷恒 0（哑闸）。剂量必须按**原文**计。
    const hitTime = r.kind === 'node' ? (r.time_from ?? '') : r.time;
    const hit = { id: r.id, session: r.session, seq: r.seq, time: hitTime, turn: r.turn ?? null, step: r.step ?? null, kind: r.kind, score: +score.toFixed(3), strong: sc.whole >= 1, weight: +weight.toFixed(3), gist: r.gist, agePrefix: agePrefix({ event_time: r.event_time || hitTime }, { today }) };
    if (r.kind === 'node') {
      hit.level = r.level;
      hit.children = r.children ?? [];
      hit.time_to = r.time_to ?? '';
    }
    hits.push(hit);
  }
  let scopeTotal = 0;
  for (const r of view) {
    if (sess && !sessionMatches(r.session, sess)) continue;
    if (!kinds.includes(r.kind)) continue;
    if (r.kind === 'node') {
      const gk = normalizeSid(r.session);
      const active = activeBySession.get(gk);
      const committed = committedGenBySession.get(gk);
      if (committed != null && (Number(r.treegen) || 0) > committed) continue;
      if (active) { if (!active.has(r.id) || projectedNodes.get(gk + '::' + r.id) !== r) continue; }
      else if (fallbackAllBySession.has(gk)) { if (projectedNodes.get(gk + '::' + r.id) !== r) continue; }
      else if ((Number(r.treegen) || 0) !== genBy.get(gk)) continue;
    }
    scopeTotal += 1;
  }
  const matched = hits.length;
  // I-11 P0-①（2026-10-13）：过程段默认不回放——默认面只报「存在 N 段过程记录」+ 调取指引（**给指针、不给原文**）。
  let withheldProcess = 0;
  if (!incProcess) {
    for (const r of view) {
      if (r.kind !== 'process') continue;
      if (sess && !sessionMatches(r.session, sess)) continue;
      if (since || until) { const day = String(r.time || '').slice(0, 10); if (!day || (since && day < String(since).slice(0, 10)) || (until && day > String(until).slice(0, 10))) continue; }
      const gistL = String(r.gist ?? '').toLowerCase();
      const extraKeywords = (r.keywords ?? []).filter((k) => !gistL.includes(String(k).toLowerCase()));
      const hay = [r.gist, r.extra, r.why, extraKeywords.join(' ')].filter(Boolean).join(' ').toLowerCase();
      if (scoreTokens(hay, tokens).score > 0) withheldProcess += 1;
    }
  }
  // 2026-10-15 全量检查（cli-mcp S5）：`limit/offset` 无闸 ⇒ 负数/超大值直接把剂量闸与装载预算绕过
  // （实测 `session_lookup{limit:-3}` 返回 316.9KB）⇒ 在此处收口（CLI/MCP 两端共用本函数）。
  const lim = Math.min(200, Math.max(1, Math.floor(Number(limit)) || 10));
  const off = Math.min(100000, Math.max(0, Math.floor(offset) || 0));
  const rankedAll = hits.sort((a, b) => b.weight - a.weight || a.seq - b.seq);
  const ranked = rankedAll.slice(off, off + lim);
  // 2026-10-18（排名缺陷 canon-session-rank-nodeflood-20261018）：node 命中附「命中子段」指针。
  //   为什么：node 的 gist 只覆盖开头（本案 84 个 seq 的 node，交接在**最后一个子段**，gist 一字未提）
  //   ⇒ 即使 node 被命中，只看 gist 也看不见命中。这里只对**入页的 node 命中**回扫其 children（≤页大小）。
  const nodeHits = ranked.filter((h) => h.kind === 'node' && Array.isArray(h.children) && h.children.length);
  if (nodeHits.length) {
    const byId = new Map();
    for (const r of records) byId.set(r.id, r);
    const snippetAround = (text, toks, radius = 60) => {
      const raw = String(text ?? '');
      const low = raw.toLowerCase();
      let at = -1;
      for (const tk of toks) { const i = low.indexOf(String(tk).toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
      if (at < 0) return raw.slice(0, radius * 2);
      const from = Math.max(0, at - radius + 20);
      const to = Math.min(raw.length, at + radius);
      return (from > 0 ? '…' : '') + raw.slice(from, to) + (to < raw.length ? '…' : '');
    };
    for (const h of nodeHits) {
      let best = null;
      for (const cid of h.children) {
        const rec = byId.get(cid);
        if (!rec || !rec.gist) continue;
        // 2026-10-18 复核 B·补丁A：指针只能指向**当前面会显示**的类型（kinds 即本次查询的面）。
        //   真库实测：默认面下发后 action/scaffold/topic 仍被指针带出（action 的 snippet 是工具参数原文、
        //   scaffold 含 <system-reminder>）⇒ 侧门。process 也由此自动覆盖（默认面不含，includeProcess 时才含）。
        if (!kinds.includes(rec.kind)) continue;
        const gL = String(rec.gist).toLowerCase();
        const extraK = (rec.keywords ?? []).filter((k) => !gL.includes(String(k).toLowerCase()));
        const hay = [rec.gist, rec.extra, rec.why, extraK.join(' ')].filter(Boolean).join(' ').toLowerCase();
        // 复核 A·W3：子段也可能是 node（L2 的 children 是 L1 节点）⇒ 同一把封顶尺，防指针继承词频洪水。
        const s = scoreTokens(hay, tokens, rec.kind === 'node' ? { capWhole: 1 } : undefined).score;
        if (s <= 0) continue;
        // 复核 B·补丁A：只认**整词命中**子段——fb-only 子段会让 snippet 不含查询词（真库实测 18.4%；
        //   `接棒清单` 单查时 96.6%），指针就变成"给了个看不见证据的指针"。
        // 复核 C·补丁①：只有**能作证据的整词 token** 才参与指针/snippet。单字 token 在 matchParts 里恒为 0
        //   （2026-10-14 守卫），却仍被 snippetAround 拿来定位，会把真正的整词挤出窗口（真库实测 15/71）。
        const hitTokens = tokens.filter((t) => matchParts(hay, t).whole >= 1);
        if (!hitTokens.length) continue;
        const gistHit = hitTokens.some((t) => gL.includes(String(t).toLowerCase()));
        // 复核 A·W2 + 复核 C·补丁②：命中可能只在 why/extra/keywords ⇒ snippet 源必须包含 extraK；
        //   否则 keywords-only 命中会给出连一个查询 token 都没有的片段（真库实测 2/71，含"完全无词"）。
        const parts = [rec.gist, rec.extra, rec.why, extraK.join(' ')].filter(Boolean);
        const hitPart = parts.find((p) => hitTokens.some((t) => String(p).toLowerCase().includes(String(t).toLowerCase()))) ?? rec.gist;
        const cand = { id: rec.id, kind: rec.kind, time: rec.time ?? '', score: +s.toFixed(3), gistHit, snippet: snippetAround(hitPart, hitTokens) };
        const KIND_RANK = { conclusion: 4, intent: 3, action: 2, node: 1 };
        const rank = KIND_RANK[cand.kind] ?? 0;
        const bestRank = best ? (KIND_RANK[best.kind] ?? 0) : -1;
        // 分高优先；同分时「gist 命中」优先；再同分按 kind（conclusion > intent > action > node > other）。
        if (!best || cand.score > best.score + 1e-9
          || (Math.abs(cand.score - best.score) < 1e-9 && (cand.gistHit !== best.gistHit ? cand.gistHit : rank > bestRank))) {
          best = cand;
        }
      }
      if (best) { const { gistHit: _gh, ...keep } = best; h.matchChild = keep; }
    }
  }
  // wave2 §1：promotion 标记折叠到段命中上（不参与计分、不改 strong）。
  const bySeg = new Map();
  for (const r of records) {
    if (r.kind !== 'promotion' || typeof r.seg !== 'string' || !r.seg || !r.promoted_to) continue;
    const list = bySeg.get(r.seg) ?? [];
    list.push({ store: r.promoted_to.store, id: r.promoted_to.id });
    bySeg.set(r.seg, list);
  }
  if (bySeg.size) {
    const retiredCache = new Map();
    const isRetired = (store, id) => {
      if (!STORES.includes(store)) return false;
      if (!retiredCache.has(store)) {
        const recs = (storeRecords && storeRecords[store]) || loadStore(store).records;
        retiredCache.set(store, retiredIds(recs));
      }
      return retiredCache.get(store).has(id);
    };
    for (const h of ranked) {
      const list = bySeg.get(h.id);
      if (list && list.length) h.promoted_to = list.map((x) => ({ store: x.store, id: x.id, retired: isRetired(x.store, x.id) }));
    }
  }
  // I-12 P1-③/P1-④（2026-10-13）：**剂量闸**（按**原文**计负荷）+ **任务门控（长会话自动收紧）**；随后做 P0-② 剥皮。
  //   顺序纪律：**先计负荷、后剥皮/摘要**——反过来会把负荷算成 0（哑闸，当日实测教训）。
  let dose = null;
  const longSegs = Number.isInteger(longSessionSegs) ? longSessionSegs : GENRE_DOSE_DEFAULTS.longSessionSegs;
  const scopedSegCount = records.filter((r) => r.kind !== 'promotion' && (!sess || sessionMatches(r.session, sess))).length;
  const autoStrict = !!sess && scopedSegCount >= longSegs;
  const doseTh = Number.isInteger(doseThreshold) ? doseThreshold : (autoStrict ? GENRE_DOSE_DEFAULTS.strictThreshold : GENRE_DOSE_DEFAULTS.threshold);
  const dg = (!highFidelity && doseTh > 0 && ranked.length) ? doseGate(ranked.map((h) => h.gist), { threshold: doseTh }) : null;
  const gistCap = depth === 'pointer' ? READ_TIER.pointerChars : READ_TIER.summaryChars;
  for (let i = 0; i < ranked.length; i += 1) {
    const over = !!dg && dg.cutoff !== null && i >= dg.cutoff;
    // P0-②：`conclusion`/`process`/`node`（模型产出）剥；`intent`（用户原话）/`action`（工具记录）不剥；高保真（rawProcess / reflect / depth:full）全不剥。
    // 省略 depth 仍剥（与 main 一致），但不按摘要档截断。截断只在显式 summary|pointer。
    const base = highFidelity ? ranked[i].gist : (SEG_STRIP_KINDS.has(ranked[i].kind) ? stripGenre(String(ranked[i].gist ?? '')) : ranked[i].gist);
    const gist = over ? doseSummary(base) : (tierOn ? projectText(base, depth, gistCap) : base);
    ranked[i] = over ? { ...ranked[i], gist, dose: true } : { ...ranked[i], gist };
    // 命中子段指针同走体裁隔离（子段多为 conclusion/node ⇒ 按同一白名单剥）；高保真通道不动。
    if (!highFidelity && ranked[i].matchChild && SEG_STRIP_KINDS.has(ranked[i].matchChild.kind)) {
      ranked[i] = { ...ranked[i], matchChild: { ...ranked[i].matchChild, snippet: stripGenre(String(ranked[i].matchChild.snippet ?? '')) } };
    }
  }
  if (dg && dg.cutoff !== null) dose = { threshold: doseTh, total: dg.total, from: dg.cutoff, trimmed: ranked.length - dg.cutoff, strict: autoStrict };
  const nextOffset = off + ranked.length;
  const citeAllowlist = ranked.filter((h) => typeof h.id === 'string' && h.id).map((h) => ({ id: h.id, store: 'session', tier: null, strong: !!h.strong }));
  const __out = {
    hits: ranked, matched, sessionTotal: scopeTotal, offset: off, nextOffset, exhausted: nextOffset >= matched,
    reflect: reflectOn,
    depth: readDepth,
    dose,
    citeAllowlist,
    withheld: withheldProcess ? { process: withheldProcess, hint: `存在 ${withheldProcess} 段过程记录（默认不回放）；--raw-process 可调取原文（反思通道，不剥皮）` } : null
  };
  recordQuery({ cmd: 'session', query: q, hits: ranked.length, ids: citeAllowlist.map((x) => x.id), genreRender: genreRenderOf({ reflect: reflect === true, rawProcess: rawProcess === true, depth }), via }, { queryLog, via });
  return __out;
}

/** 薄封装：解析会话名前缀（供 renderSessionContext / sessionClusters 用）。 */
function resolvedSess(records, session) { return resolveSessionPrefix(records, session); }

/** (b) 主题簇（2026-10-11 二改，按用户口径「根据每个会话的主题与主要对话修缮」）：
 *  ① 语料＝**本会话**段落；**intent（用户说的话）权重 ×2** —— "主要对话"是主题的来源；
 *  ② 候选＝中文 **3–6 字连续短语**（最长优先、丢弃被更长高频短语包含的）+ 英文专名（≥4 字符）；
 *  ③ 黑名单＝工具名 / 文件类型 / 流程词（edit、grep、read、write、pwsh、apply_patch、selftest、gate、promote、
 *     staging、README、json、md、检查、验证、修复、落位、全绿…）——这些是"我们干了什么"，不是"在谈什么"；
 *  ④ 归簇＝**最长匹配**（互斥）；未匹配段落计入 arr.unassigned（如实报告覆盖）。 */
export function sessionClusters({ storeFile = SESSION_DEFAULTS.storeFile, session, topN = 12, minCount = 3, limit = 3, source = 'both', recent = false, windowDays = 30, maxSegments = 20000, nowMs = Date.now() } = {}) {
  const allRecords = loadStore('session', storeFile).records;
  const sess = resolvedSess(allRecords, session);
  const kinds = source === 'intent' ? ['intent'] : (source === 'conclusion' ? ['conclusion'] : ['intent', 'conclusion']);
  // 脚手架过滤（2026-10-11 实测；2026-10-11 深夜**常量已提到模块级** SCAFFOLD_RE，索引侧同用 ⇒ 一处定义两处用）：
  // intent 段里混着系统提示/注入块（<system-reminder>、<hindsight_knowledge>、【起床包】、runtime context…）
  // ——那是脚手架不是对话，会把簇带成 prompt/memory/search。
  const SCAFFOLD = SCAFFOLD_RE;
  let allScoped = allRecords.filter((r) => kinds.includes(r.kind) && (!sess || sessionMatches(r.session, sess)));
  // 显式窗口模式（非默认）：调用方必须选择 recent:true，不能把全量语义悄悄换成最近 N 段。
  let bounded = null;
  if (!sess && recent === true) {
    const asOf = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    const days = Math.max(1, Number(windowDays) || 30);
    const cutoff = asOf - days * 86400000;
    const cap = Math.max(1, Number(maxSegments) || 20000);
    let unknownTime = 0;
    const recentRows = allScoped.filter((r) => {
      const raw = String(r.time || '');
      const t = raw ? Date.parse(raw) : NaN;
      if (!Number.isFinite(t)) { unknownTime += 1; return false; }
      return t >= cutoff && t <= asOf;
    });
    const truncated = recentRows.length > cap;
    allScoped = truncated ? recentRows.slice(-cap) : recentRows;
    bounded = {
      bounded: true,
      effectiveScope: 'recent',
      timeField: 'time',
      asOf: new Date(asOf).toISOString(),
      windowDays: days,
      maxSegments: cap,
      scanned: allRecords.length,
      considered: recentRows.length,
      unknownTime,
      selected: allScoped.length,
      truncated,
      cutoff: new Date(cutoff).toISOString(),
      selectionOrder: 'append-order-tail',
    };
  }
  const recs = allScoped.filter((r) => !SCAFFOLD.test(String(r.gist || '')));
  const skippedScaffold = allScoped.length - recs.length;
  const BLACK = new Set(['edit', 'grep', 'read', 'write', 'pwsh', 'bash', 'apply_patch', 'apply', 'patch', 'node', 'json', 'jsonl', 'md', 'zstd', 'html', 'yaml',
    'readme', 'selftest', 'gate', 'hooks', 'sleep', 'mcp', 'cli', 'api', 'http', 'https', 'github', 'npm', 'pnpm', 'stage', 'staging',
    '检查', '验证', '修复', '落位', '全绿', '通过', '完成', '确认', '结果', '文档', '测试', '一次', '两次', '这一', '那个', '这个', '什么', '时候', '现在', '然后', '所以', '已经', '需要',
    '问题', '部分', '内容', '方式', '情况', '新增', '落地', '继续', '第一', '第二', '第三', '第四', '第六条', '残留', '第二批', '第二轮', '第二轮']);

  // ①' 会话主题种子（2026-10-11 用户口径「根据每个会话的主题」）：取**该会话时间窗内写入的六库条目的 tags**——
  //     "这个会话谈出了什么"比词频更能定义主题；窗口＝本会话段落时间的 [min, max]（±1 天余量）。
  let seedHits = 0;
  const sessionSeeds = new Set();
  try {
    let minT = Infinity, maxT = -Infinity;
    for (const r of recs) {
      const t = Date.parse(String(r.time || '')) || null;
      if (t) { if (t < minT) minT = t; if (t > maxT) maxT = t; }
    }
    if (Number.isFinite(minT)) {
      const lo = minT - 86400000, hi = maxT + 86400000;
      for (const store of ['canon', 'frontier', 'mirror', 'orphan', 'pricing', 'lexicon']) {
        try {
          for (const r of loadStore(store).records) {
            const t = Date.parse(String(r.logged_at || r.event_time || '')) || null;
            if (!t || t < lo || t > hi) continue;
            for (const tag of (r.tags ?? [])) {
              const s2 = String(tag).trim();
              if (s2.length >= 2 && s2.length <= 12 && !BLACK.has(s2)) { sessionSeeds.add(s2); seedHits += 1; }
            }
          }
        } catch { /* 单库失败不影响 */ }
      }
    }
  } catch { /* 种子不可用时退化为纯短语提取 */ }

  // 中文连续串切分（标点/ASCII 为界）
  const runsOf = (t) => String(t).match(/[\u4e00-\u9fff]+/g) || [];
  const asciiOf = (t) => String(t).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [];

  // ① 候选短语计数（intent 权重 2）
  const cnt = new Map();
  for (const r of recs) {
    const w = r.kind === 'intent' ? 2 : 1;
    const seen = new Set();
    for (const run of runsOf(r.gist)) {
      for (let L = 6; L >= 3; L--) {
        for (let k = 0; k + L <= run.length; k++) {
          const p = run.slice(k, k + L);
          if (!BLACK.has(p)) seen.add(p);
        }
      }
    }
    for (const w2 of asciiOf(r.gist)) if (!BLACK.has(w2)) seen.add(w2);
    for (const p of seen) cnt.set(p, (cnt.get(p) || 0) + w);
  }

  // ② 最长优先 + 去被包含者：长度 6→3，若短串被已选长串包含则丢弃
  const kept = [];
  const covered = new Set();
  for (const L of [6, 5, 4, 3]) {
    const cands = [...cnt.entries()].filter(([p, c]) => p.length === L && c >= minCount).filter(([p]) => !/^[a-z0-9._-]+$/.test(p) || L >= 4)
      .sort((a, b) => b[1] - a[1]);
    for (const [p, c] of cands) {
      if (covered.has(p)) continue;
      kept.push(p);
      for (let L2 = 3; L2 <= p.length; L2++) {
        for (let i = 0; i + L2 <= p.length; i++) covered.add(p.slice(i, i + L2));
      }
    }
  }
  // 会话种子优先并入候选（保证"这个会话的主题"一定在场）
  const merged = new Set([...sessionSeeds, ...kept]);
  const terms = [...merged].sort((a, b) => (cnt.get(b) || 0) - (cnt.get(a) || 0)).slice(0, Math.max(topN * 3, 30));
  const termList = terms.sort((a, b) => b.length - a.length);   // 归簇用最长匹配

  // ③ 归簇
  const groups = new Map();
  let unassigned = 0;
  for (const r of recs) {
    const gist = String(r.gist ?? '');
    const hit = termList.find((t) => gist.includes(t));
    if (!hit) { unassigned += 1; continue; }
    const g = groups.get(hit) ?? { term: hit, count: 0, samples: [], chars: 0 };
    g.count += 1;
    g.chars += gist.length;
    if (g.samples.length < limit) g.samples.push({ id: r.id, turn: r.turn ?? null, kind: r.kind, gist: gist.slice(0, 80) });
    groups.set(hit, g);
  }
  const out = [...groups.values()].filter((g) => g.count >= minCount).sort((a, b) => b.count - a.count).slice(0, topN);
  out.unassigned = unassigned;
  out.termTotal = termList.length;
  out.matchedTotal = recs.length - unassigned;
  out.corpus = recs.length;
  out.skippedScaffold = skippedScaffold;
  out.sessionSeeds = sessionSeeds.size;
  out.window = bounded;
  return out;
}

/** (b') 会话主题表（2026-10-11 定案，替代词频簇）：**主题＝该会话时间窗内写进六库的条目**——
 *  "这个会话谈了什么"最可靠的证据，是它为此**存下了什么**（而不是对话里哪个词频次高；词频簇四轮迭代未达标，降为实验件）。
 *  返回：{ themes: [{store,id,tags,headline,loggedAt}], suggested: [{term,count}], window:{lo,hi}, counts:{...} } */
export function sessionThemes({ storeFile = SESSION_DEFAULTS.storeFile, session, limit = 60, seedTopN = 12 } = {}) {
  const allRecords = loadStore('session', storeFile).records;
  const sess = resolvedSess(allRecords, session);
  const segs = allRecords.filter((r) => (!sess || sessionMatches(r.session, sess)));
  let lo = Infinity, hi = -Infinity;
  for (const r of segs) {
    const t = Date.parse(String(r.time || '')) || null;
    if (t) { if (t < lo) lo = t; if (t > hi) hi = t; }
  }
  if (!Number.isFinite(lo)) return { themes: [], suggested: [], window: null, counts: {} };
  lo -= 3600000; hi += 3600000;   // ±1h 余量（条目写入常紧随会话）
  const themes = [];
  const tagCount = new Map();
  for (const store of ['canon', 'frontier', 'mirror', 'orphan', 'pricing', 'lexicon']) {
    try {
      for (const r of loadStore(store).records) {
        const t = Date.parse(String(r.logged_at || r.event_time || '')) || null;
        if (!t || t < lo || t > hi) continue;
        const tags = (r.tags ?? []).map((x) => String(x).trim()).filter(Boolean);
        for (const tag of tags) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
        themes.push({ store, id: r.id, tags, loggedAt: String(r.logged_at || '').slice(0, 10), headline: String(r.claim ?? '').slice(0, 70) });
      }
    } catch { /* 单库失败不影响 */ }
  }
  themes.sort((a, b) => String(a.loggedAt).localeCompare(String(b.loggedAt)));
  const suggested = [...tagCount.entries()].filter(([t]) => t.length >= 2 && t.length <= 12)
    .sort((a, b) => b[1] - a[1]).slice(0, seedTopN).map(([term, count]) => ({ term, count }));
  const counts = {};
  for (const x of themes) counts[x.store] = (counts[x.store] || 0) + 1;
  return { themes: themes.slice(0, limit), suggested, window: { lo: todayLocal(new Date(lo)), hi: todayLocal(new Date(hi)) }, counts, total: themes.length };
}

/** (b'') 话题簇：**跨会话持久 + 增量修缮**（2026-10-11 用户口径）。
 *  - 已有话题**沿用原簇累加**（count/sessions/entries/时间轴），**只有新话题才新建**——不"从头长"；
 *  - **双时态**：event 轴（firstEvent/lastEvent，所描述之事何时发生）与 logged 轴（firstLogged/lastLogged，何时被记下）；
 *  - **会话归属**：sessions{sid:count} ⇒ 可做"同话题跨会话"或"只看某会话"的判断；
 *  - 持久化：向会话层追加 kind='topic' 记录（每代一行，含全部簇），取**最新代**读；fingerprint 相同则不重复追加（幂等）。 */
export function buildTopics({ storeFile = SESSION_DEFAULTS.storeFile } = {}) {
  const records = loadStore('session', storeFile).records;
  const segKinds = new Set(['intent', 'conclusion', 'process', 'action']);
  const win = new Map();
  for (const r of records) {
    if (!segKinds.has(r.kind)) continue;
    const t = Date.parse(String(r.time || '')) || null;
    if (!t) continue;
    const sid0 = normalizeSid(r.session);   // GPT N2：话题归属按归一键聚合（混形会话不得分家）
    const w = win.get(sid0) ?? { lo: Infinity, hi: -Infinity };
    if (t < w.lo) w.lo = t;
    if (t > w.hi) w.hi = t;
    win.set(sid0, w);
  }
  const clusters = new Map();
  for (const [sid, w] of win) {
    const lo = w.lo - 3600000, hi = w.hi + 3600000;
    for (const store of ['canon', 'frontier', 'mirror', 'orphan', 'pricing', 'lexicon']) {
      try {
        for (const r of loadStore(store).records) {
          const t = Date.parse(String(r.logged_at || r.event_time || '')) || null;
          if (!t || t < lo || t > hi) continue;
          for (const raw of (r.tags ?? [])) {
            const term = String(raw).trim().toLowerCase();
            if (!term || term.length < 2 || term.length > 12) continue;
            const c = clusters.get(term) ?? { term, count: 0, sessions: {}, entries: [], firstEvent: null, lastEvent: null, firstLogged: null, lastLogged: null };
            c.count += 1;
            c.sessions[sid] = (c.sessions[sid] || 0) + 1;
            if (c.entries.length < 40) c.entries.push(store + ':' + r.id);
            const ev = r.event_time ? String(r.event_time).slice(0, 10) : null;
            const lg = String(r.logged_at || '').slice(0, 10) || null;
            if (ev) { if (!c.firstEvent || ev < c.firstEvent) c.firstEvent = ev; if (!c.lastEvent || ev > c.lastEvent) c.lastEvent = ev; }
            if (lg) { if (!c.firstLogged || lg < c.firstLogged) c.firstLogged = lg; if (!c.lastLogged || lg > c.lastLogged) c.lastLogged = lg; }
            clusters.set(term, c);
          }
        }
      } catch { /* 单库失败不影响 */ }
    }
  }
  const list = [...clusters.values()].sort((a, b) => b.count - a.count);
  const fingerprint = list.map((c) => c.term + ':' + c.count + ':' + Object.keys(c.sessions).length).join('|');
  return { list, fingerprint, sessions: win.size };
}

/** 话题检索（按话题 × 会话 × 双时态）：读最新代；无 --build 时若代缺失可先构建。 */
export function lookupTopics({ storeFile = SESSION_DEFAULTS.storeFile, term, session, since, until } = {}) {
  const records = loadStore('session', storeFile).records.filter((r) => r.kind === 'topic');
  const gen = records.reduce((n, r) => Math.max(n, Number(r.treegen) || 0), 0);
  const latest = records.filter((r) => (Number(r.treegen) || 0) === gen).pop();
  const list = latest ? (latest.clusters ?? []) : [];
  return list.filter((c) => {
    if (term && !String(c.term).includes(String(term).toLowerCase())) return false;
    // GPT N2：两种合法写法（裸 / 前缀）都必须命中同一归属；归一后按前缀匹配（短 id 场景保留）。
    if (session && !Object.keys(c.sessions || {}).some((s) => normalizeSid(s).startsWith(normalizeSid(session)))) return false;
    if (since && c.lastEvent && c.lastEvent < String(since).slice(0, 10)) return false;   // 双时态：事件轴为主，logged 轴兜底
    if (until && c.firstEvent && c.firstEvent > String(until).slice(0, 10)) return false;
    return true;
  });
}

export function renderSessionContext({ storeFile = SESSION_DEFAULTS.storeFile, session, budget = 600 } = {}) {
  const allRecords = loadStore('session', storeFile).records;
  const sess = resolvedSess(allRecords, session);
  const records = allRecords.filter((r) => r.kind !== 'promotion' && (!sess || sessionMatches(r.session, sess)));
  const counts = { conclusion: 0, action: 0, intent: 0, process: 0 };
  for (const r of records) if (counts[r.kind] !== undefined) counts[r.kind] += 1;
  const sid8 = String(session ?? '').slice(0, 8) || 'all';
  const head = `小阿卡夏·会话层（${sid8}）：共 ${records.length} 段（结论 ${counts.conclusion} · 动作 ${counts.action} · 意图 ${counts.intent} · 过程 ${counts.process}）`;
  // (c) 2026-10-11：真按 budget 装料——把最近结论按"最近优先"塞进剩余预算，而不是固定只取 2 条。
  const tail = '；查详情：node akasha.mjs session lookup <词>';
  const conclusions = records.filter((r) => r.kind === 'conclusion');
  const used = () => head.length + pack.length + tail.length + 24;   // 24＝装载行留白
  let pack = '';
  const packParts = [];
  for (let i = conclusions.length - 1; i >= 0; i--) {
    // I-11 P0-②（2026-10-13）：上下文装载面同属读侧渲染 ⇒ 结论段剥皮（⇒→→ / ✓ 删 / 好。→。）；剥后再按预算切。
    const piece = '；' + stripGenre(String(conclusions[i].gist)).slice(0, 140);
    if (used() + piece.length > budget) break;
    packParts.unshift(stripGenre(String(conclusions[i].gist)).slice(0, 140));
    pack = packParts.length ? '；最近结论：' + packParts.join('；') : '';
    if (used() >= budget) break;
  }
  const loadLine = '｜装载 ' + packParts.length + '/' + conclusions.length + ' 条结论 · ' + (head.length + pack.length + tail.length) + '/' + budget + ' 字符';
  let text = head + pack + loadLine + tail;
  if (text.length > budget) {
    const room = Math.max(0, budget - tail.length - loadLine.length - 1);
    text = (head + pack).slice(0, room) + '…' + loadLine + tail;
  }
  return text;
}

const PROMOTE_KINDS = new Set(['conclusion', 'action']);

/** 段升格（wave2 §1）。默认 dry；--apply 才写。先六库 appendRecord，再追加 promotion 标记。不读 tools、不打开原档。 */
export function promoteSegment(segId, opts = {}) {
  const store = opts.to;
  if (!STORES.includes(store)) {
    return { ok: false, code: 'usage', error: '必须指定 --to <canon|mirror|orphan|pricing|lexicon|frontier>（拿不准就 --to orphan）' };
  }
  const sessionFile = opts.sessionFile || SESSION_DEFAULTS.storeFile;
  const targetFile = opts.targetFile || storePath(store);
  const segs = loadStore('session', sessionFile).records;
  const seg = segs.find((r) => r && r.id === segId && r.kind !== 'promotion');
  if (!seg) return { ok: false, code: 'not-found', error: '找不到段：' + segId };
  if (!PROMOTE_KINDS.has(seg.kind)) return { ok: false, code: 'kind', error: `段类型 ${seg.kind} 不能升格（只允许 conclusion / action）` };

  if (opts.repair) {
    const hits = loadStore(store, targetFile).records.filter((r) => r && r.promoted_from && r.promoted_from.id === seg.id && !r.retires);
    if (!hits.length) return { ok: false, code: 'not-found', error: '六库里没有这条升格记录，不能补标记' };
    const have = new Set(segs.filter((r) => r.kind === 'promotion').map((r) => r.id));
    const missing = hits.filter((r) => !have.has(`promo-${seg.id}-${store}-${r.id}`));
    if (!missing.length) return { ok: false, code: 'present', error: '标记已在，无需补' };
    const marks = missing.map((r) => ({
      id: `promo-${seg.id}-${store}-${r.id}`, store: 'session', kind: 'promotion', seg: seg.id,
      promoted_to: { store, id: r.id }, at: new Date().toISOString()
    }));
    if (!opts.apply) return { ok: true, dry: true, repair: true, marks };
    withFileLock(sessionFile, () => appendSegments(sessionFile, marks));
    return { ok: true, dry: false, repair: true, marks };
  }

  const data = opts.data && typeof opts.data === 'object' && !Array.isArray(opts.data) ? { ...opts.data } : {};
  if (data.promoted_from !== undefined) return { ok: false, code: 'usage', error: 'promoted_from 由升格写入，不能经 --data 传入' };
  if (typeof data.id !== 'string' || !data.id.trim()) return { ok: false, code: 'usage', error: '--data 必须含 id' };
  const at = new Date().toISOString();
  const from = { store: 'session', id: seg.id, session: String(seg.session ?? ''), seq: Number.isInteger(seg.seq) ? seg.seq : 0, at };
  const sourceType = data.source && data.source.type;
  if (opts.confirmReplay) {
    if (!(store === 'canon' && sourceType === '复现')) return { ok: false, code: 'replay', error: '--confirm-replay 只用于 canon 且 source.type=复现' };
    from.replay = 'manual';
    from.replay_at = at;
  } else if (store === 'canon' && sourceType === '复现') {
    return { ok: false, code: 'replay', error: '段里没有成败，不能代核。source.type=复现 必须显式 --confirm-replay（人工核对原档）' };
  }
  const record = { ...data, promoted_from: from };
  const errs = validateRecord(store, record);
  if (errs.length) return { ok: false, code: 'validate', error: errs.join('；') };
  const mark = { id: `promo-${seg.id}-${store}-${record.id}`, store: 'session', kind: 'promotion', seg: seg.id, promoted_to: { store, id: record.id }, at };
  if (segs.some((r) => r.id === mark.id)) return { ok: false, code: 'duplicate', error: '同一段已升格到该记录' };
  if (loadStore(store, targetFile).records.some((r) => r.id === record.id)) return { ok: false, code: 'duplicate', error: '目标库已有 id：' + record.id };
  if (!opts.apply) return { ok: true, dry: true, record, mark };
  appendRecord(store, record, { file: targetFile });
  withFileLock(sessionFile, () => appendSegments(sessionFile, [mark]));
  return { ok: true, dry: false, record, mark };
}

// ---------- 抽象层 v0.2：弧线节点（机械树；设计稿 §4.4） ----------

const NODE_GIST_CAP = 400;

function pickNodeText(items, cap) {
  const W = { conclusion: 3, node: 2, action: 2, intent: 1, process: 1 };
  const sorted = [...items].sort((a, b) => (W[b.kind] ?? 1) - (W[a.kind] ?? 1) || (a.seq ?? 0) - (b.seq ?? 0));
  const parts = [];
  let len = 0;
  for (const s of sorted) {
    const text = String(s.gist ?? '');
    if (!text) continue;
    if (len + text.length + 1 > cap) {
      const room = cap - len - 1;
      if (room > 8) parts.push(text.slice(0, room));
      break;
    }
    parts.push(text);
    len += text.length + 1;
  }
  return parts.join(' ');
}
const NODE_EXTRA_CAP = 1200;

// Tree reads retain only the target session and node-generation summaries. The initial
// fd size bounds this snapshot; memory still scales with the longest line/target session.
function readTreeSnapshot(storeFile, sid) {
  const snapshot = { segs: [], latestSeq: 0, prevGen: 0, latestGen: 0, nodeCount: 0, builtAt: 0, fingerprint: null };
  const seen = new Set();
  const allNodes = [];
  const manifests = new Map();
  const accept = (r) => {
    if (r.kind === 'tree-manifest' && sessionMatches(r.session, sid)) {
      const gen = Number(r.treegen) || 0;
      if (gen >= (manifests.get('gen') ?? -1)) { manifests.set('gen', gen); manifests.set('ids', new Set(Array.isArray(r.active_ids) ? r.active_ids : [])); }
      return;
    }
    if (r.kind === 'node') {
      const gen = Number(r.treegen) || 0;
      snapshot.prevGen = Math.max(snapshot.prevGen, gen);
      if (sessionMatches(r.session, sid) && typeof r.id === 'string') allNodes.push(r);
      return;
    }
    if (!sessionMatches(r.session, sid) || seen.has(r.id)) return;
    seen.add(r.id);
    snapshot.segs.push(r);
    snapshot.latestSeq = Math.max(snapshot.latestSeq, Number(r.seq) || 0);
  };
  scanSessionStore(storeFile, accept);
  let active = manifests.get('ids') ?? null;
  let committedGen = manifests.get('gen') ?? null;
  const build = () => {
    const map = new Map();
    for (const r of allNodes) {
      if (committedGen != null && (Number(r.treegen) || 0) > committedGen) continue;
      map.set(r.id, r);
    }
    return map;
  };
  let byId = build();
  if (active && ![...active].every((id) => byId.has(id))) { active = null; committedGen = null; byId = build(); }
  const nodes = [...byId.values()].filter((r) => !active || active.has(r.id));
  snapshot.nodeCount = nodes.length;
  if (nodes.length) {
    snapshot.latestGen = Math.max(...nodes.map((r) => Number(r.treegen) || 0));
    snapshot.builtAt = Math.max(...nodes.map((r) => Date.parse(String(r.logged_at ?? '')) || 0));
    const newest = nodes.reduce((best, node) => (Date.parse(String(node.logged_at ?? '')) || 0) > (Date.parse(String(best.logged_at ?? '')) || 0) ? node : best, nodes[0]);
    snapshot.fingerprint = newest.treeFingerprint ?? null;
  }
  return snapshot;
}

// Shared bounded scan: tree and index callers retain only their required keys/rows.
function scanSessionStore(storeFile, accept) {
  const parseLine = (bytes) => {
    const line = bytes.toString('utf8').trim();
    if (!line) return;
    let record;
    try { record = JSON.parse(line); } catch { return; } // Existing invalid-JSON tolerance only.
    accept(record); // Keep record/IO failures observable, outside the parse catch.
  };
  let fd;
  try { fd = openSync(storeFile, 'r'); } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  try {
    const limit = fstatSync(fd).size;
    const block = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let pending = [];
    let pendingBytes = 0;
    while (position < limit) {
      const n = readSync(fd, block, 0, Math.min(block.length, limit - position), position);
      if (!n) throw Object.assign(new Error('Session store snapshot ended before its initial size'), { code: 'EIO' });
      position += n;
      let from = 0;
      for (let i = 0; i < n; i += 1) {
        if (block[i] !== 10) continue;
        const tail = block.subarray(from, i);
        parseLine(pendingBytes ? Buffer.concat([...pending, tail], pendingBytes + tail.length) : tail);
        pending = [];
        pendingBytes = 0;
        from = i + 1;
      }
      if (from < n) {
        const tail = Buffer.from(block.subarray(from, n)); // Scratch bytes must survive the next read.
        pending.push(tail);
        pendingBytes += tail.length;
      }
    }
    if (pendingBytes) parseLine(Buffer.concat(pending, pendingBytes));
  } finally { closeSync(fd); }
}

/** 机械切块 + 递归聚合（纯函数式：只读 store；写盘用 appendNodes）。切块＝按 turn 边界每 chunkTurns 个 turn 一块。 */
export function buildTree({ session, storeFile = SESSION_DEFAULTS.storeFile, chunkTurns = 8, segCap = 40, fanout = 4 } = {}) {
  const sid = normalizeSid(session);
  const snapshot = readTreeSnapshot(storeFile, sid);
  return { ...buildTreeFromSnapshot({ session: sid, snapshot, chunkTurns, segCap, fanout }), segCount: snapshot.segs.length };
}

function buildTreeFromSnapshot({ session, snapshot, chunkTurns = 8, segCap = 40, fanout = 4 }) {
  const sid = normalizeSid(session);   // 归一（2026-10-15，P1 审计）：两种形态同档，入口统一裸形态
  // 节点 id 的撞号修复（2026-10-15；二轮审计 D1 修正）：`sid.slice(0,8)` 在 `session-` 前缀上恒等 ⇒ 同前缀会话若
  // turn/seq 区间与内容指纹也相同，会算出同一个节点 id。修法＝末尾追加**会话指纹**（**全 8 hex**：4 hex 是 djb2 高 16 位，
  // 对「仅末尾 1 字符不同」的 id 恒定不敏感，实测 4/4 ⇒ 等于没修）；同时保住 `node-<sid8>-L…` 既有前缀形状。
  const sid8 = sid.slice(0, 8);
  const sidFp = fp8(sid);
  const segs = [...snapshot.segs];
  segs.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  const chunks = [];
  let cur = [];
  let turnsIn = new Set();
  for (const s of segs) {
    const t = Number.isInteger(s.turn) ? s.turn : null;
    // 两种切法：① 跨 chunkTurns 轮换块（原有）；② **单块段数上限 segCap**（2026-10-12 调参补）——
    //   超长 turn（实测有 1000+ 段/轮）会把 ① 憋成巨型块，② 兜底保证节点粒度。
    const turnBreak = cur.length && t !== null && !turnsIn.has(t) && turnsIn.size >= chunkTurns;
    const capBreak = segCap > 0 && cur.length >= segCap;
    if (turnBreak || capBreak) {
      chunks.push(cur);
      cur = [];
      turnsIn = new Set();
    }
    cur.push(s);
    if (t !== null) turnsIn.add(t);
  }
  if (cur.length) chunks.push(cur);

  const mkNode = (level, items, children) => {
    const times = items.map((x) => String(x.time ?? '')).filter(Boolean).sort();
    const kw = [];
    outer: for (const s of items) {
      for (const k of s.keywords ?? []) {
        if (!kw.includes(k)) kw.push(k);
        if (kw.length >= 12) break outer;
      }
    }
    const seq0 = Math.min(...items.map((x) => x.seq ?? 0));
    const seq1 = Math.max(...items.map((x) => x.seq ?? 0));
    const gist = pickNodeText(items, NODE_GIST_CAP);
    const extra = pickNodeText(items, NODE_EXTRA_CAP);
    const fp = fp8(JSON.stringify([`L${level}`, children, gist]));   // 同上：节点指纹也改转义口径
    return {
      id: `node-${sid8}-L${level}-${seq0}-${seq1}-${fp}-${sidFp}`,
      store: 'session',
      session: sid,
      kind: 'node',
      level,
      children: [...children],
      time_from: times[0] ?? '',
      time_to: times[times.length - 1] ?? '',
      gist,
      extra,
      keywords: kw.slice(0, 12),
      seq: seq0
    };
  };

  const nodes = chunks.map((ch) => mkNode(1, ch, ch.map((s) => s.id)));
  let level = 1;
  let layer = nodes;
  while (layer.length > 2 && level < 3) {
    level += 1;
    const parents = [];
    for (let i = 0; i < layer.length; i += fanout) {
      const group = layer.slice(i, i + fanout);
      const items = group.map((n) => ({ kind: 'node', gist: n.gist, keywords: n.keywords, seq: n.seq, time: n.time_from }));
      parents.push(mkNode(level, items, group.map((n) => n.id)));
    }
    nodes.push(...parents);
    layer = parents;
  }
  // 代际在整个 session.jsonl 上单调（不按会话各算）。同一毫秒里后建的树必须大于先建的，否则跨会话检索测例会判平。
  const prevGen = snapshot.prevGen;
  const now = Date.now();
  return { treegen: now > prevGen ? now : prevGen + 1, nodes };
}

/** 弧线树 v0.3 · 自动建树（2026-10-12；用户令「弧线树搞下吧」）。
 *  三条纪律（ARTEX 移植要点，机械实现、无 LLM）：
 *   ① **签名未变即复用**——指纹 =（段数, 最大 seq）；新代节点自身带 `treeFingerprint`（不新增元数据档）；一致 ⇒ 直接返回不重跑。
 *   ② **复活段不折叠**——新段（seq > 上代最大 seq）永归新一代「热」层：上代节点原地留档（append-only），新代覆盖含新段的区间。
 *   ③ **无损可展开**——节点带 `children` + `ptr`，全保真仍走 ptr 回原档（既有语义不变）。
 *  节流：`minIntervalMs`（默认 10 分钟）内不重复建（lastBuildAt 由上代节点的 latestSeq 推得）。 */
export function autoBuildTree({ session, storeFile = SESSION_DEFAULTS.storeFile, minIntervalMs = 600000, force = false, chunkTurns = 8, fanout = 4 } = {}) {
  const sid = normalizeSid(session);
  // Preserve the absent-store no-op without creating a parent directory/lock. Re-read
  // inside the lock below: this presence check is not the tree snapshot.
  try { statSync(storeFile); } catch (e) {
    if (e.code === 'ENOENT') return { built: false, reason: 'no-segments', treegen: 0, segCount: 0, latestSeq: 0, nodes: 0 };
    throw e;
  }
  // A cooperating writer cannot advance the generation between this snapshot and
  // append. The existing lock now includes the sequential scan (default timeout).
  return withFileLock(storeFile, () => {
    const snapshot = readTreeSnapshot(storeFile, sid);
    const { latestSeq, latestGen, nodeCount, builtAt, fingerprint: curFp } = snapshot;
    const segCount = snapshot.segs.length;
    const fp = { segCount, latestSeq };
    if (!force) {
      if (nodeCount && curFp && curFp.segCount === segCount && curFp.latestSeq === latestSeq) {
        return { built: false, reason: 'fingerprint-unchanged', treegen: latestGen, segCount, latestSeq, nodes: nodeCount };
      }
      if (nodeCount && minIntervalMs > 0 && builtAt && Date.now() - builtAt < minIntervalMs) {
        return { built: false, reason: 'throttled', treegen: latestGen, segCount, latestSeq, nodes: nodeCount, nextEligibleInMs: minIntervalMs - (Date.now() - builtAt) };
      }
    }
    if (!segCount) return { built: false, reason: 'no-segments', treegen: latestGen, segCount: 0, latestSeq: 0, nodes: 0 };
    const { treegen, nodes } = buildTreeFromSnapshot({ session: sid, snapshot, chunkTurns, fanout });
    const stamped = nodes.map((n) => ({ ...n, treeFingerprint: fp }));
    const commit = commitTreeGeneration(storeFile, sid, treegen, stamped, snapshot.segs.length);
    if (!commit.built) return { built: false, reason: 'content-unchanged', treegen: latestGen, segCount, latestSeq, nodes: commit.nodes, reused: true };
    return { ...commit, segCount, latestSeq };
  });
}

function stableDigest(rec) {
  const copy = { ...rec }; delete copy.logged_at; delete copy.treegen; delete copy.treeFingerprint;
  return createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

function existingRecordDigests(storeFile, kind = null) {
  const out = new Map();
  try {
    for (const r of parseJsonlStream(storeFile).records) {
      if ((!kind || r?.kind === kind) && typeof r.id === 'string') out.set(r.id, { digest: stableDigest(r), treegen: Number(r.treegen) || 0 });
    }
  } catch { /* no store, no dedupe */ }
  return out;
}

/** 节点批量追加（append-only；整批带 treegen 代际标记）。2026-10-18 起同 appendSegments 走脱敏（派生索引）。 */
export function appendNodes(storeFile, nodes, treegen) {
  mkdirSync(dirname(storeFile), { recursive: true });
  quarantineTail(storeFile);   // 同上：树节点批量追加前先清坏尾
  const existing = existingRecordDigests(storeFile, 'node');
  let added = 0;
  let skipped = 0;
  let redacted = 0;
  for (const n of nodes) {
    const rec = { ...n, treegen };
    if (rec.logged_at === undefined) rec.logged_at = new Date().toISOString();
    const safe = redactDeep(rec);
    if (JSON.stringify(safe) !== JSON.stringify(rec)) redacted += 1;
    const prior = typeof safe.id === 'string' ? existing.get(safe.id) : null;
    if (prior && prior.treegen === (Number(treegen) || 0) && prior.digest === stableDigest(safe)) { skipped += 1; continue; }
    appendFileSync(storeFile, JSON.stringify(safe) + '\n', 'utf8');
    if (typeof safe.id === 'string') existing.set(safe.id, { digest: stableDigest(safe), treegen: Number(treegen) || 0 });
    added += 1;
  }
  return { added, skipped, redacted };
}

/** 代的活跃节点清单：定义本代完整树，替代旧代节点不再参与检索/渲染。 */
export function appendTreeManifest(storeFile, session, treegen, activeIds, activeSegCount = null) {
  const sid = normalizeSid(session);
  const id = `tree-manifest-${sid}-${treegen}`;
  const existing = new Set(parseJsonlStream(storeFile).records.map((r) => r?.id));
  if (existing.has(id)) return { added: 0, id };
  const rec = {
    id, kind: 'tree-manifest', session: sid, treegen,
    active_ids: [...new Set((activeIds || []).filter((x) => typeof x === 'string'))],
    ...(Number.isFinite(Number(activeSegCount)) ? { seg_count: Number(activeSegCount) } : {}),
    logged_at: new Date().toISOString(),
  };
  appendFileSync(storeFile, JSON.stringify(rec) + '\n', 'utf8');
  return { added: 1, id };
}


/** Commit one tree generation: append only changed node rows, always publish active_ids. */
export function commitTreeGeneration(storeFile, session, treegen, nodes, segCount = null) {
  const sid = normalizeSid(session);
  const latest = latestNodes(storeFile, sid);
  const latestById = new Map(latest.map((n) => [n.id, stableDigest(n)]));
  const changed = (nodes || []).filter((n) => latestById.get(n.id) !== stableDigest(n));
  if (!changed.length) {
    return { built: false, reason: 'content-unchanged', treegen, nodes: latest.length, totalNodes: nodes.length, reused: true };
  }
  appendNodes(storeFile, changed, treegen);
  appendTreeManifest(storeFile, sid, treegen, nodes.map((n) => n.id), segCount);
  return { built: true, reason: 'built', treegen, nodes: changed.length, totalNodes: nodes.length };
}
/** 当前代（最新 treegen）节点；有 manifest 时以 manifest 的活跃集合为准。 */

export function latestNodes(storeFile, session) {
  const sid = String(session ?? '');
  const records = parseJsonlStream(storeFile).records;
  let byId = new Map();
  let manifest = null;
  for (const r of records) {
    if (r?.kind === 'tree-manifest' && sessionMatches(r.session, sid)) {
      if (!manifest || (Number(r.treegen) || 0) > (Number(manifest.treegen) || 0)) manifest = r;
    }
  }
  let committedGen = manifest ? (Number(manifest.treegen) || 0) : null;
  const fill = (gen) => {
    const map = new Map();
    for (const r of records) {
      if (r?.kind !== 'node' || !sessionMatches(r.session, sid) || typeof r.id !== 'string') continue;
      if (gen != null && (Number(r.treegen) || 0) > gen) continue;
      map.set(r.id, r);
    }
    return map;
  };
  byId = fill(committedGen);
  let active = manifest && Array.isArray(manifest.active_ids) && manifest.active_ids.every((id) => byId.has(id))
    ? new Set(manifest.active_ids) : null;
  if (manifest && !active) { committedGen = null; byId = fill(null); }
  const nodes = [...byId.values()].filter((r) => !active || active.has(r.id));
  return nodes.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
}

/** 树渲染（当前代）：层级行；供自主导航「看弧线」用。 */
export function renderTree(storeFile, session) {
  const sid = String(session ?? '');
  const nodes = latestNodes(storeFile, sid);
  if (!nodes.length) return `（无节点：先 node akasha.mjs session tree --build --session ${sid || '<id>'}）`;
  const records = parseJsonlStream(storeFile).records;
  let manifest = records
    .filter((r) => r.kind === 'tree-manifest' && sessionMatches(r.session, sid))
    .sort((a, b) => (Number(b.treegen) || 0) - (Number(a.treegen) || 0))[0] ?? null;
  if (manifest && Array.isArray(manifest.active_ids)) {
    const gen = Number(manifest.treegen) || 0;
    const present = new Set(nodes.filter((n) => (Number(n.treegen) || 0) <= gen).map((n) => n.id));
    if (manifest.active_ids.some((id) => !present.has(id))) manifest = null;
  }
  const segCount = manifest?.seg_count ?? new Set(records.filter((r) => sessionMatches(r.session, sid) && r.kind !== 'node' && r.kind !== 'tree-manifest').map((r) => r.id)).size;
  const levels = [...new Set(nodes.map((n) => n.level))].sort((a, b) => b - a);
  const gen = manifest?.treegen ?? 'fallback';
  const lines = [`小阿卡夏·树（${sid.slice(0, 8)}）：${nodes.length} 节点 / ${segCount} 段（treegen ${gen}）`];
  for (const lv of levels) {
    lines.push(`L${lv}：`);
    for (const n of nodes.filter((x) => x.level === lv)) {
      lines.push(`  - ${n.id} [${String(n.time_from).slice(0, 16)} → ${String(n.time_to).slice(0, 16)}] ${stripGenre(String(n.gist)).slice(0, 80)}`);   // I-11 P0-②：节点 gist 同属读侧渲染
    }
  }
  lines.push('细节：session node <id>；检索：session lookup <词> --level nodes');
  return lines.join('\n');
}

/** 循环观测汇总（P0 干跑，2026-10-07）：只读 hooks 记录 → phase/type/session 计数 + 最近摘录（坏行容忍）。
 *  含「修复前/后分组」：早于首个修正版插件重启时刻的命中为历史残迹（punct 类误报），≠新问题。 */
export const LOOP_WATCH_P0_FIXED_AT = '2026-10-07T11:57:00.000Z';
export function loopWatchStats(records, { since } = {}) {
  const s = { total: 0, hitsPreFix: 0, hitsPostFix: 0, byPhase: {}, byType: {}, bySession: {}, probes: 0, recent: [] };
  for (const r of records ?? []) {
    if (!r) continue;
    if (r.kind === 'loop-watch-probe') { s.probes += 1; continue; }
    if (r.kind !== 'loop-watch') continue;
    if (since && String(r.ts || '').slice(0, 10) < String(since).slice(0, 10)) continue;
    s.total += 1;
    if (String(r.ts || '') >= LOOP_WATCH_P0_FIXED_AT) s.hitsPostFix += 1; else s.hitsPreFix += 1;
    const ph = r.phase ?? '?';
    s.byPhase[ph] = (s.byPhase[ph] ?? 0) + 1;
    const t = r.hit?.type ?? '?';
    s.byType[t] = (s.byType[t] ?? 0) + 1;
    const sid = r.session ?? '?';
    s.bySession[sid] = (s.bySession[sid] ?? 0) + 1;
    s.recent.push({ ts: r.ts, session: sid, turn: r.turn ?? null, phase: ph, type: t, excerpt: String(r.hit?.excerpt ?? '').slice(0, 60) });
  }
  if (s.recent.length > 10) s.recent = s.recent.slice(-10);
  return s;
}

/** Plan manifests for sessions that predate tree-manifest. Pure; no writes. */
export function planManifestBackfill(records, { session: onlySession = null } = {}) {
  const nodesBySession = new Map();
  const manifests = new Map();
  for (const r of records ?? []) {
    if (!r || typeof r.session !== 'string') continue;
    const sid = normalizeSid(r.session);
    if (onlySession && sid !== normalizeSid(onlySession)) continue;
    if (r.kind === 'node') {
      if (!nodesBySession.has(sid)) nodesBySession.set(sid, []);
      nodesBySession.get(sid).push(r);
    } else if (r.kind === 'tree-manifest') {
      manifests.set(sid, Math.max(manifests.get(sid) ?? -1, Number(r.treegen) || 0));
    }
  }
  const plans = [];
  for (const [sid, nodes] of nodesBySession) {
    if (manifests.has(sid)) continue;
    const latest = Math.max(...nodes.map((r) => Number(r.treegen) || 0));
    const byId = new Map();
    for (const node of nodes) if (typeof node.id === 'string') byId.set(node.id, node);
    const activeNodes = [...byId.values()];
    const activeIds = activeNodes.map((r) => r.id);
    const nodeIds = new Set(activeIds);
    const SEG_CHILD_KINDS = new Set(['intent', 'action', 'conclusion', 'process', 'scaffold']);
    const sessionIds = new Set((records ?? []).filter((r) => normalizeSid(r.session) === sid && typeof r.id === 'string' && SEG_CHILD_KINDS.has(r.kind)).map((r) => r.id));
    const segIds = new Set();
    const missingChildren = new Set();
    for (const node of activeNodes) for (const child of (node.children ?? [])) {
      if (nodeIds.has(child)) continue;
      if (sessionIds.has(child)) segIds.add(child); else missingChildren.add(child);
    }
    const inherited = activeNodes.filter((r) => (Number(r.treegen) || 0) < latest).length;
    const partial = inherited > 0;
    plans.push({ session: sid, treegen: latest, active_ids: activeIds, seg_count: segIds.size, node_rows: activeNodes.length, inherited_nodes: inherited, missing_children: [...missingChildren], partial_generation: partial });
  }
  plans.sort((a, b) => a.session.localeCompare(b.session));
  return { plans, skippedWithManifest: manifests.size };
}
