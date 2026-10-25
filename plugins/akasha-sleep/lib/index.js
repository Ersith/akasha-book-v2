// 阿卡夏之书睡眠器 v1.5.1 —— 调度与注入（蒸馏逻辑归核心库 sleep.mjs）。
//   · 触发：agent/status → idle（去抖 minIntervalHours）+ 定时兜底 ctx.interval（默认 1h）
//   · 蒸馏/复核/待办/报告/水位线：核心库 sleepRun —— 手动 `node akasha.mjs sleep` 与之共用同一水位线
//   · 条子一：systemPrompt.context（akasha:sleep）——每回合带最近一次睡眠摘要
//   · 条子二（唤醒条）：agent/created → agent.inject 起床包摘要（不唤醒、不打断）
//   · 条子三（库脉搏 + 回查，v1.5）：systemPrompt.context（akasha:pulse）——六库计数 + 最近写入；
//     窗口内（默认 30 分钟）有失败时追一行「回查提示」（错误钩子的注入级动作，不拦截）
//   · 条子四（行为层，v1.10；2026-10-13 **按裁定重挂·默认关**）：形态 B（无正文 + 无工具）检测 → 观测线 `idle-shape`；
//     `idleResume:true` 时才自动续行（强信号＝思维链尾部「好。」；冷却 + 限次；文案禁清单/打勾/句号收尾）
//   · 降级：核心库不可用 → sleep-error 观测线 + 条子提示文案，不炸、不失活。
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// 注入安全（2026-10-11 立）：坑前提示注入的是**库正文**（canon 的 act 字段）⇒ 属"不可信输入"，
// 须先转义花括号（裸 `{{` 会让宿主插值抛错、该会话永久不可用），并加「库原文·仅参考」标注。
import { safeInject, safeInjectInline } from './prompt-safety.js';

export const inject = ['systemPrompt', 'timer'];

// —— 唤醒条消息构造（模块级导出，便于契约测试与复用）——
// 语义等价于宿主 @deepseek-ai/dsh-llm 的 createUserMessage：
//   createMessage(input) = deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
// 其中 brandString 是纯编译期类型标记（运行时恒等，见 @deepseek-ai/dsh-brand）。
export const newMessageId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `akasha-${Date.now()}-${Math.random().toString(16).slice(2)}`);
export const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};
export const createUserMessage = (input) => deepFreeze({ ...structuredClone(input), role: 'user', id: newMessageId() });

// 默认值：家目录下的 .akasha（可用 config 逐项覆盖）。
// 默认值：`AKASHA_DIR` 环境变量 → 家目录下的 .akasha（2026-10-10：一处配置贯通全部路径，
// 对外安装体验——此前用户必须逐项写 log/stateFile/inboxFile/akashaDir，漏一项就落到别处）。
const ENV_AKASHA = typeof process.env.AKASHA_DIR === 'string' && process.env.AKASHA_DIR.trim() !== '' ? process.env.AKASHA_DIR.trim() : null;
const DEFAULT_AKASHA = ENV_AKASHA ? (ENV_AKASHA === '~' ? homedir() : (ENV_AKASHA.startsWith('~/') || ENV_AKASHA.startsWith('~\\') ? join(homedir(), ENV_AKASHA.slice(2)) : ENV_AKASHA)) : join(homedir(), '.akasha');
const DEFAULTS = {
  log: join(DEFAULT_AKASHA, 'logs', 'hooks.jsonl'),
  akashaDir: DEFAULT_AKASHA,
  stateFile: join(DEFAULT_AKASHA, 'logs', 'sleep-state.json'),
  inboxFile: join(DEFAULT_AKASHA, 'logs', 'inbox.jsonl'),
  // 唤醒条：消息由插件**本地构造**（语义同宿主 createUserMessage；不动态加载宿主包——DSH-Store 静态扫描口径）。
  wakeNote: true,
  minIntervalHours: 6,
  timerCheckMs: 3600000,
  contextOrder: 130,
  pulseOrder: 132,
  addressOrder: 133,
  preflightOrder: 135, // C1｜易错点前置
  statefulOrder: 134,  // C3｜断言前把关（order 134 < 135 ⇒ 先渲染，命中时 C1 让位）
  gateOrder: 136,      // 门档｜重要工作自动挂（2026-10-15；排在 C3/C1 之后，不扰动既有的让位次序）
  // I-12b 行为层（2026-10-13 重挂；**默认关**——先观测）：判据＝形态 B；冷却 / 限次防扰动循环。
  idleResume: false,
  idleResumeOnWeak: false,
  idleResumeCooldownMs: 300000,
  idleResumeMax: 3,
  idleTailChars: 32,
  // F8（2026-10-16 batch8；VERIFY-S3 §5-F8）：审核面滞后检查的**超时值改为 cfg 可注入**（默认 5000 ms）。
  //   动机：测试里的超时驱动要实等整个超时 ⇒ route 套件从 0.65 s 抬到 6.4 s，每次回归都背。
  //   语义不变（同一条 kill 路径），只是不再把 5 s 写死在调用点。
  reviewLagTimeoutMs: 5000
};

// ── 占位符守卫（2026-10-19 发布面 P0）──────────────────────────────
// OSS 的 `cordis.patch.yml` 用 `<AKASHA_DIR>` / `<LOCAL_PATH>` 作示例字面量；照抄不改时字面量
// **优先于** AKASHA_DIR 默认值 ⇒ 睡眠/注入/观测线静默指向不存在的库。这里明确抛错（fail closed）。
const PLACEHOLDER_TOKEN = /<[A-Za-z][A-Za-z0-9_]{2,}>/;   // 大小写都认（审计 B）
/** 递归找配置里的未替换占位符（只认全大写尖括号 token，不误伤普通文本）。 */
export function findPlaceholders(value, path = 'config', depth = 0) {
  if (depth > 8) return [];
  if (typeof value === 'string') {
    const m = value.match(PLACEHOLDER_TOKEN);
    return m ? [{ field: path, token: m[0] }] : [];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => findPlaceholders(v, `${path}[${i}]`, depth + 1));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => findPlaceholders(v, `${path}.${k}`, depth + 1));
}
export function assertNoPlaceholders(config) {
  const hits = findPlaceholders(config);
  const envVal = process.env.AKASHA_DIR;
  if (typeof envVal === 'string' && envVal.trim() !== '') {
    const m = envVal.match(PLACEHOLDER_TOKEN);
    if (m) hits.push({ field: 'AKASHA_DIR(环境变量)', token: m[0] });
  }
  if (!hits.length) return;
  const fields = [...new Set(hits.map((h) => h.field))].join('、');
  throw new Error(
    `akasha-sleep: 配置里还有未替换的占位符 ${hits[0].token}（${fields}）。` +
    '请先把 cordis.patch.yml 里的 <AKASHA_DIR> / <LOCAL_PATH> 改成你的实际路径；' +
    '或删掉这些字段，改用 AKASHA_DIR 环境变量。' +
    '（宁可启动失败，也不静默降级——照抄占位符会让睡眠/注入指向不存在的库。）'
  );
}

/** 压缩后重投（2026-10-19）：取当前会话最近 N 条结论（session.jsonl 的 conclusion 段），一行一条（≤80）。 */
export function recentConclusions(akashaDir, sid, limit = 2) {
  const bare = String(sid || '').replace(/^session-/, '');
  if (!bare || bare === '(unknown)') return [];
  const file = join(akashaDir, 'data', 'session.jsonl');
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.includes('"kind":"conclusion"')) continue;
    try {
      const j = JSON.parse(line);
      if (j.kind !== 'conclusion') continue;
      if (String(j.session || '').replace(/^session-/, '') !== bare) continue;
      const gist = String(j.gist || '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim().replace(/^Master[，,]\s*/, '').replace(/#{1,6}\s*/g, '');
      if (gist) out.push(gist);
    } catch { /* 坏行跳过 */ }
  }
  return out.slice(-limit).map((s) => (s.length <= 74 ? s : s.slice(0, 73) + '…'));
}

/** 唤醒条是否值得推（有内容才说话）：无睡眠记录 / 有待办 / 审计有警告。 */
export function isWakeNoteworthy(k) {
  return !k.sleep || (k.inbox?.totalItems ?? 0) > 0 || (k.review?.findings ?? []).some((f) => f.level === 'warn');
}

/** 组装「唤醒条」文本（纯函数）。 */
export function buildWakeNote(k, conclusions = []) {
  const lines = ['【阿卡夏·起床包】'];
  lines.push(`库况：canon ${k.library.canon} / mirror ${k.library.mirror} / orphan ${k.library.orphan} / pricing ${k.library.pricing} / lexicon ${k.library.lexicon} / frontier ${k.library.frontier}`);
  // 2026-10-15（GPT 复核 lead L1）：此数是**本次睡眠生成**的待办（历史时点值），不是"当前待办总数"——
  // 标签写明，免得与下一行的当前 inbox 数并排时被读成矛盾（纯展示口径修正，无数据丢失）。
  lines.push(k.sleep ? `睡眠：${k.sleep.lastRunAt}（${k.sleep.trigger}）本次生成待办 ${k.sleep.todo}` : '睡眠：无记录（等待首个空闲）');
  if ((k.inbox?.totalItems ?? 0) > 0) lines.push(`待办 inbox：${k.inbox.totalItems} 条（akasha_promote 可转正）`);
  const warns = (k.review?.findings ?? []).filter((f) => f.level === 'warn');
  if (warns.length) lines.push(`审计：${warns.map((f) => f.code + '×' + f.count).join('，')}`);
  if (conclusions.length) {
    lines.push('近期结论（压缩前）：');
    for (const s of conclusions) lines.push('· ' + s);
  }
  lines.push('详情：akasha_kit');
  return lines.join('\n');
}

// —— I-12b 行为层：形态 B 判定（纯函数；2026-10-13 **按裁定重挂**）——
// 前史：旧钩子 1.8.x（判据＝「流无正文」）因 **形态 A 误报 + 扰动循环（抢险注入被写进思考链）**
//   被 Master 裁定删除（`canon-idle-hook-removed-20261013`）。本版按机制报告 §⑥ 收窄：
//   **形态 B ＝ 有思考、无正文、无工具调用**（真卡壳）；**形态 A（无正文 + 有工具）＝正常中间步骤，绝不报**。
//   先兆信号：思维链尾部「好。」（强，11× 危险比）/「。」（弱）；干预只在开闸（默认关）且强信号时发生。
export const IDLE_RESUME_TEXT = '【自动续行】请直接继续执行下一步：禁止列清单、禁止打勾、禁止以「。」收尾（想一条做一条）。若确实已无事可做、或需要用户输入，请直接输出正文说明。';
/** 一回合的流信号 → 判定：shape `normal` | `A`（无正文+有工具）| `B`（无正文+无工具）；signal `hao` | `o` | null。 */
export function judgeIdleTurn({ hasText, toolCalls, tail } = {}) {
  const shape = hasText === true ? 'normal' : ((Number(toolCalls) || 0) > 0 ? 'A' : 'B');
  const t = String(tail ?? '');
  const signal = t.endsWith('好。') ? 'hao' : (t.endsWith('。') ? 'o' : null);
  return { shape, signal, stall: shape === 'B' };
}

