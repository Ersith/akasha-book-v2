// akasha/sleep.mjs —— 睡眠器蒸馏核心（2026-10-07 v2：逻辑归库、调度归插件）。
// 迁移自 @akasha-book/sleep 插件（**当时**版本 v1.3.1，2026-10-07 观测）的 lib/index.js（distillHooks / buildTodos / renderContextLine / renderPulseLine 逐字一致）；
//   ⚠ 「v1.3.1」与「逐字一致」都只是**当时的迁移快照**，不是当前事实——插件此后已走到 1.7.x-h 线（版本真值看插件包 package.json）。
//   要复核两边共享函数是否仍等价：`diff` 本文件与 `dsh-akasha-sleep/lib/index.js` 的对应段（2026-10-13 审计 P4：把版本号从「断言」降级为「带日期的观测」）。
// 新增：sleepRun（含 --dry / 同日报告不覆盖 / report/state/inbox 写失败观测线）+ shouldSleep（去抖判断）。
// 手动触发：node akasha.mjs sleep [--dry] —— 与插件自动触发共用同一水位线 sleep-state.json（不重复蒸馏、不丢增量）。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, LOGS_DIR, STORES, appendReviewLog, audit, credibilityMap, credibilityTodos, currentRecords, isProtocolId, isRecallRecord, isSelfLayerRecord, isToolUsageNoise, loadStore, parseJsonl, recallSignals, recordCitedIds, redact, redactDeep, retireRecord, revise, revokeRetire, storePath, tokenize, writeFileAtomic, todayLocal } from './lib.mjs';

export const SLEEP_DEFAULTS = {
  log: join(LOGS_DIR, 'hooks.jsonl'),
  stateFile: join(LOGS_DIR, 'sleep-state.json'),
  inboxFile: join(LOGS_DIR, 'inbox.jsonl'),
  reportDir: LOGS_DIR,
  minIntervalHours: 6
};

/** 把 hooks.jsonl 的一批记录蒸馏为计数与备注（纯函数，可测）。 */
export function distillHooks(lines) {
  const counters = { lines: 0, turns: 0, tools: 0, toolErrors: 0, denials: 0, agentErrors: 0, byTool: {} };
  const notes = [];
  // 2026-10-11：三类候选**统一带样本**（此前只有 tool-error 带；gate-denied / agent-error 只有固定文案
  // ⇒ 转正成孤案后内容薄、无钩子可言）。样本按 code 分组，各留 3 条；`notes` 保持原样（兼容既有报告口径）。
  // 2026-10-11 深夜：新增 `probeNotes`——**探测类失败另列**（见下方 noisy 判定），不占 notes 的 5 条额度。
  const probeNotes = [];
  const samples = { 'tool-error': [], 'gate-denied': [], 'agent-error': [] };
  const parsed = [];
  for (const raw of lines) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    let rec;
    try { rec = JSON.parse(text); } catch { counters.badJson = (counters.badJson ?? 0) + 1; continue; }
    counters.lines++;
    parsed.push(rec);
    if (rec.kind === 'turn-end') counters.turns++;
    else if (rec.kind === 'tool') {
      counters.tools++;
      const tool = String(rec.tool ?? '?');
      counters.byTool[tool] = (counters.byTool[tool] ?? 0) + 1;
      if (rec.ok === false) {
        counters.toolErrors++;
        const full = redact(`工具失败 ${tool}: ${String(rec.message ?? '')}`);
        const s = full.slice(0, 120);
        // 先用完整诊断分类，再截短展示：长路径的 usage 噪声不能被 120 字截断“洗白”。
        const usageNoise = isToolUsageNoise([full]);
        // 失败分层（2026-10-11 深夜修）：**探测类**（`list_mcp_resources` 等探测工具，或服务未开 / 内容类型不支持
        // 这类"环境噪声"）与**实质失败**分开计。理由：8・11 实测里 8 次失败有 3 次是探测噪声（unity/rea 未连、
        // unsupported content type），混在一起会让"工具错误数"看着比实际严重，也稀释了真正该人看的失败。
        // 兼容：`toolErrors` 保持原义（总数），新增 `toolErrorsProbe` / `toolErrorsSubstantive` 两个细分字段。
        const noisy = tool === 'list_mcp_resources'
          || /server is disconnected|unsupported content type|ECONNREFUSED|fetch failed|timed out/i.test(String(rec.message ?? ''));
        if (noisy) {
          counters.toolErrorsProbe = (counters.toolErrorsProbe ?? 0) + 1;
          if (probeNotes.length < 3) probeNotes.push(s);
        } else {
          counters.toolErrorsSubstantive = (counters.toolErrorsSubstantive ?? 0) + 1;
          if (notes.length < 5) notes.push(s);          // ← notes 只收实质失败（探测类另列，不占额度）
          // 2026-10-22 P2-1：在占用 3 个样本名额前先滤掉 usage 噪声；16 条前缀也不会把第 17 条真实错误挤掉。
          if (!usageNoise && samples['tool-error'].length < 3) samples['tool-error'].push(full.slice(0, 500));
        }
      }
    } else if (rec.kind === 'gate-denied') {
      counters.denials++;
      if (samples['gate-denied'].length < 3) samples['gate-denied'].push(redact(`门控拦截 ${String(rec.tool ?? '?')}: ${String(rec.message ?? rec.rule ?? '').slice(0, 120)}`));
    } else if (rec.kind === 'agent-error') {
      counters.agentErrors++;
      if (samples['agent-error'].length < 3) samples['agent-error'].push(redact(`agent 错误: ${String(rec.message ?? rec.error ?? '').slice(0, 120)}`));
    }
  }
  // B2（wave1）：召回失败信号——失败回合里「失败前没查库」的计数（口径见 lib.recallSignals）。
  const rs = recallSignals(parsed);
  counters.failureTurns = rs.failureTurns;
  counters.recalledBefore = rs.recalledBefore;
  counters.recallMisses = rs.misses;
  counters.lateRecall = rs.lateRecall;
  return { counters, notes, probeNotes, samples, recall: rs };
}

/**
 * 候选样本是否**可用**（2026-10-13，A2 分道）：判据＝样本里带具体证据（路径 / 工具名 / 错误码 / 具体错误文本）。
 * 为什么必需：`sampleOf` 原先在缺样本时**填入通用兜底文案**，于是「sample 非空」不等于「有证据」——
 *   聚合型候选（如「gate-denied ×5」）就这样一路转正成孤儿条目，再被人手动退役（2026-10-13 实测返工 5 条：
 *   inbox 18 批 / 30 条候选里 **15 条 count-only**，占 50%）。
 * 判据收窄到可命名的证据形态；通用文案（如「被门控拦截的写入尝试」）显式排除。
 */
export const GENERIC_SAMPLE_RE = /^(被门控拦截|agent 级错误|工具失败$|失败回查候选)/;
export function hasConcreteSample(samples) {
  const arr = Array.isArray(samples) ? samples : [samples];
  return arr.some((s) => {
    const t = String(s ?? '').trim();
    if (!t) return false;
    if (GENERIC_SAMPLE_RE.test(t)) return false;
    // 2026-10-22：工具用法噪声不算“具体证据”——unknown tool / old_string / 未读先改这类
    // 是我调用姿势的失误，不是环境或记忆层给的事实；放进 orphan 会把操作噪声变成假记忆。
    if (/^工具失败/.test(t) && isToolUsageNoise([t])) return false;
    return /[A-Za-z]:[\\/]|[\\/][\w.-]+\.(mjs|js|md|json|jsonl|log|txt|ps1|cmd)\b|\bunknown tool\b|\bexit\s*\d|\btimeout\b|\bold_string\b|\boffset\s*\d|\bbinary file\b|\bENOENT\b|\bEPERM\b/i.test(t);
  });
}

/**
 * 生成待办（纯函数）：audit 警告 → review；工具失败 / 门控拦截 / agent 错误 → orphan-candidate；
 * 召回漏（失败前未查库的回合，wave1.1）→ review `recall-miss`（复盘项，不自动转孤案——「本该查到什么」是语义判断）。
 * 2026-10-13（A2）：候选**分道**——有具体样本 ⇒ `orphan-candidate`（可转正）；无 ⇒ `aggregate`（**展示用，不转正**）。
 */
