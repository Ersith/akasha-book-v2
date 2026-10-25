// 阿卡夏之书钩子 v1.2 —— 只记录、不干预。
// 监听五类 emit 事件（全部为 contained 语义，失败不会打断宿主）：
//   session/event（turn/end）· tools/result（全部结果，含工具名与失败原因）
//   agent/error（step / turn 出错）· agent/status（running→idle，去抖）
//   agent/assistant-stream（v1.1：输出审计的数据源——累积文本 → 核心库 auditText → output-audit / usage 线）
// 记录到 append-only JSONL；设计见 research\ai-memory-architecture-20261006.md（§7 后台层雏形）。
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// 默认值：`AKASHA_DIR` 环境变量 → 家目录下的 .akasha（可用 config.akashaDir / log 覆盖）。
// ⚠ 2026-10 wave1：不得写成字面量 '~/...'——Node 不展开 `~`（会在 cwd 下建出名为 `~` 的目录）。
// 2026-10-10（对外安装体验）：AKASHA_DIR 一处配置贯通 log 默认值；缺它时脱敏/审计会静默降级。
// F13（2026-10-14 外部审查 · GPT）：`expandHome` 的 const 定义必须**先于**使用——此前它排在 ENV_AKASHA 之后，
//   一旦外部按契约设了非空 AKASHA_DIR，模块导入即 ReferenceError（TDZ）⇒ hooks 整个装不上（本机 patch 传配置路径，故未暴露）。
const expandHome = (p) => (p === '~' ? homedir() : (p.startsWith('~/') || p.startsWith('~\\')) ? join(homedir(), p.slice(2)) : p);
const ENV_AKASHA = typeof process.env.AKASHA_DIR === 'string' && process.env.AKASHA_DIR.trim() !== '' ? expandHome(process.env.AKASHA_DIR) : null;
const DEFAULT_AKASHA = ENV_AKASHA ?? join(homedir(), '.akasha');
const DEFAULT_LOG = join(DEFAULT_AKASHA, 'logs', 'hooks.jsonl');

// ── 占位符守卫（2026-10-19 发布面 P0）──────────────────────────────
// OSS 的 `cordis.patch.yml` 用 `<AKASHA_DIR>` / `<LOCAL_PATH>` 作示例字面量；照抄不改时字面量
// **优先于** AKASHA_DIR 默认值 ⇒ 日志/脱敏静默写到不存在的目录。这里明确抛错（fail closed）。
const PLACEHOLDER_TOKEN = /<[A-Za-z][A-Za-z0-9_]{2,}>/;   // 大小写都认（2026-10-19 审计 B：小写/混合形态此前漏检）
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
  // 2026-10-19（审计 B）：环境变量路线此前完全没设防——AKASHA_DIR='<AKASHA_DIR>' 时插件事先不知道。
  const envVal = process.env.AKASHA_DIR;
  if (typeof envVal === 'string' && envVal.trim() !== '') {
    const m = envVal.match(PLACEHOLDER_TOKEN);
    if (m) hits.push({ field: 'AKASHA_DIR(环境变量)', token: m[0] });
  }
  if (!hits.length) return;
  const fields = [...new Set(hits.map((h) => h.field))].join('、');
  throw new Error(
    `akasha-hooks: 配置里还有未替换的占位符 ${hits[0].token}（${fields}）。` +
    '请先把 cordis.patch.yml 里的 <AKASHA_DIR> / <LOCAL_PATH> 改成你的实际路径；' +
    '或删掉这些字段，改用 AKASHA_DIR 环境变量。' +
    '（宁可启动失败，也不静默降级——照抄占位符会让日志/脱敏指向不存在的库。）'
  );
}