/** S4（2026-10-13）：尾部窗口读 + 取「最近一条非注入 intent 的 gist」——两个纯函数。
 *  做成**顶层导出**（而不是埋在 apply 里）的唯一理由：自测要拿它们做等价对照；
 *  生产路径（apply 内的 akasha:stateful 状态条）调用的就是这两个导出，不存在「测试一份、生产另一份」。 */
export const TAIL_WINDOW_BYTES = 256 * 1024;
export function tailReadText(file, maxBytes = TAIL_WINDOW_BYTES) {
  const st = statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return { text: '', bytes: 0, size: st.size, truncated: false };
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, start);
    let text = buf.subarray(0, n).toString('utf8');
    // 2026-10-16 审修：**bytes = 实际读入字节数**（截断时恒等于窗口），**size = 文件真大小**——
    //   调用方（gate-window-miss 观测线）此前把 bytes 当 fileBytes 记，日志无法反映"差多远"。
    if (start > 0) { const nl = text.indexOf('\n'); if (nl === -1) return { text: '', bytes: n, size: st.size, truncated: true }; text = text.slice(nl + 1); }
    return { text, bytes: n, size: st.size, truncated: start > 0 };
  } finally { closeSync(fd); }
}
// 会话身份是完整宿主 ID；`session-1`、`1`、`session-session-1` 是三个不同身份。
// 生产者已经保留原始 ID。旧短 ID 缺少可核对映射时不得猜别名，需核对原档后重索引。
// 2026-10-15 V02 补注（GPT N1/N2 收尾）：**存储侧**入口存裸 uuid（核心 normalizeSid）；**读侧**＝精确优先 + 归一兜底
// （见下方 latestIntentGist 与 gate.test 的跨 ID 段）——不猜"旧短 ID"别名，但 `session-` 前缀这一种等价形态必须互认。

export function latestIntentGist(text, session) {
  // V02：当前会话尚无 intent 也不能回退到另一个合法 ID；无标记的完整 ID 历史记录仍可精确读取。
  // 省略参数仅保留给原有离线尾读诊断；运行时两个调用方均明确传入完整 ID 或 null。
  if (session === null || session === '' || session === '(unknown)') return null;
  const want = session === undefined ? undefined : String(session);
  const lines = String(text ?? '').split('\n');
  const pick = (pred) => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"kind":"intent"')) continue;
      let r; try { r = JSON.parse(lines[i]); } catch { continue; }
      if (pred && !pred(r)) continue;
      const g = String(r.gist || '');
      if (!g) continue;
      // 规则化跳过注入段（2026-10-10 生产核对：除 runtime context 外还有 openviking / hindsight 等注入块被记成 intent）
      if (g.startsWith('<') || g.length > 800
        || /Current runtime context|Relevant memory from|Hindsight|openviking-context|阿卡夏·/.test(g)) continue;
      return g;
    }
    return null;
  };
  if (want === undefined) return pick(null);
  // 2026-10-15（GPT 复核"跨组件 ID 约定冲突"，板上第 7 条，实证）：核心侧**入口一律存裸 uuid**（`normalizeSid`），
  // 而宿主给插件的是**完整 `session-<uuid>`** ⇒ 原第 137 行的严格相等在带前缀会话上恒不匹配 ⇒ gate/stateful **同时静默**。
  // 修法：**精确优先**（保留 Q06 的"不许跨会话误配"），再以**归一兜底**（两边都去掉前缀后比较）。
  const exact = pick((r) => String(r.session ?? '') === want);
  if (exact) return exact;
  const norm = (v) => String(v ?? '').replace(/^session-/, '');
  const nw = norm(want);
  // 2026-10-19 修（OSS review5-identity 2 条单元红；独立审查裁决＝真 fail-open，severity 中）：
  //   原归一兜底对**任意** want 生效 ⇒ `'1'` 会匹配到 `'session-1'`、`'session-other'` 之类，
  //   把一个不存在的身份"猜"成别的会话（跨会话别名越权）。真库 52046 行全是 UUID 形态，
  //   ⇒ 门控到 UUID：只有 `session-<uuid>` / `<uuid>` 这一对等价形态互认，其余一律精确匹配。
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!nw || !UUID_RE.test(nw)) return null;
  return pick((r) => { const rn = norm(r.session); return UUID_RE.test(rn) && rn === nw; }) ?? null;
}

/** 门档触发判据（2026-10-15 落地；**顶层导出**，供自测做等价对照——与 tailReadText/latestIntentGist 同规矩）。
 *  依据：canon-thinkloop-gate-20261015（何时该开三趟+独立审核）+ canon-gate-v2-20261015（v2：p0 机检 97s / 升级项才开慢层）。
 *  三类「重要工作」：① 代码（写/改/修/实现/重构）② 审计（审/复核/证伪/根因）③ 数据完整性/不可逆（迁移/重建/紧凑化/回滚/发布/删除）。
 *  **负例优先**：泛词不算——「查代码/看代码/代码在哪」这类检索动作**不得**触发（否则每回合都响，退化成噪音）。 */
export const GATE_TRIGGERS = [
  // 2026-10-15 修（门档自审发现）：原词表**漏掉高频口语表达** ⇒ 7 条实测里 6 条不触发（含「全量检查」「排查」「体检」「审一下」）——
  // 最该挂门档的场景反而挂不上（当天那次"对阿卡夏做一次全量检查"就是靠用户明说才走的）。
  { cat: '审计', re: /审计|审查|审核|复核|复检|复验|核对|排查|检查|体检|证伪|挑错|挑毛病|找问题|对抗性|根因|事故|审一下|查一下有没有问题/ },
  { cat: '迁移/不可逆', re: /迁移|重建|紧凑化|回滚|清库|发布|上线|不可逆|删掉|删除/ },
  { cat: '代码', re: /(写|改|修|加|补|实现|重构|落)(一下|下|个|一个|一段|点|这个|那个|的)*\s*(代码|函数|脚本|补丁|模块)|修\s*(个|一个)?\s*bug|fix\s*bug|重构|落码|实现一下/ },
];
export function gateTriggerOf(gist) {
  const t = String(gist ?? '').trim();
  if (!t) return null;
  if (/查代码|看代码|搜代码|读代码|代码在哪|找代码|代码风格|代码库|代码量/.test(t)) return null;   // 负例优先
  for (const g of GATE_TRIGGERS) if (g.re.test(t)) return { cat: g.cat };
  return null;
}