export function buildTodos(counters, notes, audit, recall, samples) {
  const todo = [];
  /** 取可用样本：只回**真实样本**，不再用通用文案兜底（否则「有样本」判定失真）。 */
  const usableOf = (code) => {
    const s = (samples && Array.isArray(samples[code])) ? samples[code] : [];
    // 2026-10-22 P2-1：先过滤再截断（旧写法 slice 后 filter，前三条噪声会把第四条真实错误挤掉）。
    return s.filter((x) => String(x ?? '').trim() !== '' && !(code === 'tool-error' && isToolUsageNoise([x]))).slice(0, 3);
  };
  const push = (item) => {
    todo.push(hasConcreteSample(item.samples)
      ? { ...item, kind: 'orphan-candidate' }
      : { ...item, kind: 'aggregate', note: item.note + '（聚合型：无具体样本，**不转正**；需要个案请看 hooks 明细）' });
  };
  const findings = Array.isArray(audit?.findings) ? audit.findings : [];
  for (const finding of findings) {
    todo.push({
      kind: 'review',
      code: String(finding.code),
      count: Number(finding.count ?? 0),
      note: `${finding.code} ×${finding.count}（akasha_audit 可查明细）`
    });
  }
  if ((counters?.toolErrorsSubstantive ?? counters?.toolErrors ?? 0) > 0) {
    // 2026-10-11 深夜：待办用**实质失败**计数与样本（探测类噪声另列，不驱动待办——否则"每次睡眠都推一条"）。
    // `??` 的零值语义（2026-10-13 举一反三核对，非缺陷）：`toolErrorsSubstantive = 0` ⇒ 本轮确无实质失败 ⇒ 不产候选；
    //   而 `toolErrorsSubstantive` 缺席时退回 `toolErrors` ⇒ 老调用方（只给 toolErrors）不受影响。
    const sub = Number(counters.toolErrorsSubstantive ?? counters.toolErrors ?? 0);
    const probe = Number(counters.toolErrorsProbe ?? 0);
    const usable = usableOf('tool-error');
    // 2026-10-22 P2-1：note 必须与保留下来的样本同源；旧写法取 notes[0]，会把已被过滤的 usage 原文
    // 又写回 candidate.note，promote 再优先 note ⇒ 真实 ENOENT 被挤出 observed。
    const note = usable.length ? usable.join('；') : String(notes?.[0] ?? '');
    push({
      code: 'tool-error', count: sub,
      note: note + (probe ? `（另有 ${probe} 次探测类噪声，已单列不计入）` : ''),
      samples: usable
    });
  }
  if ((counters?.denials ?? 0) > 0) {
    push({ code: 'gate-denied', count: counters.denials, note: '被门控拦截的写入尝试', samples: usableOf('gate-denied') });
  }
  if ((counters?.agentErrors ?? 0) > 0) {
    push({ code: 'agent-error', count: counters.agentErrors, note: 'agent 级错误', samples: usableOf('agent-error') });
  }
  const misses = Number(counters?.recallMisses ?? 0);
  if (misses > 0) {
    const turns = Number(counters?.failureTurns ?? misses);
    const late = Number(counters?.lateRecall ?? 0);
    const samples = (Array.isArray(recall?.samples) ? recall.samples : []).slice(0, 3)
      .map((x) => `${x?.what ?? '?'}${x?.session ? ' @' + x.session : ''}${x?.ts ? ' ' + String(x.ts).slice(0, 16) : ''}`);
    todo.push({
      kind: 'review', code: 'recall-miss', count: misses, failureTurns: turns, lateRecall: late,
      note: `失败前未查库 ${misses}/${turns} 回合${late ? `（其中事后才查 ${late}）` : ''}——召回复盘：库里本来有没有能救它的条目？有 → 补召回入口（触发词 / 镜像解法）；没有 → 记孤案或定价`,
      samples
    });
  }
  return todo;
}

/** 渲染「门口条子」：一行睡眠摘要（纯函数，可测）。 */
export function renderContextLine(state) {
  try {
    if (!state || !state.lastRunAt) return '阿卡夏·睡眠：尚未运行（将在空闲时首次蒸馏）。';
    const c = state.lastCounters ?? {};
    let auditBit = '审计不可用';
    if (state.lastAudit === 'ok') auditBit = '审计 OK';
    else if (typeof state.lastAudit === 'number') auditBit = `审计警告 ${state.lastAudit} 条`;
    const todoBit = Number.isInteger(state.lastTodo) && state.lastTodo > 0 ? `；待办 ${state.lastTodo} 条（inbox.jsonl）` : '';
    const recallBit = Number(c.recallMisses) > 0 ? `；失败前未查库 ${c.recallMisses}/${c.failureTurns ?? c.recallMisses} 回合` : '';
    return `阿卡夏·睡眠：${state.lastRunAt}（${state.lastTrigger ?? '?'}）新增 ${c.lines ?? 0} 条 / 工具 ${c.tools ?? 0}（错误 ${c.toolErrors ?? 0}、拦截 ${c.denials ?? 0}${recallBit}）；${auditBit}${todoBit}；报告 ${state.lastReport ?? '（无）'}。`;
  } catch {
    return '阿卡夏·睡眠：状态读取失败。';
  }
}

/** 组装「库脉搏」行（纯函数）：六库当前计数 + 全库最近一条写入与相对时间。
 *  C3（2026-10-14 用户裁定「A」；近场纪律半句）：行尾固定附「 · 相关主题先 brief」——挂每回合必经的执行点
 *  （远场 usage 条同句不落手；这条是近场版，第 2/3 轮测它）。
 *  关断：`AKASHA_PULSE_HINT=off`（环境变量，与 AKASHA_QUERY_LOG=off 同款）或 opts.hint=false；缺省开。
 *  ⚠ 生效时点（2026-10-14 探针实证，见 canon-c3-pulse-hint-20261014）：插件进程内 require 的模块**有缓存** ⇒
 *  改核心要**重启宿主**才反映到插件渲染面（正文更正 AGENTS §6「改核心即时生效」的表述——那只对 CLI/新进程成立）。 */
export function renderPulseLine(p, opts = {}) {
  if (!p || !p.stores) return null;
  const counts = Object.entries(p.stores).map(([k, v]) => `${k} ${v.current ?? v.count}`).join(' / ');
  const newest = p.newest && p.newest.id ? `${p.newest.store}#${p.newest.id}（${p.newest.ageText ?? '?'}）` : '（无）';
  const hintOff = opts.hint === false || String(process.env.AKASHA_PULSE_HINT || '').toLowerCase() === 'off';
  // 内置时钟前缀（2026-10-14 用户令：每回合可见的时间基准；关断 AKASHA_CLOCK=off；注入 opts.now 供测试）
  const clockOff = opts.clock === false || String(process.env.AKASHA_CLOCK || '').toLowerCase() === 'off';
  let clock = '';
  if (!clockOff) {
    const d = opts.now instanceof Date ? opts.now : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    clock = `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${wd} ${pad(d.getHours())}:${pad(d.getMinutes())}] `;
  }
  return `${clock}阿卡夏·库脉搏：${counts}；最近写入 ${newest}${hintOff ? '' : ' · 相关主题先 brief'}`;
}

/** 去抖判断（纯函数）：跑过且未满间隔 → 不睡（返回 sinceHours 供留痕）；其余（含从未跑过）→ 睡。 */
export function shouldSleep(state, nowMs, minIntervalHours = SLEEP_DEFAULTS.minIntervalHours) {
  const last = state && state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
  const hours = last ? (nowMs - last) / 3600000 : null;
  const rounded = hours === null ? null : Math.round(hours * 10) / 10;
  if (last && hours < minIntervalHours) return { due: false, hoursSince: rounded };
  return { due: true, hoursSince: rounded };
}

/**
 * 睡眠主流程：读状态 → 水位线增量 → 蒸馏 → audit → 报告 → inbox → 水位线推进。
 * dry:true → 全不写、只返回预览。report/state/inbox 写失败 → 观测线（v1.3.1「静默失败清剿」语义不变）。
 */