// B2（wave1）：shell 里经 akasha CLI 的只读查库也算「召回」——只记子命令名（命令原文不进日志）。
// 2026-10-10 人读复查补 `dsh_wsl`：工具目录长了，这个集合没跟上 ⇒ WSL 里的查库不会被计入召回。
// 2026-10-13 举一反三（审计 P1 同族）：再补两处同类缺口——
//   ① `ops_bash`：dsh-ops 落地后它是最常用的 shell 入口，gate 的 SHELL_TOOLS 早就补了它，**这里漏了**（两处不同步）；
//   ② 子命令表扩到「全部只读面」：`check`（自查）、`stats`、`audit`、`metrics`、`frontier list`、`session <…>`、
//      `sleep --plan`（只读计划）、`evidence`。此前只认 9 条 ⇒ 查询走别的只读子命令时召回**静默不计数**，
//      直接稀释 recall-miss 指标的分母（那是「失败回查」的输入）。
//   ③ 反向：写子命令（revise/add/retire/promote/orphan add/price --apply…）**不在**表内，命中不算召回。
//   注：判定只看命令文本（含注释/heredoc 里的字面量），属**启发式观测**，不承诺防误报——量级小、且只喂软指标。
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'sh', 'shell', 'dsh_wsl', 'ops_bash']);
const CLI_RECALL = /akasha\.mjs["']?\s+(lookup|brief|cross|kit|show|summary|check|stats|audit|metrics|frontier\s+(?:due|list)|mirror\s+match|session\s+(?:lookup|context|tree|node|loopwatch|stats)|sleep\s+--plan|evidence)\b/i;
/** 工具调用若是 akasha CLI 查库子命令 → 归一名（'lookup' / 'mirror-match' / 'session-lookup' …）；否则 null。 */
export function akashaCliOf(name, args) {
  try {
    if (!SHELL_TOOLS.has(String(name ?? ''))) return null;
    const m = CLI_RECALL.exec(String(args?.command ?? args?.script ?? ''));
    return m ? m[1].toLowerCase().replace(/\s+/g, '-') : null;
  } catch { return null; }
}

/** 调用体量代理（2026-10-15；来源＝B 臂发现「hooks 的 tool 行只有 {ts,session,tool,ok}，无 token/字符数 ⇒
 *  『token/发现』根本算不出来，只能拿字节代理」）。最小改法：给 tool 行加 `chars`（＝入参 + 返回体）。
 *  安全：字符串取 length；其余 JSON.stringify；**循环引用 / 不可序列化一律降级 0**（绝不因记账把事件打挂）。 */
export function sizeOf(v) {
  try { return typeof v === 'string' ? v.length : JSON.stringify(v ?? '').length; } catch { return 0; }
}
/** 体量三元组：chars 总 / charsIn 入参 / charsOut 返回体。纯函数，供自测做等价对照。 */
export function charsOf(exec, result) {
  const charsIn = sizeOf(exec?.arguments);
  const charsOut = sizeOf(result?.content ?? result?.error ?? result ?? '');
  return { chars: charsIn + charsOut, charsIn, charsOut };
}

export function apply(ctx, config = {}) {

  // A/B 实验开关（2026-10-10 用户解冻，见 docs/ab-experiment-design.md §6）：
  // abOff=true ⇒ **关闭臂**——本插件不注册任何守卫/注入/工具，只记一行观测；库文件与日志照旧（便于事后复盘）。
  if (config.abOff === true) {
    try { (ctx.logger?.info ?? (() => {}))('hooks: abOff=true（A/B 关闭臂）——本插件不注册任何面'); } catch { /* 静默 */ }
    return;
  }
  assertNoPlaceholders(config);
  const logPath = typeof config.log === 'string' && config.log.trim() !== '' ? expandHome(config.log) : DEFAULT_LOG;
  const akashaDir = typeof config.akashaDir === 'string' && config.akashaDir.trim() !== '' ? expandHome(config.akashaDir) : DEFAULT_AKASHA;
  const idleDebounceMs = Number.isInteger(config.idleDebounceMs) && config.idleDebounceMs > 0 ? config.idleDebounceMs : 600000;
  const logToolResults = config.logToolResults !== false;
  const auditOutput = config.auditOutput !== false;

  const require_ = createRequire(import.meta.url);
  const core = () => require_(join(akashaDir, 'lib.mjs'));

  let ready = false;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    ready = true;
  } catch {
    // 目录建不出来就静默停用；宿主不受影响
  }

  const write = (record) => {
    if (!ready) return;
    try {
      appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', 'utf8');
    } catch {
      // 审计层自身失败不拖垮宿主：吞掉，下一行再试
    }
  };

  const counters = { tools: 0, toolErrors: 0, turnEnds: 0, agentErrors: 0, audits: 0, usageRefs: 0 };
  let lastIdleLog = 0;

  write({ kind: 'activated', pid: process.pid, log: logPath });

  // 回合结束（durable：session 日志的 turn/end）。
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'turn/end') return;
      counters.turnEnds += 1;
      write({
        kind: 'turn-end',
        session: String(session?.id ?? ''),
        turn: event.data?.turn ?? null,
        reason: event.data?.reason?.kind ?? null
      });
    } catch { /* 见文件头注释 */ }
  });

  // 工具结果：成功只记名字（供结果计数器），失败附原因。
  ctx.on('tools/result', (exec, result) => {
    try {
      counters.tools += 1;
      const isError = result?.isError === true;
      if (isError) counters.toolErrors += 1;
      if (!logToolResults && !isError) return;
      let message;
      if (isError) {
        message = String(result?.error?.message ?? '').slice(0, 400);
        try { message = core().redact(message); } catch { /* 核心库缺失时仍截断 */ }
      }
      const akashaCli = akashaCliOf(exec?.name, exec?.arguments);
      // wave1.1：会话 id ＝ exec.agent.id（DSH ToolExecution.agent 由 agent loop 设置；Agent.id 的类型就是 SessionId，
      // 与 session/event 的 session.id、agent/error 的 payload.agent.id 同一值）。非 agent loop 发起的调用没有 agent → 不写该字段。
      const sid = typeof exec?.agent?.id === 'string' && exec.agent.id ? exec.agent.id : null;
      write({
        kind: 'tool',
        ...(sid ? { session: sid } : {}),
        tool: exec?.name ?? null,
        ok: !isError,
        message,
        ...charsOf(exec, result),          // 2026-10-15：chars / charsIn / charsOut（体量代理，补 token 口径的仪表缺口）
        ...(akashaCli ? { akashaCli } : {})
      });
    } catch { /* 见文件头注释 */ }
  });

  // agent 级错误（step / turn 出错）。
  ctx.on('agent/error', (payload) => {
    try {
      counters.agentErrors += 1;
      let message = payload?.error instanceof Error ? payload.error.message : String(payload?.error ?? '');
      message = message.slice(0, 400);
      try { message = core().redact(message); } catch { /* 截断已做 */ }
      write({
        kind: 'agent-error',
        session: String(payload?.agent?.id ?? ''),
        turn: payload?.turn ?? null,
        step: payload?.step ?? null,
        message
      });
    } catch { /* 见文件头注释 */ }
  });

  // 输出审计（v1.1；v1.2 修复累积）：按 attemptId 累积 assistant 文本流，committed 结束时跑核心库 auditText——
  //   引用不存在的库 id → output-audit 线（编造引用嫌疑）；真实 id → usage 线（条目级使用计数 v0）。
  //   ⚠ 2026-10-07 复查：宿主 revision **逐帧递增**（nextRevision() 每 emit 一次）——不得按 revision 重置累积，
  //   否则每 chunk 清空、审计恒空（output-audit/usage 0 条实证）；跨帧切分的 id 必须能还原。
  const streams = new Map();
  ctx.on('agent/assistant-stream', (payload) => {
    try {
      if (!auditOutput) return;
      const frame = payload?.frame;
      if (!frame) return;
      const key = String(frame.attemptId ?? '');
      if (frame.type === 'start') {
        streams.set(key, { text: '' });
        if (streams.size > 30) { const k0 = streams.keys().next().value; streams.delete(k0); }
        return;
      }
      if (frame.type === 'chunk') {
        let st = streams.get(key);
        if (!st) { st = { text: '' }; streams.set(key, st); }
        const c = frame.chunk;
        if (c && c.type === 'text-delta' && typeof c.text === 'string') {
          st.text += c.text;
          if (st.text.length > 400000) st.text = st.text.slice(-400000); // 保尾：长输出的尾部对审计更有信息量
        }
        return;
      }
      if (frame.type === 'end') {
        const st = streams.get(key);
        streams.delete(key);
        const committed = frame.outcome && frame.outcome.kind === 'committed';
        if (!committed || !st || !st.text) return;
        let audit = null;
        try { audit = core().auditText(st.text); } catch { return; }
        const session = String(payload?.agent?.id ?? '');
        const eventType = frame.outcome?.eventType ?? null;
        if (audit.unknownIds.length) {
          counters.audits += 1;
          write({ kind: 'output-audit', session, eventType, unknown: audit.unknownIds.slice(0, 8), tagged: audit.tagged, chars: st.text.length });
        }
        if (audit.ids.length) {
          counters.usageRefs += audit.ids.length;
          write({ kind: 'usage', session, eventType, ids: audit.ids.slice(0, 20) });
        }
      }
    } catch { /* 见文件头注释 */ }
  });

  // 空闲脉冲（running → idle，去抖；附计数器快照）。
  ctx.on('agent/status', (payload) => {
    try {
      if (payload?.status !== 'idle') return;
      const now = Date.now();
      if (now - lastIdleLog < idleDebounceMs) return;
      lastIdleLog = now;
      write({ kind: 'idle', session: String(payload?.agent?.id ?? ''), counters: { ...counters } });
    } catch { /* 见文件头注释 */ }
  });
}