// 审核面滞后检查的**模块级单例**（2026-10-16 batch6 补丁 D；口径按 batch6 复核 VERIFY-S2 §3 收窄）：
//   原定义在 apply() 闭包里 ⇒ 严格说是「插件实例级」（当前 cordis.yml 只有一条 root 插入、实例数=1，故与
//   现状等价）。提到模块级 ⇒ **同一模块实例**内重复 `apply()`（同一进程、同一求值结果）共用同一份节流与
//   结果，不会出现 N 份节流与 N 次 exec。
//   ⚠ 边界（实测，别过度推广）：**重新求值 ≠ 同一实例**——两个独立模块实例（不同 cache-buster，≈ HMR
//   重新求值而旧实例未被复用）会**各持一份节流、各跑一次 exec**。所以「不会 N 份」的口径只对
//   「同一模块实例内的重复 apply」成立，不对「进程全局」成立。
//   导出仅供测试：route.test.mjs 用 `reviewLagState.at = 0` 复位节流（同进程多段用例各跑各的）。
export const reviewLagState = { at: 0, value: null, logged: null, checkedAt: null };
// O1（2026-10-17 batch15 · 显示面）：检查时点只用于**显示**，不参与节流/判定（`at` 仍是节流唯一依据）。
//   背景（VERIFY-A4 §5-O1）：戳重生成后、下一次 turn/end 检查到来前，显示的是上一结果 ⇒ 06:35–06:46 出现
//   「脉搏报滞后」与「实跑 exit 0」的**时间差分歧**。附时点后「这个结论是什么时候的」一眼可见；判定不动。
// O1-b（2026-10-17 batch16 · 显示面，VERIFY-S7 §7）：只有 `HH:MM` 时，进程长期静默（无 turn/end、无写入）
//   ⇒ 旧结果跨日会被读成「今天 06:50」（今天 06:50 与明天 06:50 逐字相同）。修法：**超过 6h 的时点补日期**
//   （`MM-DD HH:MM`），6h 内仍只给 `HH:MM`（短、不白占行宽）。
//   阈值取 6h 的判据：与本插件 `minIntervalHours` 同一量级；「今天 HH:MM」与「昨天同 HH:MM」要混淆须错位
//   ≥18h（同刻度落在 6h 窗外才可能同形）⇒ 6h 外的时点带日期即无歧义。判定/节流仍**不读** checkedAt。
const stampOf = (ms) => {
  const d = new Date(ms), p = (x) => String(x).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return Date.now() - ms < 6 * 3600_000 ? t : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}`;
};

// D1/F6（2026-10-16 batch8 · VERIFY-S3 §5-F6）：**raw 分类器**——从 execFileSync 抛出的 error 取「真因」。
//   优先级：真实退出码（number）> **`error.code` 字符串** > 信号（`'SIG:' + signal`）> `'-'` 兜底。
//   ⚠ 顺序是实测定的（batch8 landing/tools/probe-timeout-shape.mjs）：**超时被杀同时带**
//   `signal:'SIGTERM'` 与 `code:'ETIMEDOUT'`（status 为 null）⇒ 若信号优先，raw 会从 `'ETIMEDOUT'`
//   退化成 `'SIG:SIGTERM'`（信息变差；H-3 用例当场红）。信号格只在 **code 缺失** 时兜底
//   （POSIX 信号杀：status 为 null、code 为 undefined、signal='SIGKILL'）。
//   提到顶层导出的理由：`'-'` / `'SIG:x'` / `'ENOENT'`（字符串格）在 **Windows 上不可达**，
//   只能直测本函数（route.test.mjs H+++ 段）；生产路径（runReviewLag 的 catch）调用的就是这一份
//   ——不存在「测试一份、生产另一份」。
export const rawOfError = (e) => (typeof e?.status === 'number'
  ? e.status
  : (typeof e?.code === 'string' ? e.code
    : (typeof e?.signal === 'string' ? 'SIG:' + e.signal : '-')));

export function apply(ctx, config = {}) {

  // A/B 实验开关（2026-10-10 用户解冻，见 docs/ab-experiment-design.md §6）：
  // abOff=true ⇒ **关闭臂**——本插件不注册任何守卫/注入/工具，只记一行观测；库文件与日志照旧（便于事后复盘）。
  if (config.abOff === true) {
    try { (ctx.logger?.info ?? (() => {}))('sleep: abOff=true（A/B 关闭臂）——本插件不注册任何面'); } catch { /* 静默 */ }
    return;
  }
  assertNoPlaceholders(config);
  const cfg = { ...DEFAULTS, ...config };
  if (!existsSync(cfg.akashaDir)) {
    throw new Error('akasha-sleep: akashaDir 不存在：' + cfg.akashaDir + '。安装步骤：① git clone https://github.com/Ersith/akasha-book 并复制 core/ 到固定目录；② 替换 cordis.patch.yml 的 <AKASHA_DIR>（或设 AKASHA_DIR）；③ 重启宿主。');
  }
  // Empty optional prompts must use a string at the Harness API boundary.
  const registerContext = ({ text, ...entry }) => ctx.systemPrompt.context({
    ...entry,
    text: typeof text === 'function'
      ? (context) => text(context) ?? ''
      : text ?? '',
  });
  const require_ = createRequire(import.meta.url);
  const reportDir = join(cfg.akashaDir, 'logs');
  const stateFile = cfg.stateFile || join(reportDir, 'sleep-state.json');
  const inboxFile = cfg.inboxFile || join(reportDir, 'inbox.jsonl');

  const log = (record) => {
    try {
      mkdirSync(dirname(cfg.log), { recursive: true });
      appendFileSync(cfg.log, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', 'utf8');
    } catch { /* 静默：观测线写不了不拖垮宿主 */ }
  };
  const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };

  // 核心库（蒸馏逻辑）动态加载：插件只做调度与注入；缺文件时降级留痕（不失活）。
  const core = () => require_(join(cfg.akashaDir, 'sleep.mjs'));

  const runSleep = (trigger) => {
    try {
      const r = core().sleepRun({ trigger, log: cfg.log, stateFile, inboxFile, reportDir });
      if (!r.ok) { log({ kind: 'sleep-error', trigger, message: String(r.error).slice(0, 300) }); return false; }
      log({ kind: 'sleep-done', trigger, report: r.reportFile, todo: r.todo, counters: r.state?.lastCounters, audit: r.state?.lastAudit });
      return true;
    } catch (error) {
      log({ kind: 'sleep-error', trigger, message: String(error?.message ?? error).slice(0, 300) });
      return false;
    }
  };

  const maybeSleep = (trigger) => {
    try {
      const verdict = core().shouldSleep(readState(), Date.now(), cfg.minIntervalHours);
      if (!verdict.due) { log({ kind: 'sleep-skip', trigger, sinceHours: verdict.hoursSince }); return; }
      runSleep(trigger);
    } catch (error) {
      log({ kind: 'sleep-error', trigger, message: String(error?.message ?? error).slice(0, 300) });
    }
  };

  // 唤醒条（M6b）：新会话（agent/created）自动把「起床包」摘要递进 next-step inbox（不唤醒、不打断）。
  // 仅当有内容（无睡眠记录 / 有待办 / 审计警告）才说话；子代理与 compact 不打扰；一切异常只留痕。
  // 消息构造用模块级 createUserMessage（见文件头；本地实现、不动态加载宿主包）。
  const llmSkipNote = cfg.wakeNote === false ? 'wakeNote=false：唤醒条注入跳过（其余功能不受影响）' : null;

  const injectWakeNote = (agent) => {
    try {
      if (!agent || typeof agent.inject !== 'function' || !createUserMessage) return;
      const k = require_(join(cfg.akashaDir, 'lib.mjs')).kit();
      if (!isWakeNoteworthy(k)) return;
      const message = createUserMessage({
        content: [{ type: 'text', text: safeInject(buildWakeNote(k)) }],   // #14 保守包裹：唤醒条内含 kit（库内容：待办/审计/脉搏）；agent.inject 是否也走插值**未验证** ⇒ 包上无害 ✓（2026-10-11 手检）
        source: { kind: 'akasha-wake' }
      });
      agent.inject(message);
      log({ kind: 'wake-note', session: String(agent.id ?? ''), todo: k.inbox?.totalItems ?? 0, auditOk: k.review?.ok ?? null });
    } catch (error) {
      log({ kind: 'wake-note-error', message: String(error?.message ?? error).slice(0, 200) });
    }
  };

  ctx.on('agent/created', (payload) => {
    try {
      // 2026-10-07 复查：官方 agent/created 的 source 只有 startup/resume；子代理守卫沿用 header.origin / delegationDepth。
      const agent = payload?.agent;
      const header = agent?.session?.header;
      if (header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0) return;
      if (cfg.wakeNote === false) return;
      injectWakeNote(agent);
    } catch (error) {
      log({ kind: 'wake-note-error', message: String(error?.message ?? error).slice(0, 200) });
    }
  });

  // —— I-12b 行为层（2026-10-13 深夜 · **按 Master 裁定「重挂（默认关）」重挂**）——
  // 前史：同位置旧钩子（判据＝「流无正文」）因 **形态 A 误报 + 扰动循环** 被裁定删除（canon-idle-hook-removed-20261013）。
  // **物证（2026-10-13 复查）**：旧实现包 `local-akasha-sleep-1.8.1-h1.tgz` 仍在——其链路＝「**流 end 帧**判定 →
  //   `agent.inject(createUserMessage{source.kind:'akasha-resume'})`」，三级降级全部实测拉回成功（canon-idle-resume-verified-20261013）。
  //   ⇒ 本版**沿用该有效链路**（判定点＝attempt `end` 帧、注入 API ＝ agent.inject），**只换判据与护栏**：
  // ① 判据收窄至**形态 B**（该 attempt：无正文 + 无工具调用；A 形态＝正常中间步骤，绝不报，只落观测线）
  //    + 强信号＝思维链尾部「好。」；
  // ② 干预**默认关**（`idleResume:true` 才开；观测线 `idle-shape` 无论开关都落——先观测）；
  // ③ 防扰动循环：冷却 idleResumeCooldownMs + 单会话限次 idleResumeMax + 文案禁清单/打勾/句号收尾（机制报告 §⑥）。
  // 证据链：canon-idle-mechanism-20261013-r1 · research/lora-cot-degradation-investigation-20261013.md
  const idleAttempts = new Map();   // attemptId -> { sid, text, tools, tail }（按 attempt 收，end 帧判完即删）
  const idleGate = new Map();       // sid -> { count, lastAt }
  const idleTailChars = Number.isInteger(cfg.idleTailChars) && cfg.idleTailChars > 0 ? cfg.idleTailChars : 32;
  const isSubagentAgent = (agent) => {
    const h = agent?.session?.header;
    return h?.origin === 'subagent' || (h?.delegationDepth ?? 0) > 0;
  };
  const idleEvaluate = (agent, a, meta = {}) => {
    const sid = String(agent?.session?.id ?? agent?.id ?? '');
    if (!sid || isSubagentAgent(agent)) return;
    const j = judgeIdleTurn({ hasText: a.text, toolCalls: a.tools, tail: a.tail });
    if (j.shape !== 'normal') log({ kind: 'idle-shape', session: sid, shape: j.shape, signal: j.signal, tools: a.tools, turn: meta.turn ?? null, step: meta.step ?? null });
    const strong = j.signal === 'hao' || (cfg.idleResumeOnWeak === true && j.signal === 'o');
    const gate = idleGate.get(sid) ?? { count: 0, lastAt: 0 };
    const now = Date.now();
    const eligible = j.stall && strong
      && gate.count < (Number.isInteger(cfg.idleResumeMax) ? cfg.idleResumeMax : 3)
      && (now - gate.lastAt) >= (Number.isFinite(cfg.idleResumeCooldownMs) ? cfg.idleResumeCooldownMs : 0);
    if (cfg.idleResume === true && eligible && typeof agent?.inject === 'function') {
      agent.inject(createUserMessage({ content: [{ type: 'text', text: IDLE_RESUME_TEXT }], source: { kind: 'akasha-idle-resume' } }));
      idleGate.set(sid, { count: gate.count + 1, lastAt: now });
      log({ kind: 'idle-resume', session: sid, turn: meta.turn ?? null, step: meta.step ?? null, count: gate.count + 1, signal: j.signal });
    }
  };
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      const agent = payload?.agent;
      const frame = payload?.frame;
      const frameType = String(frame?.type ?? '');
      const attemptId = String(frame?.attemptId ?? '');
      if (!frameType) return;
      if (frameType === 'start') {
        idleAttempts.set(attemptId || String(idleAttempts.size), { sid: String(agent?.session?.id ?? agent?.id ?? ''), text: false, tools: 0, tail: '' });
        if (idleAttempts.size > 30) idleAttempts.delete(idleAttempts.keys().next().value);   // 保新：只留最近 30 条流
        return;
      }
      if (frameType === 'end') {
        const key = attemptId || '';
        const a = idleAttempts.get(key);
        idleAttempts.delete(key);
        if (!a) return;
        idleEvaluate(agent, a, { turn: frame?.turn ?? null, step: frame?.step ?? null });
        return;
      }
      if (frameType !== 'chunk') return;
      const c = frame?.chunk;
      if (!c || typeof c.type !== 'string') return;
      const key = attemptId || 'anon';
      let a = idleAttempts.get(key);
      if (!a) { a = { sid: String(agent?.session?.id ?? agent?.id ?? ''), text: false, tools: 0, tail: '' }; idleAttempts.set(key, a); }
      if (c.type === 'text-delta') a.text = true;
      else if (c.type === 'tool-call-delta') a.tools += 1;
      else if (c.type === 'reasoning-delta') a.tail = (a.tail + String(c.text ?? '')).slice(-idleTailChars);
    } catch { /* 观测不拖垮宿主 */ }
  });

  // 条子：每个新回合的 runtime context 自动带上最近一次睡眠摘要（渲染自核心库，失败安全）。
  registerContext({
    name: 'akasha:sleep',
    order: cfg.contextOrder,
    text: (context) => {
      retarget(renderSidOf(context));
      try { return core().renderContextLine(readState()); }
      catch { return '阿卡夏·睡眠：核心库不可用（akasha\\sleep.mjs 缺失或损坏）。'; }
    }
  });

  // 回查提示（v1.5，错误钩子的注入级动作）：进程内记录近期失败（工具 / agent），窗口内幂等渲染。

  // 触发词路由（2026-10-11 解冻后新增）：**最近的用户消息文本** + 已触发过的条目（去重）。
  // ⚠ 只存内存、只在进程内、不落盘；超 TTL 视为过期（避免拿很久以前的任务文本乱触发）。
  const USER_TEXT_TTL = 10 * 60 * 1000;
  /** 从 session/event 的 user/message 事件里**防御式**取正文（载荷形状随宿主版本可能不同）。 */
  const textOfUserEvent = (p) => {
    try {
      const d = p?.data ?? p ?? {};
      const cand = [d?.text, d?.content, d?.message?.text, d?.message?.content,
        d?.parts, d?.message?.parts, d?.message];
      for (const c of cand) {
        if (typeof c === 'string' && c.trim()) return c.trim();
        if (Array.isArray(c)) {
          const s = c.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).join(' ').trim();
          if (s) return s;
        }
      }
    } catch { /* 取不到就当作没消息 */ }
    return '';
  };
  // ── F09/F10（2026-10-14 外部审查 · GPT）：**会话状态按 session 分桶** ─────────────────────────────
  //   原实现把 观测计数（轮/压缩）/失败列表/首用集合/触发去重/去抖状态 全放进程级 ⇒ 换会话后新会话继承旧会话的
  //   「已压缩 N 次」「上次失败是 edit」等状态（上下文污染 + 抑制当前提醒）。现在全部进**会话桶**：
  //   事件先 retarget(sidOf(payload)) 切桶，渲染面取当前桶；会话 id 缺失时归 '(unknown)' 桶（最多 8 桶 LRU）。
  //   F10 同批：C3 的「已触发」从**永久布尔**改为**当轮标记**（c3Turn）——不再是「一次触发压制到重载」。
  const sessionStates = new Map();
  let curSid = '(unknown)';
  const sidOf = (p) => {
    try {
      const a = p?.agent ?? p?.data?.agent;
      const s = (typeof p === 'string' ? p : null) ?? p?.id ?? a?.session?.id ?? a?.id ?? p?.session?.id ?? p?.session ?? p?.data?.session ?? p?.sessionId;
      return s === undefined || s === null || s === '' ? null : String(s);
    } catch { return null; }
  };
  const freshState = () => ({
    obs: { turn: 0, steps: 0, compactions: 0, usedToolsN: 0, lastRecallTurn: null, lastCompactionTurn: null },
    recentFailures: [], usedTools: new Set(), announcedTraps: new Set(),
    lastUserText: { text: '', at: 0 }, firedTriggers: new Map(), broughtUp: { at: 0, id: null },
    gateState: { c3Cat: null, c3At: 0, c3Turn: -1, gateCat: null, gateAt: 0, gateTurn: -1 }, preflight: { tool: null, at: 0 },
  });
  const S = () => {
    if (!sessionStates.has(curSid)) sessionStates.set(curSid, freshState());
    const s = sessionStates.get(curSid);
    sessionStates.delete(curSid); sessionStates.set(curSid, s);
    while (sessionStates.size > 8) sessionStates.delete(sessionStates.keys().next().value);
    return s;
  };
  // R04：**无 sid 不继承**——缺身份的输入归 `(unknown)` 桶，绝不沿用上一会话（来源不明 ⇒ 不碰敏感提醒）。
  const retarget = (sid) => { curSid = sid ? String(sid) : '(unknown)'; };
  const renderSidOf = (context) => sidOf(context?.agent ?? context?.session ?? context);
  // Q06：normSid 归一弃用（见 latestIntentGist 的精确优先实现；生产者改存完整 ID）。
  const noteFailure = (tool) => {
    try {
      S().recentFailures.push({ ts: Date.now(), tool: String(tool ?? '?') });
      if (S().recentFailures.length > 20) S().recentFailures.splice(0, S().recentFailures.length - 20);
    } catch { /* 静默 */ }
  };
  // 极限观测（2026-10-11 用户令）：把「该查库了」变成**可见信号**，不靠记性——针对"200 轮后忘记查库"的观察。
  const clip = (s) => (s.length <= 80 ? s : s.slice(0, 79) + '…');   // 行宽硬约束的统一裁剪（模块级，供多行共用）
  const isRecallTool = (name) => /^mcp__akasha__/.test(String(name || ''));
  ctx.on('tools/result', (exec, result) => {
    retarget(sidOf(exec));
    const tool = String(exec?.name ?? '?');
    S().usedTools.add(tool);                                          // 首用预告用（2026-10-11）
    S().obs.usedToolsN = S().usedTools.size;
    if (isRecallTool(tool)) S().obs.lastRecallTurn = S().obs.turn;         // MCP 召回 ⇒ 刷新"距上次查库"
    else {
      // CLI 查库也算召回（2026-10-11 实测：本会话大量查库走 `node akasha.mjs …`，只认 MCP 会显示"尚未查库"＝自欺）
      try {
        // N11（GPT 第三轮）：宿主 ToolExecution 的执行参数在 **exec.arguments**（dsh-tools 契约）；args/input/params
        //   只作旧夹具兼容——前者优先，避免「真实 CLI 查库后仍显示未查库」。
        const blob = JSON.stringify(exec?.arguments ?? exec?.args ?? exec?.input ?? exec?.params ?? '');
        if (/akasha\.mjs|session\.mjs|mcp\.mjs/.test(blob)) S().obs.lastRecallTurn = S().obs.turn;
      } catch { /* 忽略 */ }
    }
    if (result?.isError === true) noteFailure(exec?.name);
  });
  ctx.on('agent/error', (p) => { retarget(sidOf(p)); noteFailure('agent'); });
  // 轮次与压缩真值：能拿到就用真值，拿不到就保持 0（宁缺勿假）
  try { ctx.on('agent/turn-stopping', (p) => { retarget(sidOf(p)); if (p && typeof p.turn === 'number') S().obs.turn = p.turn; }); } catch { /* 事件不存在 */ }
  // ⚠ 2026-10-16 独立审修复：原 `ctx.on('agent/turn-end', …)` 是**死监听**——宿主不存在该事件
  //   （权威面：dsh-scope/scoped-events.generated.js 与 dsh-tool-cordis api-catalog 的 agent/* 列表只有
  //   turn-stopping/status/…，无 turn-end；全树 grep 'agent/turn-end' 亦零命中）。原两处注册（本行旧
  //   obs.turn 更新 + 下方 review-lag）因此从未触发。改走 **durable 路由** session/event type='turn/end'
  //   （与 akasha-hooks / dsh-akasha-session 同一路由；hooks.jsonl 的 kind:'turn-end' 即由它产生）。
  // 审核面滞后（2026-10-16 收 · 独立审 2026-10-16 修）：
  // 结果改存**进程级单例**（检查与会话无关：查的是仓库面，按会话分桶只会 N 倍跑进程且显示分散）。
  // 安全：60s 节流、5s 超时、全 try；exit 1（有滞后）是**预期路径**不是故障；任何异常都不得影响回合。
  const REVIEW_LAG_INTERVAL = 60 * 1000;
  // reviewLagState 已在**模块级**（2026-10-16 batch6 补丁 D）——本实例与将来任何实例共用同一份节流与结果。
  // P4b（2026-10-16 审修·观测面）：**状态变化才落线**（kind:'review-lag'，code + 首行截断）——原实现成功/失败都不留痕，
  //   事后连「钩子跑没跑过」都无从核；不改 60s 节拍，只把结果变化记进 hooks.jsonl 供审计对照。
  // D1（2026-10-16 batch7 · 观测线字段面变更，VERIFY-S2 §5-D1）：**raw 记非滞后态的真因**——
  //   1.10.14 里 code:-1 同时承担「工具没装 / 语法错 / 超时 / 其它退出码」四类，事后审计无法区分
  //   「工具没装」与「工具跑了但崩了」。raw 取值域（**凡非滞后态都带 raw**；⚠ 滞后态**同样带 raw**
  //   ——batch8·F1 更正：batch7 原文写「滞后态不带」，与代码相反、实测滞后行 = `{"code":1,"raw":1,…}`；
  //   `code + line` 已足够表达「有滞后」，故 raw 在此只作退出码确证）：
  //     · number —— 子进程真实退出码（如 3、1（无 stdout，如语法错））
  //     · 'ETIMEDOUT' —— 超时被杀（execFileSync：status 为 null、error.code 为该值；
  //       ⚠ 实测这条**同时带** signal='SIGTERM' ⇒ rawOfError 里 code 优先于 signal，才拿到 'ETIMEDOUT'）
  //     · 'ENOBUFS' —— 子进程 stdout 超 maxBuffer（batch8·F6 更正分类：**不是** spawn 级）
  //     · 'SIG:<name>' —— 被信号杀死（batch8·F6：`e.signal` 存在且 **code 缺失** 时记；POSIX 可达，
  //       本机 Windows 不可达——超时路径虽带 SIGTERM，但 code='ETIMEDOUT' 先命中）
  //     · 'ENOENT' / 'EACCES' 等 **spawn 级** error.code —— 只在**可执行本体 / cwd 找不到**时出现
  //       （batch8·F2 更正：`node <缺脚本>` **不落这一格**——7 种调用形态实测全为 status:1、
  //       code=undefined；node 起得来、在模块解析阶段失败，stderr 打 MODULE_NOT_FOUND。脚本路径不存在 /
  //       目录不存在 / 路径是目录三种「工具起不来」⇒ raw=1，见 batch7 landing/tools/probe-h4.mjs
  //       与 batch7 VERIFY-S3 §1.2）
  //     · '-' —— 编号与字符串都取不到（兜底）
  //   去重键含 raw（原因不同各留一行，不被去重吞掉）；显示面与 `isLag` 判据不变。
  //   ⚠ batch8·F5：**键与存储同粒度**——键用截断后的 `shown`（旧写法键用**未截断** `v.line`、
  //   存储 `slice(0,80)` ⇒ 只在第 80 字之后不同的两条真状态会落成两行「除 ts 外逐字节相同」的记录）。
  const noteReviewLag = (v) => {
    try {
      reviewLagState.value = v;
      reviewLagState.checkedAt = Date.now();   // O1：本次检查的时点（与 value 同步更新，不参与判定）
      const shown = String(v.line ?? '').slice(0, 80);
      const key = `${v.code}|${v.raw ?? ''}|${shown}`;
      if (key !== reviewLagState.logged) {
        reviewLagState.logged = key;
        log({ kind: 'review-lag', code: v.code, ...(v.raw !== undefined ? { raw: v.raw } : {}), line: shown });
      }
    } catch { /* 静默：观测线写不了不拖垮回合 */ }
  };
  // D3（2026-10-16 batch7 · 契约路线，VERIFY-S2 §5-D3）：**工具首行必须走 stdout**（当前真工具
  //   `akasha/tools/review-lag.mjs` 走 console.log，符合；该文件属 `akasha/tools/**`，本批不动，
  //   契约写在消费侧这里）。判据只认 `code===1 && stdout 首条非空行`：真滞后若改走 stderr ⇒ 会
  //   被判成「工具起不来」⇒ 显示面静默、观测线 `-1`（**新的静默失败模式**——BEFORE 1.10.14 至少
  //   还会显示一行「有滞后」）。
  //   ⇒ 改工具输出通道（换 stderr / 套一层 wrapper 吞掉 stdout）＝改契约，须同批改本判据；
  //   未选「判据放宽到认 stderr 标记」的理由见 batch7 landing README §2-D3：那会为一条**没写下来的
  //   契约**增加新的判据面（stderr 文本匹配），且任何在 stderr 打印该标记的工具都会被算成「有滞后」。
  // D3（2026-10-19 发布面 P1）：检查器脚本的**布局**有两种——
  //   OSS 仓 / 发布件＝扁平 `<akashaDir>/tools-review-lag.mjs`；活树（本仓）＝`<akashaDir>/tools/review-lag.mjs`。
  //   旧实现只认后者 ⇒ 装出来的 OSS 包里该路径不存在：node 起得来、在模块解析阶段失败（exit 1、stdout 空）
  //   ⇒ 观测线只剩一行无法解读的 code:-1，连"脚本没装"还是"脚本崩了"都分不出。
  //   ⇒ 候选链（先扁平、后嵌套）。都不在时落**一行明确的 skip**（kind:'review-lag-skip'，带候选清单）；
  //     随后仍按旧路径真跑一次——不是拖延，而是为了 raw 记**真因**（route.test.mjs 已把"raw=真实退出码"
  //     钉成契约：伪造 raw 比多跑一次更糟）。
  const reviewLagScripts = (akashaDir) => [
    join(akashaDir, 'tools-review-lag.mjs'),          // OSS / 发布件（扁平命名）
    join(akashaDir, 'tools', 'review-lag.mjs'),       // 活树（tools/ 目录）
  ];
  let reviewLagSkipLogged = null;   // skip 行去重：同一候选清单只落一次（不刷屏）
  const noteReviewLagSkip = (candidates) => {
    try {
      const key = candidates.join('|');
      if (key === reviewLagSkipLogged) return;
      reviewLagSkipLogged = key;
      log({ kind: 'review-lag-skip', candidates, why: 'review-lag 脚本不在候选链上（两种布局都没有该文件）' });
    } catch { /* 静默：观测线写不了不拖垮回合 */ }
  };
  const runReviewLag = () => {
    try {
      if (Date.now() - reviewLagState.at < REVIEW_LAG_INTERVAL) return;
      reviewLagState.at = Date.now();
      const candidates = reviewLagScripts(cfg.akashaDir);
      const scriptPath = candidates.find((p) => existsSync(p));
      if (!scriptPath) noteReviewLagSkip(candidates);   // 明确 skip（不再只剩一行 code:-1）
      execFileSync(process.execPath, [scriptPath || candidates[1]],
        {
          // F8（batch8）：超时值改 cfg 可注入（默认 5000）——测试实等 5 s 会永久拖慢回归。
          encoding: 'utf8', timeout: cfg.reviewLagTimeoutMs || 5000, stdio: ['ignore', 'pipe', 'pipe'],
          // B（2026-10-16 batch6 加固）：宿主里 process.execPath 是 **Electron 壳**，靠宿主 env 的
          //   ELECTRON_RUN_AS_NODE=1 才当 node 跑（本机实测继承链上确有该变量）。显式钉住＝不赌启动环境：
          //   缺它时这一行会去**拉起整只桌面端**。
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
      noteReviewLag({ code: 0, line: '无滞后' });
    } catch (e) {
      // D1：raw = 真因（见 noteReviewLag 头的取值域），code 仍只表达滞后 / 非滞后两态。
      // F6（batch8）：分类逻辑提到顶层 `rawOfError`（POSIX 信号 ⇒ 'SIG:<name>'；其余同前）
      const raw = rawOfError(e);
      const first = String(e?.stdout ?? '').split('\n').find((l) => l.trim());
      // A（2026-10-16 batch6 修 · 批次 5 复核发现的缺陷 #4）：exit 1 **且 stdout 空** ⇒ 工具自身起不来
      //   （脚本缺失 / 语法错 / 依赖缺失——node 的启动失败同样 exit 1，实测），不是"有滞后"。
      //   真·有滞后时工具**必打印首行** ⇒ 以 stdout 有无作干净判据；起不来记 code:-1：观测线仍留痕
      //   （可事后核"它跑过"），显示面静默。
      const isLag = raw === 1 && !!first;
      noteReviewLag(isLag ? { code: 1, raw, line: first } : { code: -1, raw, line: '' });
    }
  };
  try {
    ctx.on('session/event', (sessOrP, maybeEvent) => {
      // R05（GPT 复核二轮）：宿主实际按 **(session, event)** 发布（dsh-session：callbackArgs=[session,event]）；
      //   兼容旧单参夹具：event 缺省时退化。身份取 session.id；内容取 event（type/data）。
      const sess = maybeEvent !== undefined ? sessOrP : null;
      const p = maybeEvent !== undefined ? maybeEvent : sessOrP;
      retarget(sidOf(sess) ?? sidOf(p));
      const t = String(p?.type ?? p?.name ?? p?.eventType ?? '');
      // R04/R05：回合真值也接 **turn/start**（取消/异常回合不更新 turn-stopping ⇒ C3 当轮标记须靠 start 失效）。
      if (t === 'turn/start') { const tn = Number(p?.data?.turn ?? p?.turn); if (Number.isFinite(tn)) S().obs.turn = Math.max(S().obs.turn, tn); }
      // 2026-10-16 独立审修复：turn/end 也带 data.turn（dsh-session：data={turn,reason}）——补进轮次真值来源；
      //   并在**durable** 的 turn/end 上跑审核面滞后检查（原 agent/turn-end 死监听，见上方注）。
      if (t === 'turn/end') {
        const tn = Number(p?.data?.turn ?? p?.turn);
        if (Number.isFinite(tn)) S().obs.turn = Math.max(S().obs.turn, tn);
        runReviewLag();
      }
      if (t.startsWith('compaction/end') || (t === 'compaction' && p?.phase === 'end')) {
        // N10（GPT 第三轮）：**失败压缩不计成功**——宿主失败路径同样发 end（data.error 非空）⇒ 此前把失败算成
        //   「已压缩 N 次」并触发多余补查。成功才计数与更新脆弱窗；失败另计（观测用，不触发提醒）。
        const failed = !!(p?.data && p.data.error) || !!p?.error;
        if (failed) S().obs.compactionFailed = (S().obs.compactionFailed || 0) + 1;
        else {
          S().obs.compactions++;
          S().obs.lastCompactionTurn = S().obs.turn;      // 脆弱窗判据（压缩补偿行用）
          // 压缩后重投（2026-10-18，拆 Prime Agent 的 digest@compaction-head 落地）：
          //   压缩只保话题、丢约定与库状态；下一回合由 `akasha:post-compact-wake` 条子重投完整起床包。
          S().pendingPostCompactWake = { n: S().obs.compactions, at: Date.now() };
        }
      }
      // 触发词路由（2026-10-11 解冻后新增，外部对照启发：灵枢的「触发词路由」）：
      //   捕获**最近的用户消息文本**，供注入面（system-prompt/assemble 时求值的函数）做触发词匹配——
      //   宿主注入面拿不到当前用户消息，故按灵枢的两步式：**事件里记录、组装时注入**。
      //   ⚠ 只存一行文本 + 时间戳（内存、不出进程、不落盘）；超时即视为过期。
      if (t === 'user/message') {
        const s = textOfUserEvent(p);
        if (s) { S().lastUserText.text = s.slice(0, 4000); S().lastUserText.at = Date.now(); }
      }
    });
  } catch { /* 事件不存在 */ }

  // 库脉搏（v1.3；v1.5 起附加回查行）：写→可见通道——并行会话 / 脚本写入库后，下一回合即可见并命名新内容。
  registerContext({
    name: 'akasha:pulse',
    order: cfg.pulseOrder,
    text: (context) => {
      retarget(renderSidOf(context));
      try {
        const lib = require_(join(cfg.akashaDir, 'lib.mjs'));
        const lines = [core().renderPulseLine(lib.pulse())];
        const recall = core().renderRecallLine(S().recentFailures, Date.now());
        if (recall) lines.push(recall);
        // 审核面滞后（2026-10-16）：改了核心件而独立审核没跟上 ⇒ 每回合带出（不靠人自觉跑 p0）
        // 2026-10-16 审修：读**进程级单例**（原 S().obs 按会话分桶 ⇒ 结果落桶与渲染桶不一致时静默不显示）；
        //   行宽受 clip 约束（原样拼是 117 字双「⚠ 审核面滞后」前缀行，超本模块 80 字纪律）。
        const rl = reviewLagState.value;
        if (rl && rl.code === 1 && rl.line) {
          const n = (/：(\d+)\s*个/.exec(rl.line) || [])[1];
          // O1（2026-10-17 batch15）：附**检查时点**——判定与节流不动，只让"这结论是什么时候的"可见
          //   （旧结果在 60s 节流 / turn-end 驱动的窗口里会与实跑分歧：VERIFY-A4 §5-O1 的 06:35–06:46 即此）。
          //   ⚠ 位置选在**前缀括号内**而不是行尾：行尾会被 80 字 clip 先截掉（长明细 + `…` 时点就没了），
          //   放头部 ⇒ 无论尾巴多长，时点一定看得见；尾巴仍是可截断的"明细"。
          const when = reviewLagState.checkedAt ? ` · 检于 ${stampOf(reviewLagState.checkedAt)}` : '';
          lines.push(clip(`⚠ 审核面滞后（改了没审${when}）：` + (n ? `${n} 件核心件在审核戳后被改` : rl.line.replace(/^⚠\s*审核面滞后：/, ''))));
        }
        return lines.filter(Boolean).join('\n') || null;
      } catch { return null; }
    }
  });

  // 并行会话感知（2026-10-18 v0）：给当前会话一条「其他主会话在做什么」的内部反馈条。
  // 用户口径：只读独立小索引（session.jsonl 的 conclusion 段），不写会话层；只送
  // 「做了什么/完成/下一步」三行；每条带 seq 指针（深查用 session_event_read，不做全局检索）；
  // 60 分钟窗口；按 meta 的 source 目录过滤掉子代理（裸 uuid 目录）；无条目静默。
  registerContext({
    name: 'akasha:parallel',
    order: cfg.parallelOrder ?? 131,
    text: (context) => {
      const eventSid = curSid; // 上一个事件派生的会话 id（在 retarget 覆盖前取，补自排除）
      retarget(renderSidOf(context));
      try {
        const sid = renderSidOf(context);
        const sessionId = context?.session?.id ?? context?.agent?.session?.id;
        const exclude = [sid, sessionId, eventSid].filter(Boolean);
        if (exclude.length === 0) return null;
        const p = require_(join(cfg.akashaDir, 'parallel.mjs'));
        const r = p.collectParallel({
          file: join(cfg.akashaDir, 'data', 'session.jsonl'),
          metaFile: join(cfg.akashaDir, 'data', 'session-meta.json'),
          exclude,
          nowMs: Date.now(),
          windowMinutes: 60,
          limit: 2
        });
        const feed = p.renderParallelFeed(r);
        return feed ? safeInject(feed, { untrusted: true }) : null;
      } catch { return null; }
    }
  });

  // 称呼行（2026-10-10 用户复盘「长会话中期称呼易漂移」）：
  // 规则躺在会话开头那坨注入（akasha:self）里，**执行时看不到** ⇒ 必然漂移。
  // 修法＝接进每回合必然经过的执行点：这条 runtime context 行每回合都出现，内容渲染自
  // canon 的称呼体系当前版本（降级为内置短句），并写明执行点要求（交付/验收/复盘的开口句）。
  registerContext({
    name: 'akasha:address',
    order: cfg.addressOrder,
    text: (context) => {
      retarget(renderSidOf(context));
      try {
        const lib = require_(join(cfg.akashaDir, 'lib.mjs'));
        const recs = lib.currentRecords(lib.loadStore('canon').records);
        const hit = recs.filter((r) => String(r.id).startsWith('canon-address-layers')).pop();
        if (hit && typeof hit.claim === 'string') return safeInject(core().renderAddressLine(hit.claim));   // #14：canon claim 是库原文 ⇒ 必须包裹
      } catch { /* 读库失败 → 兜底短句 */ }
      return safeInject(core().renderAddressLine(''));
    }
  });

  // C3｜断言前把关（stateful-fact gate，2026-10-10；评审 v2 定稿＝触发改到提问侧）
  // 为什么改触发：context 行在回合开始渲染、回复尚未产生；且本插件看不到用户消息事件 ⇒
  //   取**会话层最近一条 intent 段**（跳过注入样式的段）做 6 类关键词判定。
  // 只提醒不阻断；statefulGate:false ⇒ 提示与事件双停。
  // 2026-10-13（举一反三 S4）：取 intent 的读法从「整读 session.jsonl 再 slice(-200)」改为**尾部窗口读**
  //   ——该文件已 21 MB 且每回合都在长，原先每次渲染都整文件进内存（实测 57 ms / 19 MB 读入）。
  //   窗口 = 尾部 256 KB；起点切在行中时丢掉半行；从尾向前逐条找非注入 intent。
  //   与旧口径的关系（如实）：旧口径按 **200 行** 切——记录变长时会漏掉仍在窗口内的 intent；
  //   新口径按**字节**切，不受单行大小影响（更大记录下更稳，属**语义改进**而非纯等价）。
  //   两个纯函数（tailReadText / latestIntentGist）移到模块顶层导出，供自测做等价对照。
  // 去抖状态（同类 30 分钟内只提醒一次；见下方 c3Cat 判定）
  if (cfg.statefulGate !== false) {
    const STATEFUL = [
      { cat: "发布", re: /已发布|未发布|上架|没过审|已过审|待审/ },
      { cat: "安装", re: /已安装|未安装|装好了|装上了/ },
      { cat: "版本", re: /版本|version/i },
      { cat: "开关/运行", re: /开关|启用|禁用|默认开|默认关|开着|关着|在跑|跑着|还在吗|开着吗|装着吗|有没有开/ },
      { cat: "存在", re: /是否存在|有没有|在不在|还在吗/ },
    ];
    registerContext({
      name: "akasha:stateful",
      order: cfg.statefulOrder,
      text: (context) => {
        retarget(renderSidOf(context));
        try {
          const path = join(cfg.akashaDir, "data", "session.jsonl");
          // 2026-10-15 V02 契约（GPT 复核 plugins N2 收尾）：**身份未知 ⇒ 静默**——latestIntentGist 收到
          // '(unknown)'/null/'' 一律 null（不得回退他会话）；显式 undefined（任意会话）只保留给离线诊断。
          // （上一版注释写"必须传 undefined"，那是中间修法，已被哨兵契约推翻——留此以免再读错。）
          let gist = null;
          try { gist = latestIntentGist(tailReadText(path).text, curSid); } catch { /* 文件缺失/半行等 → 走 null */ }
          if (!gist) return null;
          const hit = STATEFUL.find((k) => k.re.test(gist));
          if (!hit) return null;
          const now = Date.now();
          if (S().gateState.c3Cat === hit.cat && now - S().gateState.c3At < 30 * 60 * 1000) return null;  // 同类 30 分钟去重
          S().gateState.c3Cat = hit.cat; S().gateState.c3At = now; S().gateState.c3Turn = S().obs.turn;   // F10：当轮标记（非永久布尔）
          try {
            appendFileSync(join(cfg.akashaDir, "logs", "hooks.jsonl"),
              JSON.stringify({ ts: new Date().toISOString(), kind: "stateful-reminder", cat: hit.cat }) + "\n", "utf8");
          } catch { /* 事件失败不影响提示 */ }
          return "[断言提醒] 状态性事实——先查再答（例：versions + dist-tags 两处核对）";
        } catch { return null; }
      }
    });
  }

  // 门档｜重要工作自动挂（2026-10-15；用户令「逻辑上你得在做第一次代码任务或者审计之类的重要工作的时候就开始 3 次循环+独立审核」）
  // 依据：canon-thinkloop-gate-20261015 + canon-gate-v2-20261015（**先 p0 机检 97s，只有升级项才开慢层**——这正是"不让每步都变长"的落点）。
  // 形态：一行 ≤80 字，只提示不阻断；与 C3 同法（尾窗读 intent + 同类 30 分钟去重 + hooks 留痕）；gateHints:false ⇒ 提示与事件双停。
  if (cfg.gateHints !== false) {   // 默认开；gateHints:false ⇒ 提示与事件双停（与 C1/C3 同规矩）
    registerContext({
      name: 'akasha:gate',
      order: cfg.gateOrder,
      text: (context) => {
        retarget(renderSidOf(context));
        try {
          const path = join(cfg.akashaDir, 'data', 'session.jsonl');
          // 2026-10-15 V02 契约（同 stateful；GPT N2）：未知身份 ⇒ 静默（'(unknown)'/null/'' ⇒ null），
          // 不得读"全库最后一条 intent"（会被他会话触发）。gate-reminder 计数靠"已知会话 + 触发词"正常路径恢复。
          let gist = null;
          try {
            const w = tailReadText(path);
            gist = latestIntentGist(w.text, curSid);
            // 2026-10-15（GPT 第二份复核·优先①·真根因）：**尾窗（256 KiB）截断时"未命中"是静默的** ✗ ——
            // 现场快照里最后 58 条全是 node、最近 intent 在 ~460 KB 之前 ⇒ **即使 ID 完全正确也找不到**（她双重复现）。
            // 契约：**不许静默** —— 窗口不足且未命中时落一条观测线（不是"没有意图"，是看不见）。
            // 2026-10-16 审修：① **去重**——原实现每次渲染都写（实测 10:06:45–10:17:15Z 写 80 行 ≈ 6.6 行/分，
            //   多会话并发时更密），对齐本插件其余钩子（同类 30 分钟去重）的纪律，改 **10 分钟/会话**；
            // ② **字段**——`bytes` 是读入字节数（截断时=窗口值），原记成 fileBytes 无法反映"差多远" ⇒ 记真
            //   大小 `size`，另留 readBytes；③ 未知身份渲染恒 null（V02 契约静默）≠ 窗口问题，不落这条线。
            if (!gist && w.truncated && curSid !== '(unknown)') {
              const nowMs = Date.now();
              if (nowMs - (S().gateState.winMissAt || 0) > 10 * 60 * 1000) {
                S().gateState.winMissAt = nowMs;
                appendFileSync(join(cfg.akashaDir, 'logs', 'hooks.jsonl'), JSON.stringify({
                  ts: new Date().toISOString(), kind: 'gate-window-miss',
                  note: '尾窗截断且未命中 intent（256KiB 窗口不足）——不是"没有意图"，是看不见；需扩大窗口或改为带索引的检索',
                  windowBytes: TAIL_WINDOW_BYTES, fileBytes: w.size ?? w.bytes, readBytes: w.bytes, sid: String(curSid),
                }) + '\n', 'utf8');
              }
            }
          } catch { /* 容缺 */ }
          const hit = gateTriggerOf(gist);
          if (!hit) return null;
          const now = Date.now();
          if (S().gateState.gateCat === hit.cat && now - S().gateState.gateAt < 30 * 60 * 1000) return null;   // 同类 30 分钟去重
          S().gateState.gateCat = hit.cat; S().gateState.gateAt = now; S().gateState.gateTurn = S().obs.turn;
          try {
            appendFileSync(join(cfg.akashaDir, 'logs', 'hooks.jsonl'),
              JSON.stringify({ ts: new Date().toISOString(), kind: 'gate-reminder', cat: hit.cat }) + "\n", "utf8");
          } catch { /* 事件失败不影响提示 */ }
          return `[门档] 本轮属${hit.cat}类：先跑 p0 机检（akasha/tools/gate.mjs p0，97s），有升级项才开慢层`;
        } catch { return null; }
      }
    });
  }

  // C1｜易错点前置（pre-flight hint，2026-10-10 解冻后实现；评审 v2 定稿）
  // 依据：可预防漏召率 91.2%（回合级）、会话级 100% ⇒ 缺的不是知识，是"动作前把库拉进来"。
  // 形态：一行 ≤80 字，只提示不阻断；关（preflightHints:false）则**提示与事件双停**（不写假触发）。
  // 近似说明（如实）：context 行在**回合开始**渲染，此刻还不知道本回合会调用什么工具，
  //   故用"最近失败的工具"作为**预提示**（近 30 分钟窗口 + 同工具去重）；"本回合尚未查库"这一前置
  //   在渲染时无法判定，改为"上一个回合没有查库动作时更倾向提示"的弱化版（v1 取"总是可提示"，由去重与上限约束）。
  if (cfg.preflightHints !== false) {
    registerContext({
      name: 'akasha:preflight',
      order: cfg.preflightOrder,
      text: (context) => {
        retarget(renderSidOf(context));
        try {
          if (S().gateState.c3Turn === S().obs.turn) return null;   // F10：仅同轮让位   // C3 优先（同回合只出一条）
          const lib = require_(join(cfg.akashaDir, 'lib.mjs'));
          const now = Date.now();
          const WINDOW = 30 * 60 * 1000;
          const recent = (S().recentFailures || []).filter((f) => now - Number(f.ts ?? f.at) <= WINDOW);  // 字段是 ts（见 noteFailure）
          const map = lib.RECALL_TRAP_MAP || {};
          // 2026-10-11 修复（用户裁定：反射要能随工程知识纠错与优化）：
          //   **反射文本随条目走** —— 不再只认写死的表。
          //   ① 链感知解析（id 或 id-rN 取链尾）；② 条目缺失/已退役 ⇒ **不打**（fail closed，不执行过期反射）；
          //   ③ 优先用条目自带 `hint`（≤80 字反射文本：**改条目＝改反射**）；④ `hint_until` 过期 ⇒ 跳过；
          //   ⑤ 内置表降级为**过渡兜底**；⑥ 都取不到 ⇒ 不打（宁缺勿滥）。
          // 该表仅作过渡：条目补上 hint 后即成为唯一来源。
          const FALLBACK_ACTIONS = {
            'canon-trap-edit-context-mismatch': '先 read 原文再改、改完复核',
            'canon-trap-read-offset-range': '先用 grep 拿真实行号再读',
            'canon-trap-grep-exit2-path': '换浅范围/排除 node_modules 再 grep',
            'canon-trap-unknown-tool-name': '只从本会话可见工具面选名字',
            'canon-trap-provider-method-list': '先列方法清单再调用',
          };
          let canonRecs = [];
          try { canonRecs = lib.currentRecords(lib.loadStore('canon').records); } catch { /* 读不到 ⇒ 只走兜底 */ }
          const resolveEntry = (cid) => canonRecs.filter((r) => String(r.id) === cid || String(r.id).startsWith(cid + '-r')).pop() || null;
          const isRetired = (rec) => !!rec && (/已退役|retired/i.test(String(rec.claim ?? '')) || String(rec.id).endsWith('-retired'));
          const today = new Date().toISOString().slice(0, 10);
          /** 某工具的首选反射：条目 `hint` 优先 → 兜底表；退役/过期/缺失一律跳过；取不到返回 null（fail closed）。
           *  ⚠ 口径：**库可读时，条目是唯一来源**——该条目没有 hint 也**不**回落兜底（否则"退役/过期"会被兜底表救活，
           *  等于过期反射照打）。兜底表只在**库读不到**时生效。 */
          const hintForTool = (tool) => {
            const ids = map[tool];
            if (!ids || !ids.length) return null;
            for (const cand of ids) {
              if (canonRecs.length) {
                const rec = resolveEntry(cand);
                if (!rec) continue;                                       // 链上已无此条 ⇒ 跳过
                if (isRetired(rec)) continue;                              // 已退役 ⇒ 不执行过期反射
                if (rec.hint_until && String(rec.hint_until) < today) continue;  // 反射有效期已过 ⇒ 跳过
                if (typeof rec.hint === 'string' && rec.hint.trim()) return { id: cand, act: rec.hint.trim(), hintSource: 'entry' };
                continue;                                                  // 有条目但无 hint ⇒ 该候选作罢，不回落
              }
              if (FALLBACK_ACTIONS[cand]) return { id: cand, act: FALLBACK_ACTIONS[cand], hintSource: 'fallback' };
            }
            return null;
          };
          const emitPreflight = (payload) => {
            try {                                                        // 事件：关闭时走不到这里（双停）
              appendFileSync(join(cfg.akashaDir, 'logs', 'hooks.jsonl'),
                JSON.stringify({ ts: new Date().toISOString(), kind: 'preflight', ...payload }) + '\n', 'utf8');
            } catch { /* 事件失败不影响提示 */ }
          };
          const trim80 = (s) => (s.length <= 80 ? s : s.slice(0, 79) + '…');

          // ① 失败驱动（原逻辑）：近 30 分钟内有过失败 ⇒ 给"那件工具"的反射
          if (recent.length) {
            const tool = String(recent[recent.length - 1].tool || '');
            const fresh = !(S().preflight.tool === tool && now - S().preflight.at < WINDOW);  // 同工具 30 分钟去重
            if (fresh && map[tool]) {
              const h = hintForTool(tool);
              if (h) {
                S().preflight.tool = tool; S().preflight.at = now;
                emitPreflight({ tool, entry: h.id, hintSource: h.hintSource, mode: 'failure' });
                return trim80('[坑前提示] ' + tool + ' 前：' + safeInjectInline(h.act) + ' —— 条目 ' + h.id);
              }
            }
          }

          // 条件事实（供条目 `when` 判定；#9 条件谓词化的落地）：只含**可判定**的现场事实。
          const condCtx = {
            turn: S().obs.turn,
            date: today,
            usedTools: [...S().usedTools],
            failedRecently: recent.length > 0,
          };
          // 条目 `when` 闸（可选）：不满足就不打（把"不适用条件"变成可判定的谓词，而不是靠人记）。
          const whenOk = (rec) => {
            if (!rec || rec.when === undefined || rec.when === null) return true;
            try { return lib.evalCondition(rec.when, condCtx); }
            catch (e) { emitPreflight({ entry: String(rec.id), mode: 'when-invalid', error: String(e?.message ?? e).slice(0, 120) }); return false; }  // 非法条件⇒不打（fail closed）
          };

          // ①b 触发词路由（2026-10-11 解冻后新增；外部对照启发＝灵枢的「触发词路由」）：
          //     与①/②都不同——它**不依赖历史失败、也不依赖工具名**，而是按**当前任务文本**命中条目自带的
          //     `triggers` ⇒ 在**动手前**把库拉进来。这正是台账诊断的那句「规则躺在库里、执行点没有接线」的解药。
          //     字段与 hint 同构：`hint`（≤80 字反射）+ `triggers`（触发词数组）；退役 / `hint_until` 过期 / 无 hint 一律不打。
          //     去重：同条目 30 分钟一次（与①同窗）；条数上限：每回合最多一条（本函数只 return 一条）。
          if (cfg.triggerRouting !== false) {
            const txt = (S().lastUserText.text && now - S().lastUserText.at <= USER_TEXT_TTL) ? S().lastUserText.text : '';
            if (txt) {
              const matched = (rec) => {
                const trs = Array.isArray(rec.triggers) ? rec.triggers : [];
                return trs.find((t) => { const s = String(t).trim(); return s && txt.includes(s); }) ?? null;
              };
              const hit = canonRecs.find((r) => {
                if (isRetired(r)) return false;
                if (r.hint_until && String(r.hint_until) < today) return false;
                if (typeof r.hint !== 'string' || !r.hint.trim()) return false;
                if (!whenOk(r)) return false;          // #9：条目 `when` 不满足 ⇒ 不打
                return matched(r) !== null;
              });
              if (hit) {
                const key = String(hit.id);
                if (now - (S().firedTriggers.get(key) ?? 0) >= WINDOW) {
                  const tr = matched(hit);
                  S().firedTriggers.set(key, now);
                  emitPreflight({ entry: key, trigger: tr, hintSource: 'entry', mode: 'trigger' });
                  return trim80('[触发] ' + tr + ' ⇒ ' + safeInjectInline(String(hit.hint).trim()) + ' —— 条目 ' + key);
                }
              }
            }
          }

          // ①c「自动端上来」（2026-10-11；补截图里点名的第二个缺口"只做到提示我去查"）：
          //     与①b 的差别：①b 靠**条目自带触发词**（人写好才命中）；①c 是在**触发词没命中时**退化为
          //     **一次轻量词法召回** —— 按当前任务把最相关的一条**直接端上来**，而不是提示"你去查"。
          //     纪律：上限 1 条 · 阈值 ≥2 分（防误端）· 同一条消息只算一次 · 与①b 互斥 · 可关（autoBringUp）· 失败静默。
          if (cfg.autoBringUp !== false) {
            const txt = (S().lastUserText.text && now - S().lastUserText.at <= USER_TEXT_TTL) ? S().lastUserText.text : '';
            if (txt && S().broughtUp.at !== S().lastUserText.at) {
              try {
                // 分词修正（2026-10-11 实测）：`tokenize` 把中文长句当成**一个 token** ⇒ 每条最多拿 0.9 的中文回退分
                // ⇒ 阈值 2 永远够不到（146 条并列 0.90，等于"要么全端、要么都不端"）。故此处**额外做 bigram 展开**
                // （只对 CJK 连续串）；**不改全局 tokenize**，避免污染既有检索口径。实测后 top 得分 26.9/21.9/20.9，区分度良好。
                const base = lib.tokenize(txt);
                const bi = [];
                for (const t of base) {
                  if (!/\u4e00-\u9fff/.test(t)) continue;
                  const s = t.replace(/[^\u4e00-\u9fff]/g, '');
                  for (let i = 0; i + 1 < s.length; i += 1) bi.push(s.slice(i, i + 2));
                }
                const toks = [...base, ...bi].slice(0, 24);
                let best = null;
                if (toks.length) {
                  for (const r of canonRecs) {
                    if (isRetired(r)) continue;
                    const claim = String(r.claim ?? '').slice(0, 2000);
                    if (!claim) continue;
                    const hay = (String(r.id) + ' ' + claim + ' ' + (Array.isArray(r.tags) ? r.tags.join(' ') : '')).toLowerCase();
                    let score = 0;
                    for (const tk of toks) score += lib.matchScore(hay, tk);
                    if (!best || score > best.score) best = { score, rec: r };
                  }
                }
                // 接受判据（2026-10-11 实测标定）：**归一 ≥1.0 且 绝对分 ≥8** 双条件。
                //   切题样本：归一 1.59/1.68/3.45（分 15.9/26.9/51.8）⇒ 全端；
                //   不切题样本：归一 0.82/0.45/0.29（分 4.9/4.9/2.0）⇒ 全不端 ⇒ 完美分离。
                const norm = best ? best.score / toks.length : 0;
                const accept = !!best && best.score >= 8 && norm >= 1.0;
                S().broughtUp.at = S().lastUserText.at;
                S().broughtUp.id = accept ? String(best.rec.id) : null;
                if (accept && whenOk(best.rec)) {
                  emitPreflight({ entry: String(best.rec.id), score: best.score, norm: Number(norm.toFixed(2)), mode: 'bring-up' });
                  return trim80('[端上来] ' + safeInjectInline(String(best.rec.claim).slice(0, 44)) + ' —— ' + String(best.rec.id).slice(0, 26));
                }
              } catch { /* 静默：端不上来不影响回合 */ }
            }
          }

          // ② 首用预告（2026-10-11 新增；补"漏召"的结构缺口）：
          //    渲染时**不知道本回合会用什么工具**，但知道**本会话还没用过哪些** ⇒ 逐个把"未用过的陷阱工具"预告一遍，
          //    每个工具只预告一次（用过即止）= 把"事后回查"提前成"动手前预检"，不依赖历史失败。
          if (cfg.preflightFirstUse !== false) {
            const nextTool = Object.keys(map).find((t) => !S().usedTools.has(t) && !S().announcedTraps.has(t));
            if (nextTool) {
              const h = hintForTool(nextTool);
              if (h) {
                S().announcedTraps.add(nextTool);
                emitPreflight({ tool: nextTool, entry: h.id, hintSource: h.hintSource, mode: 'first-use' });
                return trim80('[坑前提示·首用] ' + nextTool + ' 还没用过：' + safeInjectInline(h.act) + ' —— 条目 ' + h.id);
              }
            }
          }
          return null;
        } catch { return null; }
      }
    });
  }

  // 极限观测行（2026-10-11，用户令）：轮次维度的机械钩子——把「该查库了」变成可见信号，不靠记性。
  //   只在知道轮次时渲染（拿不到真值就保持静默，不伪造）。硬约束同 C1：**一行、≤80 字**。
  if (cfg.extremeObs !== false) {
    registerContext({
      name: 'akasha:extreme',
      order: (cfg.pulseOrder ?? 132) + 2,
      text: (context) => {
        retarget(renderSidOf(context));
        try {
          if (!S().obs.turn) return null;
          const gap = S().obs.lastRecallTurn === null ? '(本进程尚未查库)' : '距今 ' + Math.max(0, S().obs.turn - S().obs.lastRecallTurn) + ' 轮';
          // 口径标注（2026-10-11）：轮次/压缩/查库均为**本进程**统计——重启即归零；不标会被读成"整场会话"
          const line = '[极限观测·本进程] 轮=' + S().obs.turn + ' 压缩=' + S().obs.compactions + ' 上次查库=' + gap;
          return line.length <= 80 ? line : line.slice(0, 79) + '…';
        } catch { return null; }
      }
    });
  }

  // 压缩补偿行（2026-10-11 用户方向："针对压缩轮次增加，逐步强行增加使用库查记忆进行补全"）。
  //   依据（当晚实测）：① 压缩摘要只保话题、**丢约定**——四条核心约定存活率 0–21%，而**每回合注入的称呼层 100% 存活**；
  //   ② 「丢记忆」实例（turn 220）落在**压缩后 15 轮内**（压缩在 205）。
  //   ⇒ 分级补偿：**脆弱窗**（距上次压缩 ≤15 轮）要求"重要结论先落库"；**压缩 ≥3** 且本回合尚未查库 ⇒ 要求先查；
  //   **压缩 ≥5** ⇒ 升级为强制；**查过即不再催**（闭环，避免噪音）。
  const RECALL_WINDOW = 15;
  if (cfg.compensate !== false) {
    registerContext({
      name: 'akasha:compensate',
      order: (cfg.pulseOrder ?? 132) + 3,
      text: (context) => {
        retarget(renderSidOf(context));
        try {
          if (!S().obs.turn || !S().obs.compactions) return null;                  // 没压缩过 ⇒ 不打扰
          const sinceComp = S().obs.lastCompactionTurn === null ? null : Math.max(0, S().obs.turn - S().obs.lastCompactionTurn);
          const recalledRecently = S().obs.lastRecallTurn !== null && (S().obs.turn - S().obs.lastRecallTurn) <= 2;
          const inWindow = sinceComp !== null && sinceComp <= RECALL_WINDOW;
          if (S().obs.compactions >= 5 && !recalledRecently) {
            return clip('[压缩补偿·强制] 本会话已压缩 ' + S().obs.compactions + ' 次：关键动作前先 akasha_lookup/brief 补全，再动手');
          }
          if (S().obs.compactions >= 3 && !recalledRecently) {
            return clip('[压缩补偿] 已压缩 ' + S().obs.compactions + ' 次' + (inWindow ? '（脆弱窗 距上次 ' + sinceComp + ' 轮）' : '') + '：本回合先查库再答');
          }
          if (inWindow) {
            return clip('[压缩补偿·脆弱窗] 距上次压缩 ' + sinceComp + ' 轮：重要结论先落库，动手前先查');
          }
          return null;
        } catch { return null; }
      }
    });
  }

  // 压缩后重投（2026-10-18；来源：拆 Prime Agent 的 Continual Harness —— 他们的 harness digest 在
  //   session start / resume / **compaction head** 三处都投；我们原先只在新会话投，压缩后就只剩补偿提示行）。
  //   设计：一次性条子——压缩成功时置 `pendingPostCompactWake`，下一回合渲染完整起床包并清除标记。
  //   行宽：唤醒条每行 ≤80（同其他条子；多行本身允许，见 akasha:parallel）。
  //   成本：kit() 只在压缩后调一次（读六库），不是每回合。
  if (cfg.postCompactWake !== false) {
    registerContext({
      name: 'akasha:post-compact-wake',
      order: (cfg.pulseOrder ?? 132) + 4,
      text: (context) => {
        retarget(renderSidOf(context));
        try {
          const pw = S().pendingPostCompactWake;
          if (!pw) return null;
          S().pendingPostCompactWake = null;                     // 一次性：先清，无论成败都不重投
          const k = require_(join(cfg.akashaDir, 'lib.mjs')).kit();
          if (!isWakeNoteworthy(k)) return null;
          const lines = buildWakeNote(k, recentConclusions(cfg.akashaDir, curSid)).split('\n')
            .map((l) => (l.length <= 80 ? l : l.slice(0, 79) + '…'));
          return '[压缩后重投] 会话已压缩 ' + pw.n + ' 次（上下文边界），库状态重投：\n' + lines.join('\n');
        } catch { return null; }
      }
    });
  }

  // 核心约定常驻行（2026-10-11 用户裁定）：**防目标漂移**——压缩丢的是"我们怎么做事"（实测五条约定存活 0–21%），
  //   而每回合注入的称呼层 100% 存活 ⇒ 把核心约定也做成**常驻**。**库驱动**：渲染时读 canon 的
  //   `canon-core-conventions` 当前版本的 `line` 字段 ⇒ **改约定＝改条目**（不碰代码）；读不到 ⇒ 内置兜底（永不为空）。
  //   行宽**破例放宽到 160 字**（其余行均为 80）：它是漂移锚，值得多占一行。
  if (cfg.conventions !== false) {
    const CONV_ID = 'canon-core-conventions';
    const FALLBACK_CONVENTIONS = '库无界·装载有界｜来源态四标签｜修订链：追加不改原文｜零编造（红线）｜称呼：Master/大肥鱼';
    const clipLong = (s) => (s.length <= 160 ? s : s.slice(0, 159) + '…');
    registerContext({
      name: 'akasha:conventions',
      order: (cfg.pulseOrder ?? 132) + 4,
      text: (context) => {
        retarget(renderSidOf(context));
        try {
          const lib = require_(join(cfg.akashaDir, 'lib.mjs'));
          const recs = lib.currentRecords(lib.loadStore('canon').records);
          const rec = recs.filter((r) => String(r.id) === CONV_ID || String(r.id).startsWith(CONV_ID + '-r')).pop();
          const text = (rec && typeof rec.line === 'string' && rec.line.trim()) ? rec.line.trim() : FALLBACK_CONVENTIONS;
          return safeInject(clipLong('[约定] ' + text));   // F06（2026-10-14 外部审查）：库原文可能含合法模板示例（如 {{unknown}}）——出口整体包裹，防宿主插值抛错
        } catch { return safeInject(clipLong('[约定] ' + FALLBACK_CONVENTIONS)); }
      }
    });
  }

  // ① 语义钩子 + 显式钩子（2026-10-11 用户令「开搞」；补设计稿 §2.4 五类钩子中缺的两类）
  //   · **显式钩子**（"上次那个"）：读**本会话最近 intent 段**（会话层＝用户消息的摘要）⇒ 检测指代词 ⇒ 检索六库 ⇒ **一行**指路。
  //     ⚠ 已知限制（如实）：数据源是**摘要**而非原话，摘要可能丢掉指代词 ⇒ **宁可漏触发不误触发**；
  //       若要原话级，需让 hooks 侧记录 user-message 行（待办）。
  //   · **语义钩子**（"当前处境作为查询"）：本会话近 30 分钟内有工具失败 ⇒ 用工具名检索六库 ⇒ **一行**指路。
  //   两钩子**每回合最多出一行**，优先级 显式 > 语义；都无触发 ⇒ **静默**（不制造噪音）；可关 `recallHook:false`。
  if (cfg.recallHook !== false) {
    const PRONOUN = /(上次|之前|上回|那天|那个|说过|记得|当时|前面说|前面提)/;
    // N08（GPT 第三轮）：按当前身份过滤；unknown 不读共享最后一条。
    // 与 C3 共用完整 ID 精确读取；当前会话无记录时静默，不猜旧数据的别名。
    const recentIntentGist = () => {
      try {
        const sid = curSid;
        if (!sid || sid === '(unknown)') return '';
        const txt = tailReadText(join(cfg.akashaDir, 'data', 'session.jsonl')).text;
        return String(latestIntentGist(txt, sid) || '');
      } catch { return ''; }
    };
    const clip120 = (s) => (s.length <= 120 ? s : s.slice(0, 119) + '…');
    registerContext({
      name: 'akasha:recall',
      order: (cfg.pulseOrder ?? 132) + 5,
      text: (context) => {
        retarget(renderSidOf(context));
        try {
          const lib = require_(join(cfg.akashaDir, 'lib.mjs'));
          // 显式钩子（指代）
          const gist = recentIntentGist();
          if (gist && PRONOUN.test(gist)) {
            // 去掉**所有**指代词（2026-10-11 修：replace 无 g 标志时只替一次，残留「那个」会污染查询）
            const q = gist.replace(new RegExp(PRONOUN.source, 'g'), ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || gist.slice(0, 60);
            const r = lib.lookupDetailed(q, { limit: 2, contextBudget: false, via: 'probe' }); // via:'probe'（2026-10-14 复检）——机制探针，不进检索面指标
            const ids = (r.hits || []).map((h) => String(h.id)).slice(0, 2).join(' · ');
            if (ids) return safeInject(clip120('[指代检索] 像是问旧事 → 先看：' + ids));   // F06：库侧内容出口必须包裹（防模板插值）
          }
          // 语义钩子（近失败）
          const f = S().recentFailures[S().recentFailures.length - 1];
          if (f && S().obs.turn && Date.now() - f.ts < 30 * 60 * 1000) {
            const r = lib.lookupDetailed(String(f.tool || ''), { limit: 2, contextBudget: false, via: 'probe' }); // 同上：机制探针（近失败回查），不进检索面指标
            const top = (r.hits || [])[0];
            if (top) return safeInject(clip120('[处境检索] ' + f.tool + ' 近 30 分钟内失败过 → 相关条目 ' + top.id + '：' + String(top.snippet || '').slice(0, 42)));   // F06 同上
          }
          return null;
        } catch { return null; }
      }
    });
  }

  // 空闲触发（事件失败开放）。
  ctx.on('agent/status', (payload) => {
    try { if (payload?.status === 'idle') maybeSleep('idle'); } catch { /* 静默 */ }
  });

  // 定时兜底：宿主长期不空闲也能按节奏睡。
  // ⚠️ timer 是「混入服务」：访问 ctx.interval 需要 inject:['timer']，否则属性访问本身抛出
  //    "cannot get property \"timer\" without inject"——v1.1.0 事故：整个 apply 失败、插件静默失活。
  //    ctx.interval 返回的停止函数再挂到本插件自己的 effect 上，卸载即停。
  if (typeof ctx.interval === 'function') {
    try {
      const stop = ctx.interval(() => { try { maybeSleep('timer'); } catch { /* 静默 */ } }, cfg.timerCheckMs);
      ctx.effect(() => () => { try { stop(); } catch { /* 静默 */ } });
    } catch { /* 静默 */ }
  }

  // 首次激活即跑一次，此后按去抖节奏。
  const boot = readState();
  if (!boot.lastRunAt) runSleep('activate');

  // C（2026-10-16 batch6）：**装载即查一次**——结果从**第一回合**起可见（原先首个 turn/end 之前渲染
  //   ⇒ 重启后要等第二回合才显示）。代价：宿主启动多一次 ~0.1 s 同步子进程。
  //   ⚠ 位置纪律：**放在激活睡眠之后**——本检查自己要往 hooks.jsonl 落一行观测线（kind:'review-lag'），
  //   若排在激活睡眠之前，那一行会被算进启动那次的「已处理行数」水位线（selftest 实测 4≠3）——
  //   那是自产的记账噪声，不是库的进展。
  try { runReviewLag(); } catch { /* 静默：装载期任何异常都不得影响插件加载 */ }

  log({ kind: 'sleep-armed', pid: process.pid, minIntervalHours: cfg.minIntervalHours, timerCheckMs: cfg.timerCheckMs });
  if (llmSkipNote) log({ kind: 'wake-note-llm-skip', message: llmSkipNote });
}