export function sleepRun(opts = {}) {
  const logPath = opts.log || SLEEP_DEFAULTS.log;
  const stateFile = opts.stateFile || SLEEP_DEFAULTS.stateFile;
  const inboxFile = opts.inboxFile || SLEEP_DEFAULTS.inboxFile;
  const reportDir = opts.reportDir || SLEEP_DEFAULTS.reportDir;
  const trigger = opts.trigger || 'manual';
  const now = opts.now ? new Date(opts.now) : new Date();
  const emit = (record) => {
    // dry 语义＝「全不写」（函数头承诺）——观测线也算写：`logPath` 常与 hooks.jsonl 同文件，
    // dry 时往里 append 会**改掉被测对象的行数**（2026-10-13 实测：会话内 dry 一次 → 后续 processedTo 2→4）。
    if (opts.dry) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, JSON.stringify(redactDeep({ ts: new Date().toISOString(), ...record })) + '\n', 'utf8');
    } catch { /* 静默：观测线写不了不拖垮 */ }
  };
  try {
    let state = {};
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = {}; }
    let buf = Buffer.alloc(0);
    try { buf = readFileSync(logPath); } catch { buf = Buffer.alloc(0); }
    // 水位线按字节（2026-10 复查）。旧状态只有 processedLines 时折算一次；文件变短视为轮转，从头蒸馏并留 truncated。
    let fromByte = Number.isInteger(state.processedBytes) ? state.processedBytes : null;
    let truncated = false;
    if (fromByte === null && Number.isInteger(state.processedLines) && state.processedLines > 0) {
      let n = 0; let i = 0;
      while (n < state.processedLines && i < buf.length) { if (buf[i] === 10) n += 1; i += 1; }
      fromByte = i;
    }
    if (fromByte === null) fromByte = 0;
    if (fromByte > buf.length) { truncated = true; fromByte = 0; }
    let end = buf.length;
    if (end > fromByte && buf[end - 1] !== 10) {
      const nl = buf.lastIndexOf(10);
      end = nl >= fromByte ? nl + 1 : fromByte;
    }
    const slice = buf.subarray(fromByte, end).toString('utf8').split(/\r?\n/).filter(Boolean);
    // 2026-10-13（A2 联查发现的旧坑）：`emit` 就是往**同一个 logPath** 追加观测线 ⇒ 循环里一旦 emit，
    //   本轮的「读了 N 行」与「文件现在有 M 行」就分叉：next.processedBytes 会记到 emit 之后的位置，
    //   而 slice 只覆盖 emit 之前 ⇒ 下一轮从错误水位续读（实测 processedTo 2→4）。修法：读多少、记多少，
    //   先把两个数**快照**下来，之后任何 emit 都不再影响水位。
    const readBytes = end;
    const readLineFrom = truncated ? 0 : (Number.isInteger(state.processedLines) ? state.processedLines : 0);
    const readLineCount = slice.length;
    const { counters, notes, probeNotes, samples, recall } = distillHooks(slice);
    // 对外仍以「条」计（CLI / 旧测试）；字节水位只进 state.processedBytes。
    const lineFrom = readLineFrom;
    const lineTo = readLineFrom + readLineCount;

    let auditResult;
    try {
      const result = audit();
      auditResult = { ok: result.ok, findings: result.findings.map((f) => ({ level: f.level, code: f.code, count: f.detail.length })) };
    } catch (error) {
      auditResult = { ok: null, error: String(error?.message ?? error).slice(0, 200) };
    }

    const stamp = now.toISOString();
    const date = stamp.slice(0, 10);
    const todo = buildTodos(counters, notes, auditResult, recall, samples);
    // 2026-10-13（A2）：聚合型待办**分道**——保留展示（报告/inbox 里能看见），但跨批去重：
    //   同一 code 连续两批都没变 ⇒ 第二批静默（防刷屏），第三批再报一次（防遗忘）。
    //   口径说明：`item.count` 是**本批窗口内**的计数（不是累计），所以判据不能写成「计数是否增长」——
    //   写成「连续出现的批次数」才对（2026-10-13 第一版写错过，此处留痕）。
    //   为什么不在 buildTodos 里做：那是纯函数（可测），跨批状态属于运行侧；分道后 promote 只认 orphan-candidate。
    const aggState = (state.aggregates && typeof state.aggregates === 'object') ? { ...state.aggregates } : {};
    const keptTodo = [];
    for (const item of todo) {
      if (item.kind !== 'aggregate') { keptTodo.push(item); continue; }
      const prev = aggState[item.code] || null;
      const miss = prev ? (Number(prev.miss || 0) + 1) : 0;
      aggState[item.code] = { lastCount: Number(item.count || 0), miss, lastSeenAt: stamp };
      if (miss >= 2) {                                     // 连续第三次出现 ⇒ 重新提醒一次并复位
        aggState[item.code].miss = 0;
        keptTodo.push(item);
      } else {
        emit({ kind: 'sleep-aggregate-skip', code: item.code, count: item.count, consecutive: miss });
      }
    }
    todo.length = 0; todo.push(...keptTodo);
    // §3：refuted 进复审、高频 T5 进 verify-candidate。只追加待办，不改六库。扫描失败不拖垮睡眠。
    try {
      const extra = credibilityTodos({ files: opts.files, log: logPath, today: date, verifyUsageMin: opts.verifyUsageMin });
      for (const item of extra) todo.push(item);
    } catch { /* 只读扫描失败就当没有 */ }
    const report = { date, ranAt: stamp, trigger, processedFrom: lineFrom, processedTo: lineTo, processedBytes: readBytes, truncated, counters, notes, probeNotes, audit: auditResult, todo };

    if (opts.dry) {
      return { ok: true, dry: true, report, reportFile: null, todo: todo.length, processedFrom: lineFrom, processedTo: lineTo, truncated };
    }

    let reportFile = `sleep-${date}.json`;
    try {
      mkdirSync(reportDir, { recursive: true });
      if (existsSync(join(reportDir, reportFile))) reportFile = `sleep-${date}-${stamp.slice(11, 19).replace(/:/g, '')}.json`;
      writeFileAtomic(join(reportDir, reportFile), JSON.stringify(report, null, 2));
    } catch (error) {
      emit({ kind: 'sleep-report-error', message: String(error?.message ?? error).slice(0, 300), code: String(error?.code ?? '') });
    }

    let inboxOk = true;
    if (todo.length > 0) {
      try {
        mkdirSync(dirname(inboxFile), { recursive: true });
        appendFileSync(inboxFile, JSON.stringify(redactDeep({ ts: stamp, kind: 'todo', fromReport: reportFile, items: todo })) + '\n', 'utf8');
      } catch (error) { inboxOk = false; emit({ kind: 'sleep-inbox-error', message: String(error?.message ?? error).slice(0, 200) }); }
    }

    // F11（2026-10-14 外部审查 · GPT）：**持久化成功才提交水位**——inbox 写失败时若照推 processedBytes，
    //   这批待办永久漏件且不会重试。失败 ⇒ 水位停在原处，下一轮重读同窗口（报告已落盘，重复无害）。
    const next = {
      processedBytes: inboxOk ? readBytes : (Number.isInteger(state.processedBytes) ? state.processedBytes : 0),
      processedLines: inboxOk ? lineTo : (Number.isInteger(state.processedLines) ? state.processedLines : 0),
      lastRunAt: stamp,
      lastTrigger: trigger,
      lastReport: reportFile,
      lastCounters: counters,
      lastTodo: todo.length,
      lastAudit: auditResult.ok === true ? 'ok' : auditResult.ok === false ? (auditResult.findings?.length ?? 0) : 'unavailable',
      // R14（GPT 复核二轮）：**水位 / 去重 / 交付整体提交**——inbox 写失败时，去重账本（aggregates）也不得提交，
      //   否则重试时 miss 已归零 ⇒ 候选不再展示（水位回退了也白搭）。
      aggregates: inboxOk ? aggState : (state.aggregates && typeof state.aggregates === 'object' ? { ...state.aggregates } : {})
    };
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileAtomic(stateFile, JSON.stringify(next, null, 2));
    } catch (error) { emit({ kind: 'sleep-state-error', message: String(error?.message ?? error).slice(0, 200) }); }

    return { ok: true, reportFile, todo: todo.length, inboxWritten: inboxOk, processedFrom: lineFrom, processedTo: lineTo, truncated, state: next };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

/** 回查提示（v1.5，2026-10-07）：窗口内有失败（工具 / agent）→ 一行提示（幂等：同窗口渲染结果稳定）；无 → null。 */
export function renderRecallLine(failures, nowMs = Date.now(), windowMs = 1800000) {  const recent = (Array.isArray(failures) ? failures : []).filter((f) => f && typeof f.ts === 'number' && nowMs - f.ts <= windowMs);
  if (!recent.length) return null;
  const tools = [...new Set(recent.map((f) => String(f.tool || '未知')))].slice(0, 4);
  const minutes = Math.round(windowMs / 60000);
  return `阿卡夏·回查提示：近 ${minutes} 分钟内 ${recent.length} 次失败（${tools.join(' / ')}）——先查库（lookup / brief 相关主题）再继续；失败回查：库里本来有没有能救它的东西？`;
}

/**
 * 称呼行（v1.5.4，2026-10-10 用户复盘）：**防长会话称呼漂移**。
 * 起因：称呼规则躺在会话开头的注入块（akasha:self）里，而回复时没有任何执行点去看它 ⇒ 中期必然漂移。
 * 修法：接进**每回合必然经过的执行点**（runtime context 行），并把「执行点要求」写明。
 * 渲染自 canon 的称呼体系当前版本（取 ① 与 ③ 之间那段＝Master 与大肥鱼；括号说明与加粗剔除以保持一行）；
 * 读不到库时不抛，退内置短句。
 */
export function renderAddressLine(claim) {
  const s = String(claim ?? '').replace(/\s+/g, ' ').trim();
  const a = s.indexOf('①');
  const b = s.indexOf('③');
  const core = a >= 0 && b > a ? s.slice(a, b) : '';
  const body = (core || '① **Master**——用户要求模型对其使用的称呼；② **大肥鱼**——用户对模型（DSH）的称呼（爱称，与桌宠「小肥鱼」同形象）。')
    .replace(/\*\*/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
  return '阿卡夏·称呼：' + body.slice(0, 150) + ' ⇒ 交付 / 验收 / 复盘等节点的回复开口句带 Master。';
}

// —— 睡眠期合并 / 丢弃：只出计划（wave2 §2 第一批，2026-10-08）——
// `sleep --plan` 只读六库、只写 logs/ 下的计划文件；不调 appendRecord / revise / retire，不动水位线。
// --apply / 回滚 / revokes 等计划评审过后再做（下一批；P4 立场见 SCHEMA「睡眠计划」）。
// 规则全是机械的、可复算：同一份库 + 同一份日志 + 同一组参数 ⇒ 同一组 ops、同一个 planId（createdAt 不进 planId）。
export const PLAN_DEFAULTS = Object.freeze({ theta: 0.8, maxOps: 20, orphanDays: 90, staleDays: 365 });
const PLAN_OP_ORDER = { merge: 0, discard: 1 };
const PLAN_CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const SNAPSHOT_RE = /^(.+)-(\d{8})$/;

// R4（2026-10-14 用户裁定「r4 可以继续」；草案 research/sleep-merge-rules-draft-20261014.md §3）：
//   keep **按代际**——同源快照两代（版本标记可解析）⇒ 保留**最新**；真重复（无版本标记）⇒ 保留最早（原规则）；
//   判不了（版本标记混用 / 全同）⇒ `keep: null` + `needsHuman: true`，apply 拒绝该 op（交人工）。
export function versionMarkerOf(id) {
  const m = /v(\d+)[-.](\d+)(?:[-.](\d+))?/i.exec(String(id));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}
export function genStemOf(id) {
  return String(id).replace(/v\d+[-.]\d+(?:[-.]\d+)?/gi, '').replace(/-r\d+[a-z]*$/i, '').replace(/-retired$/i, '');
}
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}
/** 组内 keep 重选：返回 { keep, needsHuman, why }。`recById` 取 logged_at 破平。 */
export function reselectKeep(ids, recById = new Map()) {
  const vers = ids.map((id) => ({ id, ver: versionMarkerOf(id) })).filter((x) => x.ver);
  const logged = (id) => String(recById?.get?.(id)?.logged_at ?? '');
  if (!vers.length) return { keep: null, needsHuman: false, why: 'no-version: 沿用原 keep（真重复，取最早）' };
  const distinct = new Set(vers.map((x) => x.ver.join('.')));
  if (distinct.size !== vers.length) return { keep: null, needsHuman: true, why: '版本标记重复：代际判不了' };
  if (vers.length !== ids.length) return { keep: null, needsHuman: true, why: '版本标记混用（部分无标记）：代际判不了' };
  const sorted = vers.slice().sort((a, b) => cmpVersion(b.ver, a.ver) || (logged(b.id) > logged(a.id) ? 1 : logged(a.id) > logged(b.id) ? -1 : 0));
  if (cmpVersion(sorted[0].ver, sorted[1].ver) === 0 && logged(sorted[0].id) === logged(sorted[1].id)) return { keep: null, needsHuman: true, why: '版本与时间双平：代际判不了' };
  return { keep: sorted[0].id, needsHuman: false, why: 'generational: 取最新代' };
}

/** 计划用的主文本（每库一种；frontier 不比文本，只比 url；orphan 零权重，不进合并）。 */
export function planPrimaryText(store, r) {
  const s = (v) => (typeof v === 'string' ? v : '');
  if (store === 'canon') return s(r.claim);
  if (store === 'mirror') return `${s(r.situation)} ${s(r.behavior)}`;
  if (store === 'lexicon') return `${s(r.term)} ${s(r.trigger)}`;
  if (store === 'pricing') return s(r.behavior);
  return '';
}

/** 计划用的 token 集（纯函数）：沿用 lib.tokenize 切词；含中文的词再拆相邻二字（中文不靠空格分词，整句会成一个 token）。 */
export function planTokens(text) {
  const out = new Set();
  for (const tok of tokenize(text)) {
    if (!PLAN_CJK_RE.test(tok) || tok.length < 2) { out.add(tok); continue; }
    for (let i = 0; i < tok.length - 1; i += 1) out.add(tok.slice(i, i + 2));
  }
  return out;
}

/** token Jaccard（纯函数）：|A∩B| / |A∪B|；两边都空 → 0（空文本不算相似）。 */
export function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fingerprint = (file) => {
  if (!existsSync(file)) return { buf: null, fp: { bytes: 0, sha256: null, missing: true } };
  const buf = readFileSync(file);
  return { buf, fp: { bytes: buf.length, sha256: sha256(buf) } };
};
const dayDiff = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86400000);
const day10 = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '');
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 修订链视图：每条当前记录 → 根 id、链上全部 id、链上是否带 promoted_from。 */
function chainView(records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const rootOf = (r) => { let c = r; const seen = new Set(); while (c && typeof c.supersedes === 'string' && byId.has(c.supersedes) && !seen.has(c.id)) { seen.add(c.id); c = byId.get(c.supersedes); } return c; };
  return currentRecords(records).filter((r) => typeof r.id === 'string' && r.id).map((r) => {
    const chain = []; let c = r; const seen = new Set();
    while (c && !seen.has(c.id)) { seen.add(c.id); chain.unshift(c); c = typeof c.supersedes === 'string' ? byId.get(c.supersedes) : null; }
    const root = rootOf(r) || r;
    return { rec: r, rootId: root.id, rootLoggedAt: typeof root.logged_at === 'string' ? root.logged_at : '', chainIds: chain.map((x) => x.id), chain, promoted: chain.some((x) => x.promoted_from != null) };
  });
}

/** hooks 日志里 kind:"usage" 的引用计数（只读）；文件缺失 → null（不知道 ≠ 零引用）。 */
function usageFromLog(buf) {
  if (!buf) return null;
  const usage = new Map();
  for (const raw of buf.toString('utf8').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let rec; try { rec = JSON.parse(raw); } catch { continue; }
    if (rec && rec.kind === 'usage' && Array.isArray(rec.ids)) for (const id of rec.ids) usage.set(String(id), (usage.get(String(id)) ?? 0) + 1);
  }
  return usage;
}

/**
 * 生成睡眠计划（只读）。opts：
 *   files    —— { <store>: 路径 }（缺省 storePath；测试注入临时库）
 *   log      —— hooks.jsonl（canon-stale 的引用计数来源；缺省 logs/hooks.jsonl）
 *   today    —— YYYY-MM-DD（缺省本地今天；进 params 与 planId）
 *   theta / maxOps / orphanDays / staleDays —— 见 PLAN_DEFAULTS
 *   out      —— 计划文件路径；缺省 logs/sleep-plan-<today>.json；false = 不落盘（纯计算）
 *   now      —— createdAt 用的时间（缺省 new Date()；不进 planId）
 * 返回 { ok, plan, planFile }；不调用任何写库函数。
 */
export function sleepPlan(opts = {}) {
  try {
    const today = opts.today ? String(opts.today).slice(0, 10) : todayLocal();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || Number.isNaN(Date.parse(today))) return { ok: false, error: 'today 须为 YYYY-MM-DD：' + opts.today };
    const num = (v, d) => (v === undefined || v === null || v === true || v === '' ? d : Number(v));
    const params = {
      today,
      theta: num(opts.theta, PLAN_DEFAULTS.theta),
      maxOps: num(opts.maxOps, PLAN_DEFAULTS.maxOps),
      orphanDays: num(opts.orphanDays, PLAN_DEFAULTS.orphanDays),
      staleDays: num(opts.staleDays, PLAN_DEFAULTS.staleDays)
    };
    if (!(params.theta > 0 && params.theta <= 1)) return { ok: false, error: 'theta 须在 (0, 1]：' + opts.theta };
    for (const k of ['maxOps', 'orphanDays', 'staleDays']) if (!Number.isInteger(params[k]) || params[k] < 0) return { ok: false, error: `${k} 须为非负整数：` + params[k] };

    // 1) 读库 + 指纹（同一份字节既算指纹又解析，保证 basis 与 ops 对应同一快照）
    const files = opts.files || {};
    const basis = {}; const views = {}; const badLines = {};
    for (const store of STORES) {
      const { buf, fp } = fingerprint(files[store] || storePath(store));
      basis[store] = fp;
      const parsed = buf ? parseJsonl(buf.toString('utf8')) : { records: [], errors: [] };
      if (parsed.errors.length) badLines[store] = parsed.errors.length;
      views[store] = chainView(parsed.records);
    }
    const logFile = opts.log || SLEEP_DEFAULTS.log;
    const logFp = fingerprint(logFile);
    const usage = usageFromLog(logFp.buf);
    const inputs = { hooksLog: logFp.fp };

    // 2) 资格：协议条、带 promoted_from 的链、已退役（currentRecords 已排除）永不进计划
    const excluded = { protocol: 0, promoted: 0 };
    const eligible = {};
    for (const store of STORES) {
      eligible[store] = views[store].filter((v) => {
        if (v.chainIds.some(isProtocolId)) { excluded.protocol += 1; return false; }
        if (v.promoted) { excluded.promoted += 1; return false; }
        return true;
      }).sort((a, b) => byStr(a.rootLoggedAt, b.rootLoggedAt) || byStr(a.rootId, b.rootId) || byStr(a.rec.id, b.rec.id));
    }

    const used = new Set(); // `${store}\u0000${id}`：一条记录至多出现在一个 op 里
    const key = (store, id) => store + '\u0000' + id;
    const discards = []; const merges = []; const skipped = [];

    // 3) discard（先于 merge：被取代的旧快照不该被当成合并的 keep）
    //   a. canon 快照被更新快照取代：根 id 形如 <主题>-YYYYMMDD，同主题有更晚日期的当前快照
    //      （同主题的「更新快照」从全部当前 canon 里找——哪怕它本身因 promoted_from 不进计划，也照样算取代者）
    const eligibleCanon = new Set(eligible.canon.map((v) => v.rec.id));
    const snaps = new Map();
    for (const v of views.canon) {
      if (v.chainIds.some(isProtocolId)) continue;
      const m = SNAPSHOT_RE.exec(v.rootId);
      if (!m) continue;
      if (!snaps.has(m[1])) snaps.set(m[1], []);
      snaps.get(m[1]).push({ v, date: m[2] });
    }
    for (const [stem, list] of [...snaps.entries()].sort((a, b) => byStr(a[0], b[0]))) {
      if (list.length < 2) continue;
      list.sort((a, b) => byStr(b.date, a.date) || byStr(a.v.rootId, b.v.rootId));
      const newest = list[0];
      for (const { v, date } of list.slice(1)) {
        if (date === newest.date || !eligibleCanon.has(v.rec.id)) continue;
        discards.push({ op: 'discard', store: 'canon', id: v.rec.id, reason: 'snapshot-superseded', evidence: { stem, snapshotDate: date, supersededBy: newest.v.rec.id, newerDate: newest.date } });
        used.add(key('canon', v.rec.id));
      }
    }
    //   b. canon-stale（last_reviewed 超过 staleDays）且 usage 从未引用过链上任何 id；没有日志 = 不知道 → 不出此类 op
    if (usage === null) skipped.push({ rule: 'canon-stale-unused', why: 'hooks 日志不存在：引用次数未知，不按「从未引用」处理' });
    else {
      for (const v of eligible.canon) {
        if (used.has(key('canon', v.rec.id))) continue;
        const lr = day10(v.rec.last_reviewed);
        if (!lr) continue;
        const age = dayDiff(lr, today);
        if (!(age > params.staleDays)) continue;
        const refs = v.chainIds.reduce((n, id) => n + (usage.get(id) ?? 0), 0);
        if (refs > 0) continue;
        discards.push({ op: 'discard', store: 'canon', id: v.rec.id, reason: 'canon-stale-unused', evidence: { last_reviewed: lr, ageDays: age, staleDays: params.staleDays, usageRefs: 0, chainIds: v.chainIds } });
        used.add(key('canon', v.rec.id));
      }
    }
    //   c. orphan-aging：created 超过 orphanDays，且这段时间里链上没有修订（无确认）
    for (const v of eligible.orphan) {
      const created = day10(v.rec.created) || day10(v.chain[0].created);
      if (!created) continue;
      const age = dayDiff(created, today);
      if (!(age > params.orphanDays)) continue;
      const lastRevision = v.chain.filter((x) => typeof x.supersedes === 'string').map((x) => day10(x.logged_at)).filter(Boolean).sort().pop() || null;
      if (lastRevision && dayDiff(lastRevision, today) <= params.orphanDays) continue;
      discards.push({ op: 'discard', store: 'orphan', id: v.rec.id, reason: 'orphan-aging', evidence: { created, ageDays: age, orphanDays: params.orphanDays, lastRevision, severity: v.rec.severity ?? null } });
      used.add(key('orphan', v.rec.id));
    }
    //   frontier 永不 discard（只走 frontier recheck）——这里没有规则，不是遗漏。

    // 4) merge：同库当前集；keep = 根 logged_at 最早（同则根 id 字典序）；贪心——keep 只吸收与它本身 ≥ θ 的条目（每个 absorb 都有直接证据）
    for (const store of ['canon', 'mirror', 'lexicon', 'pricing']) {
      const cands = eligible[store].filter((v) => !used.has(key(store, v.rec.id))).map((v) => ({ v, toks: planTokens(planPrimaryText(store, v.rec)) })).filter((c) => c.toks.size > 0);
      const taken = new Set();
      for (let i = 0; i < cands.length; i += 1) {
        if (taken.has(i)) continue;
        const absorb = []; const pairs = [];
        for (let j = i + 1; j < cands.length; j += 1) {
          if (taken.has(j)) continue;
          const sim = jaccard(cands[i].toks, cands[j].toks);
          if (sim < params.theta) continue;
          // F04：相似度达标还不够——决定性字段不一致（跨来源 / 正负定价）⇒ 不吸收，理由记进证据。
          const el = mergeEligiblePair(store, cands[i].v.rec, cands[j].v.rec);
          if (!el.ok) { pairs.push({ id: cands[j].v.rec.id, jaccard: +sim.toFixed(4), refused: el.why }); continue; }
          taken.add(j); absorb.push(cands[j].v.rec.id); pairs.push({ id: cands[j].v.rec.id, jaccard: +sim.toFixed(4) });
        }
        if (!absorb.length) continue;
        taken.add(i);
        // R4（2026-10-14 用户裁定继续；草案 §3）：组内 keep 按代际重选＋对新 keep 重核相似度。
        const origKeep = cands[i].v.rec.id;
        const group = [origKeep, ...absorb];
        const recById = new Map(views[store].map((v) => [v.rec.id, v.rec]));
        const rk = reselectKeep(group, recById);
        let keepId = origKeep; let needsHuman = false;
        if (rk.keep) keepId = rk.keep;
        else if (rk.needsHuman) { keepId = null; needsHuman = true; }
        let finalAbsorb = absorb; let finalPairs = pairs;
        if (keepId && keepId !== origKeep) {
          const keeper = cands.find((c) => c.v.rec.id === keepId);
          finalAbsorb = []; finalPairs = [];
          for (const id of group) {
            if (id === keepId) continue;                       // ⚠ 排除 keep 自身（2026-10-14 修：此前曾产出 keep ← keep 自吸收）
            const other = cands.find((c) => c.v.rec.id === id);
            const sim = keeper && other ? jaccard(keeper.toks, other.toks) : 0;
            if (sim < params.theta) continue;
            const el = keeper && other ? mergeEligiblePair(store, keeper.v.rec, other.v.rec) : { ok: false, why: '候选缺失' };
            if (!el.ok) { finalPairs.push({ id, jaccard: +sim.toFixed(4), refused: el.why }); continue; }   // F04：换 keep 后同样要过资格检查
            finalAbsorb.push(id); finalPairs.push({ id, jaccard: +sim.toFixed(4) });
          }
          if (!finalAbsorb.length) { for (const id of group) used.add(key(store, id)); continue; }
        }
        merges.push({
          op: 'merge', store, keep: keepId, ...(needsHuman ? { needsHuman: true, keepCandidates: group } : {}),
          absorb: finalAbsorb, reason: 'near-duplicate', mergedText: null,
          evidence: { theta: params.theta, field: store === 'canon' ? 'claim' : store === 'mirror' ? 'situation+behavior' : store === 'lexicon' ? 'term+trigger' : 'behavior', keepRule: rk.why, pairs: finalPairs }
        });
        for (const id of group) used.add(key(store, id));
      }
    }
    //   frontier：同 url（与 audit duplicate-url 同口径：精确相等）
    const byUrl = new Map();
    for (const v of eligible.frontier) {
      if (used.has(key('frontier', v.rec.id)) || typeof v.rec.url !== 'string' || !v.rec.url) continue;
      if (!byUrl.has(v.rec.url)) byUrl.set(v.rec.url, []);
      byUrl.get(v.rec.url).push(v);
    }
    for (const [url, list] of [...byUrl.entries()].sort((a, b) => byStr(a[0], b[0]))) {
      if (list.length < 2) continue;
      // R4 同款：url 重复组也按代际重选 keep（同 url 且带版本标记 ⇒ 保留最新；无版本标记 ⇒ 原优先级第一条）
      const group = list.map((v) => v.rec.id);
      const recById = new Map(list.map((v) => [v.rec.id, v.rec]));
      const rk = reselectKeep(group, recById);
      let keepId = list[0].rec.id; let needsHuman = false;
      if (rk.keep) keepId = rk.keep;
      else if (rk.needsHuman) { keepId = null; needsHuman = true; }
      const absorbIds = group.filter((id) => id !== keepId);
      merges.push({ op: 'merge', store: 'frontier', keep: keepId, ...(needsHuman ? { needsHuman: true, keepCandidates: group } : {}), absorb: absorbIds, reason: 'duplicate-url', mergedText: null, evidence: { url, keepRule: rk.why, statuses: Object.fromEntries(list.map((v) => [v.rec.id, v.rec.status ?? null])) } });
    }

    // 5) 排序 + 截断到 K
    const storeIdx = (s) => STORES.indexOf(s);
    const all = [...merges, ...discards].sort((a, b) =>
      PLAN_OP_ORDER[a.op] - PLAN_OP_ORDER[b.op] || storeIdx(a.store) - storeIdx(b.store) || byStr(a.reason, b.reason) || byStr(a.keep ?? a.id, b.keep ?? b.id));
    const ops = all.slice(0, params.maxOps);
    const truncated = { total: all.length, dropped: all.length - ops.length };

    // 5.5) 近失报告（2026-10-10）：把「离触发还差多远」摆出来——ops 为空时不再是黑箱。
    //   · 合并：同库 Jaccard 最高的若干对 vs θ（独立于上面贪心结果，纯诊断）
    //   · 丢弃：最老的 orphan / canon 年龄 vs 各自阈值；快照取代与 frontier 同 url 的组数
    //   诊断段不参与 planId 哈希（计划身份仍只由 params/basis/inputs/ops 决定），也不影响任何 op。
    const nearMiss = { merge: {}, discard: {} };
    for (const store of ['canon', 'mirror', 'lexicon', 'pricing']) {
      const cands = eligible[store].map((v) => ({ id: v.rec.id, toks: planTokens(planPrimaryText(store, v.rec)) })).filter((c) => c.toks.size > 0);
      const pairs = [];
      for (let i = 0; i < cands.length; i += 1) {
        for (let j = i + 1; j < cands.length; j += 1) {
          const sim = jaccard(cands[i].toks, cands[j].toks);
          if (sim > 0) pairs.push({ a: cands[i].id, b: cands[j].id, jaccard: +sim.toFixed(4) });
        }
      }
      pairs.sort((x, y) => y.jaccard - x.jaccard || byStr(x.a, y.a) || byStr(x.b, y.b));
      nearMiss.merge[store] = { theta: params.theta, candidates: cands.length, top: pairs.slice(0, 3) };
    }
    const orphanAges = eligible.orphan.map((v) => {
      const created = day10(v.rec.created) || day10(v.chain[0].created);
      return created ? { id: v.rec.id, created, ageDays: dayDiff(created, today) } : null;
    }).filter(Boolean).sort((a, b) => b.ageDays - a.ageDays || byStr(a.id, b.id));
    const canonAges = eligible.canon.map((v) => {
      const lr = day10(v.rec.last_reviewed);
      return lr ? { id: v.rec.id, last_reviewed: lr, ageDays: dayDiff(lr, today) } : null;
    }).filter(Boolean).sort((a, b) => b.ageDays - a.ageDays || byStr(a.id, b.id));
    nearMiss.discard['orphan-aging'] = { thresholdDays: params.orphanDays, examined: orphanAges.length, oldest: orphanAges.slice(0, 3) };
    nearMiss.discard['canon-stale-unused'] = { thresholdDays: params.staleDays, examined: canonAges.length, oldest: canonAges.slice(0, 3), ...(usage === null ? { note: 'usage 日志缺失：本规则不出 op' } : {}) };
    nearMiss.discard['snapshot-superseded'] = { stemsExamined: snaps.size, stemsWithMultiple: [...snaps.values()].filter((l) => l.length >= 2).length };
    nearMiss.discard['frontier-duplicate-url'] = { urlsWithMultiple: [...byUrl.values()].filter((l) => l.length >= 2).length };

    const planId = 'plan-' + sha256(JSON.stringify({ v: 1, params, basis, inputs, ops })).slice(0, 16);
    const plan = {
      planId, version: 1, mode: 'plan-only',
      createdAt: (opts.now instanceof Date ? opts.now : new Date()).toISOString(),
      params, basis, inputs, ops, truncated, excluded, skipped, nearMiss,
      ...(Object.keys(badLines).length ? { badLines } : {}),
      note: '只读计划：未改六库。mergedText 留给模型 / 人填写；--apply（A 档：keep 一字不动＋absorb 软退役）/ --revoke 已实现（2026-10-14；规则 research/sleep-merge-rules-draft-20261014.md R1–R8）。'
    };
    let planFile = null;
    if (opts.out !== false) {
      planFile = opts.out || join(SLEEP_DEFAULTS.reportDir, `sleep-plan-${today}-${planId.slice(5, 13)}.json`);   // 2026-10-14 整体复检修：文件名带 planId 短码，**防同日互相覆盖**（覆盖会让旧 planId 失联、证据链断——当晚真实踩到）
      const resolved = new Set(STORES.map((s) => resolve(files[s] || storePath(s))));
      if (resolved.has(resolve(planFile))) return { ok: false, error: '拒绝把计划写到存储文件上：' + planFile };
      mkdirSync(dirname(planFile), { recursive: true });
      writeFileAtomic(planFile, JSON.stringify(plan, null, 2) + '\n');
    }
    return { ok: true, plan, planFile };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

// ── apply / revoke（2026-10-14 实现；草案 research/sleep-merge-rules-draft-20261014.md R1–R8；用户裁定「A 档先」）──
//   A 档语义（零改写）：merge ⇒ **keep 一字不动**，absorb 逐条**软退役**（retired_reason: 'merged-into <keep>'）；
//   discard ⇒ 该条目软退役（reason 原样）。不改任何既有行；回滚＝revokePlan（revokes 元数据记录，SCHEMA §P4）。
//   闸门：默认 dry（演练）；basis 指纹复核（改动过 ⇒ 拒绝，除非 --force）；豁免面（协议条/自我层）双闸拒绝；
//   keep=null（needsHuman）op 一律拒绝；幂等＝已退役者跳过。审计：review-log 行 + `logs/sleep-apply-<planId>.json` 回执。
const planRefLoad = (ref) => {
  if (ref && typeof ref === 'object') return ref;
  const s = String(ref ?? '').trim();
  if (!s) return null;
  try { if (existsSync(s)) return JSON.parse(readFileSync(s, 'utf8')); } catch { return null; }
  try {
    const files = readdirSync(SLEEP_DEFAULTS.reportDir).filter((x) => x.startsWith('sleep-plan-') && x.endsWith('.json')).sort().reverse();
    for (const f of files) {
      try { const j = JSON.parse(readFileSync(join(SLEEP_DEFAULTS.reportDir, f), 'utf8')); if (j.planId === s) return j; } catch { /* 跳过坏文件 */ }
    }
  } catch { /* 目录不可读即找不回 */ }
  return null;
};
const isExemptRecord = (rec, id) => isProtocolId(String(id)) || isSelfLayerRecord(rec ?? {});

/** 生产路径硬闸：非演练的 `--force` 拒绝。演练（dry）仍可带 force，用来看过期计划会做什么。
 *  库函数 `applyPlan` 只在 `opts.production === true`（CLI 生产入口）时执行本闸，
 *  以便既有回执合并回归仍能以编程方式重跑。 */
export function productionForceRejected(opts = {}) {
  const dry = opts.dry !== false;
  if (!dry && opts.force === true) {
    return '生产路径拒绝非演练的 --force：指纹过期请重新 sleep --plan。--force 只可与演练同用（不加 --yes），用来查看过期计划会做什么，不会写库。';
  }
  return null;
}

/** F04（2026-10-14 外部审查 · GPT）：合并的**决定性字段**必须一致——「同正文 ≠ 同事实」。
 *  canon/mirror：`source.type`（R1 跨来源禁令）；pricing：`behavior` + `valence`（正负定价相反的规则不可并）；
 *  lexicon：定义类字段（word/term/label/category/emotion，见字段才比）。**计划生成与执行共用本函数**（同一资格检查）。
 *  字段缺失 ⇒ 不加约束（对旧数据保守，合口径「宁可漏并也不误并」）。 */
const MERGE_DECISIVE = {
  canon: ['source.type'], mirror: ['source.type', 'outcome', 'evidence', 'role', 'era', 'context'],
  pricing: ['behavior', 'valence', 'kind', 'severity_default'], lexicon: ['word', 'term', 'label', 'category', 'emotion', 'behavior', 'resolution'],
};
const valueAt = (rec, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), rec);
export function mergeEligiblePair(store, a, b) {
  for (const f of (MERGE_DECISIVE[store] || [])) {
    const va = valueAt(a, f); const vb = valueAt(b, f);
    if (va === undefined || vb === undefined) continue;
    if (JSON.stringify(va) !== JSON.stringify(vb)) return { ok: false, why: '决定性字段不一致：' + f };
  }
  return { ok: true };
}

export function applyPlan(planRef, opts = {}) {
  try {
    const dry0 = opts.dry !== false;
    if (opts.production === true) {
      const blocked = productionForceRejected({ dry: dry0, force: opts.force === true });
      if (blocked) return { ok: false, error: blocked };
    }
    const plan = planRefLoad(planRef);
    if (!plan || !Array.isArray(plan.ops)) return { ok: false, error: '找不到可用计划：' + String(planRef) };
    const fileOf = (store) => (opts.files && opts.files[store]) || storePath(store);
    const dry = opts.dry !== false;
    const freshBasis = {};
    for (const store of STORES) { const { fp } = fingerprint(fileOf(store)); freshBasis[store] = fp; }
    const basisOk = JSON.stringify(freshBasis) === JSON.stringify(plan.basis);
    if (!dry && !basisOk && opts.force !== true) {
      return { ok: false, error: '计划指纹过期：计划生成后库被改动过——请重新生成计划（确要用 --force，并明白后果）' };
    }
    const only = opts.only ? String(opts.only) : null;
    const results = []; let retiredN = 0; let skippedN = 0; let refusedN = 0;
    // 2026-10-18（GPT③ ⑦ / 批量原子性）：批量中途失败时必须留下**部分回执**（旧实现直接抛到外层 catch ⇒
    //   0 回执、已应用的退役无法按回执撤销）。捕获后按"已发生的 ops"照常写回执，并标 partial/error。
    let loopError = null;
    try {
    for (const op of plan.ops) {
      if (!op || !op.op) continue;
      const touched = op.op === 'merge' ? [op.keep, ...(op.absorb || [])].filter(Boolean) : [op.id];
      if (only && !touched.includes(only)) {
        // F05（2026-10-14 外部审查 · GPT）：filtered 也必须带**稳定标识**——否则第二批回执无法与首批对齐，
        //   回执合并时丢墓碑 ⇒ after `only=A`、`only=B` 后 revoke 只恢复一批（原缺陷）。
        results.push({ op: op.op, store: op.store, status: 'filtered', ...(op.op === 'merge' ? { keep: op.keep ?? null, absorb: op.absorb || [] } : { id: op.id }) });
        continue;
      }
      if (op.op === 'merge') {
        if (op.needsHuman || op.keep == null) { results.push({ op: 'merge', store: op.store, keep: null, absorb: op.absorb || [], status: 'refused-needs-human', why: 'keep 判不了代际（R4）：人工指定后再执行' }); refusedN += 1; continue; }
        // Q02（GPT 第四轮）：**A 档守「keep 一字不动」**——非空 mergedText（模型/人工填写）**拒绝执行**；
        //   正文改写走独立 revise 通道（若需 B 档须另立启用条件与撤销/冲突语义，未开）。
        if (typeof op.mergedText === 'string' && op.mergedText.trim().length > 0) { results.push({ op: 'merge', store: op.store, keep: op.keep, absorb: op.absorb || [], status: 'refused-merged-text', why: 'A 档不支持正文改写（keep 一字不动）；请先 revise 正文、或另走 B 档设计' }); refusedN += 1; continue; }
        // V07：keeper 不是退役目标；整组先拒绝，不能执行到自吸收时才停、留下部分退役。
        if (Array.isArray(op.absorb) && op.absorb.includes(op.keep)) { results.push({ op: 'merge', store: op.store, keep: op.keep, absorb: op.absorb, status: 'refused-self-absorb', why: 'keep 不能出现在 absorb 中；请修正计划后重试' }); refusedN += 1; continue; }
        const recs = loadStore(op.store, fileOf(op.store)).records;
        const byId = new Map(recs.map((r) => [r.id, r]));
        if (isExemptRecord(byId.get(op.keep), op.keep)) { results.push({ op: 'merge', store: op.store, keep: op.keep, status: 'refused-exempt', why: 'keep 在豁免面（协议条/自我层）' }); refusedN += 1; continue; }   // 豁免优先（协议条即便不在库也先拒；复检修）
        const keepRec = byId.get(op.keep);
        if (!keepRec || !currentRecords(recs).some((r) => r.id === op.keep)) { results.push({ op: 'merge', store: op.store, keep: op.keep, absorb: op.absorb || [], status: 'refused-keep-missing', why: 'keep 不在当前集（已退役/已错删）——重生成计划' }); refusedN += 1; continue; }
        const detail = [];
        for (const id of op.absorb || []) {
          if (isExemptRecord(byId.get(id), id)) { detail.push({ id, status: 'refused-exempt', why: '豁免面' }); refusedN += 1; continue; }
          const el = mergeEligiblePair(op.store, keepRec, byId.get(id) ?? {});
          if (!el.ok) { detail.push({ id, status: 'refused-source-mismatch', why: el.why }); refusedN += 1; continue; }   // F04：执行侧同资格检查（防旧计划/手改计划绕过）
          const cur = currentRecords(recs).some((r) => r.id === id);
          if (!cur) { detail.push({ id, status: 'skipped', why: '不在当前集（已处理/已退役）' }); skippedN += 1; continue; }
          if (dry) { detail.push({ id, status: 'would-retire', reason: 'merged-into ' + op.keep }); continue; }
          const r = retireRecord(op.store, id, { reason: 'merged-into ' + op.keep + ' · plan ' + plan.planId, file: fileOf(op.store), extra: { sleep_plan_id: plan.planId, sleep_op_id: 'merge|' + op.store + '|' + op.keep } });
          detail.push({ id, status: r.already ? 'skipped' : 'retired', tombstone: r.tombstone ?? null });
          if (r.already) skippedN += 1; else retiredN += 1;
        }
        // N04（GPT 第三轮）：**来源集合保留**——absorb 的**新**来源并入 keep（revise 一次）——避免「合并后退役侧是
        //   唯一记录 ⇒ 该来源在检索面随退役丢失」（她场景：own-log 检索 1→0）。**来源去重**：与 keep 已有完全相同的
        //   source 不触发修订 ⇒ 常规近重复（同 ref）下 keep **仍一字不动**（守 A 档约定）。失败不阻断退役。
        let keepRev = null;
        if (!dry) {
          // Q01（GPT 第四轮）：**来源链并集**——被吸收者可能自己已有 `sources`（链式合并 B←C 后再 A←B）——
          //   只读 `r.source` 会丢掉 C。并集 = 逐条 [source, ...sources]（后面统一按来源身份去重）。
          // V06：来源也是合并结果，只接收本轮成功退役的候选；拒绝/跳过不能给 keep 增加证据。
          const absorbSrc = detail.filter((d) => d.status === 'retired').map((d) => byId.get(d.id)).filter(Boolean)
            .flatMap((r) => [r.source, ...(Array.isArray(r.sources) ? r.sources : [])]).filter(Boolean);
          if (absorbSrc.length) {
            try {
              const curS = [...new Map([keepRec.source, ...(Array.isArray(keepRec.sources) ? keepRec.sources : [])]
                .filter(Boolean).map((s) => [JSON.stringify(s), s])).values()];
              const seen = new Set(curS.map((s) => JSON.stringify(s ?? null)));
              const add = absorbSrc.filter((s) => { const k = JSON.stringify(s ?? null); if (seen.has(k)) return false; seen.add(k); return true; });
              if (add.length) {
                const patch = { sources: [...curS, ...add] };
                const rv = revise(op.store, op.keep, patch, { file: fileOf(op.store) });
                keepRev = rv.id;
              }
            } catch { /* 来源合并失败不阻断（回执 + 墓碑仍可追溯） */ }
          }
        }
        const applied = detail.some((d) => d.status === 'retired' || d.status === 'would-retire');
        results.push({ op: 'merge', store: op.store, keep: op.keep, absorb: op.absorb || [], keepRev, status: dry ? 'dry' : (applied ? 'applied' : 'skipped'), detail });
      } else if (op.op === 'discard') {
        const recs = loadStore(op.store, fileOf(op.store)).records;
        const rec = recs.find((r) => r.id === op.id);
        if (isExemptRecord(rec, op.id)) { results.push({ op: 'discard', store: op.store, id: op.id, status: 'refused-exempt', why: '豁免面' }); refusedN += 1; continue; }
        if (!rec || !currentRecords(recs).some((r) => r.id === op.id)) { results.push({ op: 'discard', store: op.store, id: op.id, status: 'skipped', why: '不在当前集' }); skippedN += 1; continue; }
        if (dry) { results.push({ op: 'discard', store: op.store, id: op.id, status: 'dry', reason: op.reason }); continue; }
        const r = retireRecord(op.store, op.id, { reason: String(op.reason || 'discard') + ' · plan ' + plan.planId, file: fileOf(op.store), extra: { sleep_plan_id: plan.planId, sleep_op_id: 'discard|' + op.store + '|' + op.id } });
        if (r.already) skippedN += 1; else retiredN += 1;
        results.push({ op: 'discard', store: op.store, id: op.id, status: r.already ? 'skipped' : 'applied', tombstone: r.tombstone ?? null });
      } else {
        results.push({ op: String(op.op), store: op.store, status: 'unknown-op' });
      }
    }
    } catch (e) { loopError = String((e && e.message) || e); }
    const receipt = { planId: plan.planId, appliedAt: new Date().toISOString(), dry, basisOk, force: opts.force === true, ...(loopError ? { error: loopError, partial: true } : {}), summary: { retired: retiredN, skipped: skippedN, refused: refusedN }, ops: results };
    let receiptFile = null;
    if (!dry) {
      receiptFile = opts.out || join(SLEEP_DEFAULTS.reportDir, 'sleep-apply-' + plan.planId + '.json');
      // 2026-10-14 复检修：回执**合并而非覆盖**——`--force` 重跑（全 skip）不得丢掉墓碑记录，否则 `--revoke` 失去依据。
      try {
        if (existsSync(receiptFile)) {
          const prev = JSON.parse(readFileSync(receiptFile, 'utf8'));
          if (Array.isArray(prev.ops)) {
            const keyOf = (o) => o.op + '|' + o.store + '|' + (o.keep ?? o.id);
            const prevByKey = new Map(prev.ops.map((o) => [keyOf(o), o]));
            for (const r of results) {
              const p = prevByKey.get(keyOf(r));
              if (!p) continue;
              if (p.tombstone && !r.tombstone) r.tombstone = p.tombstone;
              // R02（GPT 复核二轮）：merge 的**执行证据按 absorb 合并**——本批 filtered/skipped（无 detail 或缺项）时
              //   从旧回执继承 detail（含各自墓碑）；否则首批 tombstone 丢失、revoke 只恢复第二批（merge+merge 场景）。
              if (Array.isArray(p.detail)) {
                if (!Array.isArray(r.detail)) r.detail = p.detail.map((x) => ({ ...x }));
                else {
                  const dBy = new Map(r.detail.map((d) => [d.id, d]));
                  for (const pd of p.detail) { const cur = dBy.get(pd.id); if (cur) { if (pd.tombstone && !cur.tombstone) cur.tombstone = pd.tombstone; } else r.detail.push({ ...pd }); }
                }
              }
              for (const d of r.detail || []) {
                const pd = (p.detail || []).find((x) => x.id === d.id);
                if (pd && pd.tombstone && !d.tombstone) d.tombstone = pd.tombstone;
              }
            }
            receipt.firstAppliedAt = prev.firstAppliedAt || prev.appliedAt;
            // F05：**累计回执**——本批未触及的旧条目原样保留（不能因「没出现在本批结果里」而消失；
            //   两批 apply 的并集，保证 revoke 能看全历次成功证据）。
            const seen = new Set(receipt.ops.map((r) => keyOf(r)));
            for (const p of prev.ops) if (p.status !== 'filtered' && !seen.has(keyOf(p))) receipt.ops.push(p);
          }
        }
      } catch { /* 旧回执坏了就照新回执写 */ }
      writeFileAtomic(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
      for (const r of results) {
        const hit = r.status === 'applied' || (r.detail || []).some((d) => d.status === 'retired');
        if (!hit) continue;
        const ids = r.op === 'merge' ? r.keep : r.id;
        const note = r.op === 'merge'
          ? 'sleep --apply ' + plan.planId + '：' + (r.detail || []).filter((d) => d.status === 'retired').map((d) => d.id).join(', ') + ' → merged-into ' + r.keep
          : 'sleep --apply ' + plan.planId + '：' + r.id + '（' + (r.reason || 'discard') + '）';
        try { appendReviewLog({ store: r.store, id: ids, verdict: r.op === 'merge' ? '合并' : '退役', by: 'self', note }, { file: opts.reviewLog }); } catch { /* 审计失败不阻断（回执已在） */ }
      }
    }
    return { ok: !loopError, dry, receipt, receiptFile, ...(loopError ? { error: loopError } : {}) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

export function revokePlan(planRef, opts = {}) {
  try {
    const plan = planRefLoad(planRef);
    const planId = plan?.planId ?? String(planRef ?? '');
    if (!planId) return { ok: false, error: '需要计划（planId 或计划文件）' };
    const fileOf = (store) => (opts.files && opts.files[store]) || storePath(store);
    const rf = opts.receipt || join(SLEEP_DEFAULTS.reportDir, 'sleep-apply-' + planId + '.json');
    // R03（GPT 复核二轮）：墓碑是一级依据——回执缺失/失败时以库内墓碑重建。
    // N03/N07（GPT 第三轮）：**归属必须可核**——①新墓碑带结构化 `sleep_plan_id`，精确匹配；
    //   ②旧格式只认**锚定结尾** ` · plan <id>`（不再 includes 子串——`plan-` 前缀或说明文字提及不再误认领）；
    //   ③墓碑须对应计划中同库、同操作的**退役目标**（absorb/id），否则拒绝；④重建排除已撤销墓碑；
    //   ⑤去重按**墓碑 ID**（同一目标的新旧两枚墓碑各算一个事件，不再折成一个）；⑥回执 planId 必须匹配请求。
    let receipt = null;
    if (existsSync(rf)) { try { receipt = JSON.parse(readFileSync(rf, 'utf8')); } catch { receipt = null; } }
    if (receipt && receipt.planId !== undefined && String(receipt.planId) !== planId && opts.allowReceiptMismatch !== true) {
      return { ok: false, error: '回执与请求计划不匹配：回执 planId=' + String(receipt.planId) + '，请求 ' + planId + '（确要重放请显式 allowReceiptMismatch）' };
    }
    const targets = new Map();
    for (const op of plan?.ops || []) {
      if (!op || !STORES.includes(op.store)) continue;
      let ids; let opId; let legacyReason;
      if (op.op === 'merge' && typeof op.keep === 'string' && op.keep && Array.isArray(op.absorb)) {
        ids = op.absorb.filter((id) => id !== op.keep);
        opId = 'merge|' + op.store + '|' + op.keep;
        legacyReason = 'merged-into ' + op.keep + ' · plan ' + planId;
      } else if (op.op === 'discard' && typeof op.id === 'string' && op.id) {
        ids = [op.id];
        opId = 'discard|' + op.store + '|' + op.id;
        legacyReason = (String(op.reason || 'discard') + ' · plan ' + planId).trim();
      } else continue;
      for (const id of ids) {
        if (typeof id !== 'string' || !id) continue;
        const key = op.store + '|' + id;
        if (!targets.has(key)) targets.set(key, []);
        targets.get(key).push({ opId, legacyReason });
      }
    }
    // V07：回执与重建共用核验。结构化 plan/op 不匹配时不得退回文本匹配；旧墓碑只认该操作的完整 reason。
    const tombById = new Map();
    const recordById = new Map();
    const revokedTombs = new Set();
    for (const store of STORES) {
      const recs0 = loadStore(store, fileOf(store)).records;
      for (const r of recs0) {
        if (r.id) recordById.set(store + '|' + r.id, r);
        if (typeof r.revokes === 'string' && r.revokes) revokedTombs.add(store + '|' + r.revokes);
        if (typeof r.retires === 'string' && r.id) tombById.set(store + '|' + r.id, r);
      }
    }
    const tombOk = (store, tombId, targetId, receiptOpId) => {
      if (!STORES.includes(store) || typeof tombId !== 'string' || !tombId || typeof targetId !== 'string' || !targetId) return false;
      const t = tombById.get(store + '|' + tombId);
      // 三态：true=可撤；'missing'=引用不存在（**无恢复动作**，保留为如实 missing 报告）；false=拒绝（计划外/豁免/身份不符）。
      if (!t) return 'missing';
      if (t.retires !== targetId) return false;
      if (isExemptRecord(t, targetId) || isExemptRecord(recordById.get(store + '|' + targetId), targetId)) return false;
      const allowed = (targets.get(store + '|' + targetId) || []).filter((op) => receiptOpId === undefined || op.opId === receiptOpId);
      if (!allowed.length) return false;
      if (t.sleep_plan_id !== undefined || t.sleep_op_id !== undefined) {
        return t.sleep_plan_id === planId && allowed.some((op) => t.sleep_op_id === op.opId);
      }
      return allowed.some((op) => t.retired_reason === op.legacyReason);
    };
    const tombs = [];
    const have = new Set();
    const push = (e) => { const k = e.store + '|' + e.tombstone; if (!have.has(k)) { tombs.push(e); have.add(k); } };
    if (receipt) {
      for (const r of receipt.ops || []) {
        if (r.op === 'merge') for (const d of r.detail || []) if (d.tombstone) {
          const v = tombOk(r.store, d.tombstone, d.id, 'merge|' + r.store + '|' + r.keep);
          if (v === true) push({ store: r.store, tombstone: d.tombstone, id: d.id });
          else if (v === 'missing') push({ store: r.store, tombstone: d.tombstone, id: d.id, missingRef: true });   // 如实 missing（不谎报、不恢复）
        }
        if (r.op === 'discard' && r.tombstone) {
          const v = tombOk(r.store, r.tombstone, r.id, 'discard|' + r.store + '|' + r.id);
          if (v === true) push({ store: r.store, tombstone: r.tombstone, id: r.id });
          else if (v === 'missing') push({ store: r.store, tombstone: r.tombstone, id: r.id, missingRef: true });
        }
      }
    }
    for (const [key, r] of tombById) {
      if (revokedTombs.has(key)) continue;                                                         // N03/N07：已撤销墓碑不再认领
      const store = key.slice(0, key.indexOf('|'));
      if (tombOk(store, r.id, r.retires) !== true) continue;
      push({ store, tombstone: r.id, id: r.retires, rebuilt: true });
    }
    if (!tombs.length) return { ok: false, error: '找不到执行回执：' + rf + '，且库内无 plan ' + planId + ' 的有效墓碑可重建（仅撤销已执行过的合并）' };
    const dry = opts.dry !== false;
    const results = [];
    for (const t of tombs) {
      // missing 引用绝不进入 revokeRetire：后者还支持把输入当原 ID 再找墓碑，不能借此绕过上面的身份校验。
      if (t.missingRef) { results.push({ ...t, status: 'missing', record: null }); continue; }
      if (dry) { results.push({ ...t, status: 'would-revoke' }); continue; }
      const r = revokeRetire(t.store, t.tombstone, { file: fileOf(t.store), reason: 'sleep --revoke ' + planId });
      // 2026-10-14 整体复检修：墓碑已不在（被硬删等）时 revokeRetire 返回 revoked:null —— **不得谎报 'revoked'**（诚实报告）。
      results.push({ ...t, status: r.revoked ? (r.already ? 'already' : 'revoked') : 'missing', record: r.record ?? null });
    }
    const out = { planId, revokedAt: new Date().toISOString(), dry, count: tombs.length, results };
    let outFile = null;
    if (!dry) {
      outFile = opts.out || join(SLEEP_DEFAULTS.reportDir, 'sleep-revoke-' + planId + '.json');
      writeFileAtomic(outFile, JSON.stringify(out, null, 2) + '\n');
      for (const r of results) {
        if (r.status !== 'revoked') continue;
        try { appendReviewLog({ store: r.store, id: r.id, verdict: '回滚', by: 'self', note: 'sleep --revoke ' + planId + '：' + r.tombstone + ' 复位' }, { file: opts.reviewLog }); } catch { /* 同上 */ }
      }
    }
    return { ok: true, dry, revoke: out, outFile };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

const recallBrief = (sig) => ({
  misses: sig.misses, failureTurns: sig.failureTurns, recalledBefore: sig.recalledBefore,
  lateRecall: sig.lateRecall, missRate: sig.missRate, sessions: sig.sessions
});

/**
 * 历史回放（只读，wave2 B2 · §2.4.6 / §3.4.6）。
 * 同一份 hooks 日志原样再跑 recallSignals，并对照当时会生成的 sleep --plan。
 * 不写六库、不写计划文件、不动水位线。`--apply` / `revokes` 不在这里。
 *
 * 正确口径：分层系数、refute 隐藏、merge/discard 建议都不是 B2 的输入
 * （召回 = 日志里有过成功的查库动作，不看查中了哪条）。所以同一份日志再算，misses 不得上升。
 * 错误口径（记在 survivorBias 里，不采用）：把「点名的 id 全部落在将被 absorb/discard、或当前已 refute 的集合」
 * 的召回行从日志里删掉再数。那个数上升，只说明「假装这些查库没发生」会制造漏召——
 * 不能拿事后的 miss 率证明合并无害（幸存者偏差）。没点名 id 的查库行保留：无法证明它依赖被删条目。
 *
 * opts 同 sleepPlan（files / log / today / theta / maxOps / orphanDays / staleDays / now），
 * 另加 out：缺省或 false = 不落盘；字符串 = 只写这份回放 JSON（拒绝写到存储文件上）。
 */
export function replayHistory(opts = {}) {
  try {
    const logFile = opts.log || SLEEP_DEFAULTS.log;
    let buf = null;
    if (!existsSync(logFile)) buf = Buffer.alloc(0);
    else buf = readFileSync(logFile);
    const records = [];
    let bad = 0;
    for (const raw of buf.toString('utf8').split(/\r?\n/)) {
      if (!raw.trim()) continue;
      try { records.push(JSON.parse(raw)); } catch { bad += 1; }
    }
    const logFp = { bytes: buf.length, sha256: buf.length ? sha256(buf) : null, missing: !existsSync(logFile), lines: records.length, bad };

    const planned = sleepPlan({
      files: opts.files, log: logFile, today: opts.today, theta: opts.theta, maxOps: opts.maxOps,
      orphanDays: opts.orphanDays, staleDays: opts.staleDays, now: opts.now, out: false
    });
    if (!planned.ok) return planned;

    const removed = [];
    planned.plan.ops.forEach((op, i) => {
      if (op.op === 'discard') removed.push({ id: op.id, store: op.store, via: 'discard', reason: op.reason, op: i });
      else if (op.op === 'merge') for (const id of op.absorb) removed.push({ id, store: op.store, via: 'absorb', keep: op.keep, reason: op.reason, op: i });
    });

    const today = planned.plan.params.today;
    const refuted = [];
    for (const store of STORES) {
      const file = (opts.files && opts.files[store]) || storePath(store);
      const loaded = loadStore(store, file).records;
      const map = credibilityMap(store, loaded, { today });
      for (const [id, cred] of map) if (cred.refuted) refuted.push({ id, store });
    }
    refuted.sort((a, b) => (a.store < b.store ? -1 : a.store > b.store ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const gone = new Set([...removed.map((x) => x.id), ...refuted.map((x) => x.id)]);
    const biased = [];
    const dropped = [];
    const citations = [];
    for (const rec of records) {
      const ids = recordCitedIds(rec);
      const hit = ids.filter((id) => gone.has(id));
      if (hit.length && (rec.kind === 'usage' || isRecallRecord(rec))) {
        citations.push({ kind: rec.kind, ts: rec.ts ?? null, session: typeof rec.session === 'string' ? rec.session : null, ids: hit });
      }
      if (isRecallRecord(rec) && ids.length > 0 && ids.every((id) => gone.has(id))) {
        dropped.push({ ts: rec.ts ?? null, session: typeof rec.session === 'string' ? rec.session : null, tool: rec.tool ?? rec.akashaCli ?? null, ids });
        continue;
      }
      biased.push(rec);
    }

    const asRecorded = recallBrief(recallSignals(records));
    const replayed = recallBrief(recallSignals(records));
    const rewritten = recallBrief(recallSignals(biased));
    const delta = replayed.misses - asRecorded.misses;
    const biasDelta = rewritten.misses - asRecorded.misses;
    const rose = delta > 0;
    const fingerprint = {
      v: 1, log: logFp.sha256, missing: logFp.missing, planId: planned.plan.planId,
      asRecorded, replayed, rewritten,
      removed: removed.map((x) => x.id), refuted: refuted.map((x) => x.id)
    };
    const replayId = 'replay-' + sha256(JSON.stringify(fingerprint)).slice(0, 16);
    const report = {
      replayId, version: 1, mode: 'replay-only',
      createdAt: (opts.now instanceof Date ? opts.now : new Date()).toISOString(),
      log: { path: logFile, ...logFp },
      plan: { planId: planned.plan.planId, ops: planned.plan.ops.length, removed },
      recall: { asRecorded, replayed, delta, rose },
      layering: { refuted: refuted.length, ids: refuted.map((x) => x.id) },
      survivorBias: {
        method: 'drop-recall-lines-whose-cited-ids-are-all-removed',
        adopted: false,
        rewritten, delta: biasDelta, wouldRise: biasDelta > 0,
        droppedRecalls: dropped.length, dropped: dropped.slice(0, 20),
        citationCount: citations.length, citations: citations.slice(0, 20)
      },
      verdict: rose ? `misses 上升 ${delta}` : 'misses 不上升',
      note: '只读回放：日志与六库都未改。正确口径是同一份日志原样再数（分层 / 合并 / 丢弃建议不进 B2）。survivorBias 是对照用的错误口径，不作为验收。'
    };
    let reportFile = null;
    if (opts.out !== false && opts.out !== undefined && opts.out !== null) {
      if (typeof opts.out !== 'string') return { ok: false, error: 'out 须为路径或省略' };
      reportFile = opts.out;
      const stores = new Set(STORES.map((name) => resolve((opts.files && opts.files[name]) || storePath(name))));
      if (stores.has(resolve(reportFile))) return { ok: false, error: '拒绝把回放报告写到存储文件上：' + reportFile };
      mkdirSync(dirname(reportFile), { recursive: true });
      writeFileAtomic(reportFile, JSON.stringify(report, null, 2) + '\n');
    }
    return { ok: true, report, reportFile };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}
