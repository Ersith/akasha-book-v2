// 阿卡夏之书会话层插件 v0.2（@akasha-book/session）—— 自动增量索引 + 压缩事件行 + 节奏条 + 循环观测 P0（dry）。
//   · 核心逻辑归 ~/.akasha/session.mjs（插件只做调度与注入；降级只留痕，不炸宿主）
//   · 观测线（hooks.jsonl）：session-armed / session-index / session-index-skip / session-index-error / session-compact
//     + 循环观测（P0 干跑，2026-10-07）：loop-watch / loop-watch-probe —— **只观测、绝不干预**（不 steer / 不 cancel / 不注入）
//       实时面＝`agent/assistant-stream` 帧（现役 v4 格式；`assistant/chunk` 为 V0 遗物，仅兼容保留）
//   · 条子：systemPrompt.context（akasha:session，order 134）；无内容静默
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { IndexProcess } from './index-process.mjs';

export const inject = ['systemPrompt', 'timer'];

// 默认值：家目录（~/.akasha）；sessionsRoot 按你的宿主实际会话档案目录配置。
// 库根：`AKASHA_DIR` 环境变量 → 家目录下的 .akasha（2026-10-10：一处配置贯通 log/store/meta）。
const ENV_AKASHA = typeof process.env.AKASHA_DIR === 'string' && process.env.AKASHA_DIR.trim() !== '' ? process.env.AKASHA_DIR.trim() : null;
const AKASHA_HOME = ENV_AKASHA ? (ENV_AKASHA === '~' ? homedir() : (ENV_AKASHA.startsWith('~/') || ENV_AKASHA.startsWith('~\\') ? join(homedir(), ENV_AKASHA.slice(2)) : ENV_AKASHA)) : join(homedir(), '.akasha');
const DEFAULTS = {
  log: join(AKASHA_HOME, 'logs', 'hooks.jsonl'),
  akashaDir: AKASHA_HOME,
  sessionsRoot: join(homedir(), '.dsh', 'sessions'),
  storeFile: join(AKASHA_HOME, 'data', 'session.jsonl'),
  metaFile: join(AKASHA_HOME, 'data', 'session-meta.json'),
  minIndexIntervalMs: 30000,
  timerCheckMs: 240000,
  contextOrder: 134,
  loopWatch: true,
  watchMinChars: 200,
  watchCheckEvery: 480,
  indexMode: 'worker',          // 'worker'（独立子进程）| 'inline'（仅显式配置）
  workerRespawnMs: 15000
};

// ── 占位符守卫（2026-10-19 发布面 P0）──────────────────────────────
// OSS 的 `cordis.patch.yml` 用 `<AKASHA_DIR>` / `<LOCAL_PATH>` 作示例字面量；照抄不改时字面量
// **优先于** AKASHA_DIR 默认值 ⇒ 索引/节奏条静默指向不存在的库。这里明确抛错（fail closed）。
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
  // 2026-10-19（审计 B）：环境变量路线要一起设防——AKASHA_DIR='<AKASHA_DIR>' 时此前 fail-open。
  const envVal = process.env.AKASHA_DIR;
  if (typeof envVal === 'string' && envVal.trim() !== '') {
    const m = envVal.match(PLACEHOLDER_TOKEN);
    if (m) hits.push({ field: 'AKASHA_DIR(环境变量)', token: m[0] });
  }
  if (!hits.length) return;
  const fields = [...new Set(hits.map((h) => h.field))].join('、');
  throw new Error(
    `akasha-session: 配置里还有未替换的占位符 ${hits[0].token}（${fields}）。` +
    '请先把 cordis.patch.yml 里的 <AKASHA_DIR> / <LOCAL_PATH> 改成你的实际路径；' +
    '或删掉这些字段，改用 AKASHA_DIR 环境变量。' +
    '（宁可启动失败，也不静默降级——照抄占位符会让会话索引指向不存在的库。）'
  );
}

/** 去抖判定（纯函数）。 */
export function shouldIndex(lastIndexedAt, now, minMs) {
  return !Number.isFinite(lastIndexedAt) || lastIndexedAt <= 0 || now - lastIndexedAt >= minMs;
}

/** 自适应节流（纯函数）：档案 >16MB 时节流 ×4（防大会话增长后每次触发阻塞宿主）。 */
export function effectiveThrottle(size, baseMs) {
  return size > 16 * 1024 * 1024 ? baseMs * 4 : baseMs;
}

/** 压缩后补索引失败时的原因短语（给节奏条用；未知原因如实写「未确认」）。 */
const COMPACT_FAIL_REASON = {
  'not-found': '未找到会话档案',
  backoff: '近期索引失败、处于背压窗口',
  error: '索引出错',
  'no-session': '事件缺会话 id'
};

/**
 * 格式密度分档（纯函数，2026-10-15 归因三轮产物）：加粗标记密度（`**` 数/千字）→ 档位。
 * 依据：全库 70 会话——峰值密度 >190 的两个会话是全库唯二失稳会话；>40 失衡出现；<15 干净区。
 * 阈值初值（可校准）：绿 <15 · 黄 15-40 · 橙 40-120 · 红 >120。
 */
export function densityTag(rate) {
  const r = Number(rate) || 0;
  if (r < 15) return '绿';
  if (r < 40) return '黄';
  if (r < 120) return '橙';
  return '红';
}

/**
 * 节奏条渲染（纯函数）：段数/会话数 + 回看提示 + 格式密度行；压缩窗口内追一行。无数据 → null（静默）。
 * B1（2026-10 wave1）：只有「最近一次压缩的补索引确认成功」（compacts[i].indexed === true）才可说「已收入」；
 * 失败 / 未确认（含旧格式条目无 indexed 字段）一律改说「可能未进会话层」并给回退路径——提示行不得替索引作伪证。
 * 密度行（2026-10-15）：state.density = { rate, tag, rounds }；**本行刻意不含任何加粗标记**（防止观测行自身喂密度）。
 */
export function renderSessionLine(state, now) {
  const sessions = state?.meta?.sessions ?? {};
  const ids = Object.keys(sessions);
  if (!ids.length) return null;
  let segments = 0;
  for (const id of ids) segments += Number(sessions[id]?.segments ?? 0);
  if (!segments) return null;
  const lines = [`小阿卡夏·会话层：已索引 ${segments} 段（${ids.length} 会话）；回看用 node akasha.mjs session lookup <词>`];
  const d = state?.density;
  if (d && Number.isFinite(d.rate) && Number(d.chars ?? 0) >= 2000) {
    lines.push(`📊 格式密度 ${Number(d.rate).toFixed(1)}/千字（${d.tag}区 · 近 ${d.rounds} 轮）｜分级：黄≥15 橙≥40 红≥120｜高位时降格式负载：少用加粗、多用分段与编号`);
  }
  const compacts = (state?.compacts ?? []).filter((c) => Number.isFinite(c?.ts) && now - c.ts <= 10 * 60 * 1000);
  if (compacts.length) {
    const last = compacts[compacts.length - 1];
    // N2（2026-10-17）：meta 的键是**裸 uuid**，而压缩条目记的是带 `session-` 前缀的原始 id ⇒
    //   原来精确查找永远落空，那截「已索引 N 段」后缀从来没出现过。这里按归一化 id 找。
    const metaSessions = state?.meta?.sessions ?? {};
    const want = String(last?.session ?? '').replace(/^session-/, '');
    const s = metaSessions[last?.session]
      ?? metaSessions['session-' + want]
      ?? Object.entries(metaSessions).find(([k]) => String(k).replace(/^session-/, '') === want)?.[1];
    const counts = s ? `（该会话已索引 ${Number(s.segments ?? 0)} 段 · 结论 ${Number(s.conclusions ?? 0)} 条）` : '';
    if (last?.indexed === true) {
      // N1（2026-10-17）：这行说的是"已收入"，不该挂 ⚠（⚠ 只留给真失败，否则两类信息混在一起）。
      lines.push(`· 近期发生压缩（${compacts.length} 次）——本段历史已收入会话层${counts}；细节查 akasha_session_lookup`);
    } else {
      // 2026-10-17：区分「排队中」与「真失败」——压缩后索引是**异步投递**的，下一条消息渲染时可能还没落地
      //   （实测：compact 13:07:38 → index 13:07:40 成功）。原来两者共用一句"未成功"，读者无法区分。
      const queued = last?.reason === 'queued' || last?.reason === 'debounced';
      if (queued && now - (last?.ts ?? 0) < 60 * 1000) {
        lines.push(`· 近期发生压缩（${compacts.length} 次）——补索引已排队，通常几秒内落地；若 1 分钟后仍未落地，回看请查原始会话档案（akasha session index <会话id>）`);
      } else {
        const why = COMPACT_FAIL_REASON[last?.reason] ?? '补索引未确认';
        lines.push(`⚠ 近期发生压缩（${compacts.length} 次），但压缩后补索引未成功（${why}）——这段历史可能未进会话层；` +
          `勿凭会话层断言「查无此事」，回看请查原始会话档案，或手动 node akasha.mjs session index <会话id>`);
      }
    }
  }
  return lines.join('\n');
}

/** N4（2026-10-17）：**纯函数版改判**，供自测直接用（不必起完整插件）。
 *  把 compacts 里与该会话匹配、且尚未 indexed 的条目改判为已收入；返回被改判的条目。
 *  - id 比较**形式无关**（两边都剥 `session-` 前缀）——这正是 h8 修的那个洞；
 *  - 已 `indexed:true` 的**不重复改**（幂等）。 */
export function settleCompactsIn(compacts, sid) {
  const n = String(sid ?? '').replace(/^session-/, '');
  const hit = [];
  for (const c of compacts ?? []) {
    if (String(c?.session ?? '').replace(/^session-/, '') !== n) continue;
    if (c.indexed === true) continue;
    c.indexed = true; c.reason = 'recovered'; hit.push(c);
  }
  return hit;
}

/** 循环观测 P0（dry）：chunk 归类——真值对 @deepseek-ai/dsh-llm StreamChunk（text-delta / reasoning-delta / tool-call-delta）。 */
export function classifyChunk(chunk) {
  const t = chunk?.type;
  if (t === 'reasoning-delta') return { stream: 'reasoning', text: String(chunk.text ?? '') };
  if (t === 'text-delta') return { stream: 'text', text: String(chunk.text ?? '') };
  if (t === 'tool-call-delta') return { stream: 'tool', name: String(chunk.name ?? '') };
  return null;
}

/** 流式节流（纯函数）：累计 ≥ minChars 且距上次检查 ≥ every 才查。 */
export function shouldCheckStream(bufferedLen, lastCheckedLen, every, minChars) {
  return bufferedLen >= minChars && bufferedLen - lastCheckedLen >= every;
}

/** 命中摘要（纯函数）：exact > variant > punct 取最强未报类型；hitSet 去重；摘录 ≤60。 */
export function summarizeWatch(result, stream, atChars, hitSet, phase = 'stream') {
  const order = [['exact', result?.exact?.[0]], ['variant', result?.variant?.[0]], ['punct', result?.punctRuns?.[0]]];
  for (const [type, hit] of order) {
    if (!hit) continue;
    if (hitSet?.has(type)) continue;
    if (hitSet) hitSet.add(type);
    const excerpt = String(typeof hit === 'string' ? hit : hit.excerpt ?? '').slice(0, 60);
    const extra = (typeof hit === 'object' && hit.count) ? { count: hit.count } : {};
    return { phase, stream, atChars, hit: { type, excerpt, ...extra } };
  }
  return null;
}

export function apply(ctx, config = {}) {

  // A/B 实验开关（2026-10-10 用户解冻，见 docs/ab-experiment-design.md §6）：
  // abOff=true ⇒ **关闭臂**——本插件不注册任何守卫/注入/工具，只记一行观测；库文件与日志照旧（便于事后复盘）。
  if (config.abOff === true) {
    try { (ctx.logger?.info ?? (() => {}))('session: abOff=true（A/B 关闭臂）——本插件不注册任何面'); } catch { /* 静默 */ }
    return;
  }
  assertNoPlaceholders(config);
  const cfg = { ...DEFAULTS, ...config };
  const require_ = createRequire(import.meta.url);
  const core = () => require_(join(cfg.akashaDir, 'session.mjs'));

  const log = (record) => {
    try {
      mkdirSync(dirname(cfg.log), { recursive: true });
      appendFileSync(cfg.log, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', 'utf8');
    } catch { /* 观测线写不了不拖垮宿主 */ }
  };

  const readMeta = () => { try { return JSON.parse(readFileSync(cfg.metaFile, 'utf8')); } catch { return null; } };

  // 事件循环延迟采样（2026-10-07，观测用；unref 不拖住进程）：每秒 tick 偏差 ≈ 采样期阻塞。
  let loopLastTick = Date.now();
  let loopLagMs = 0;
  const loopTimer = setInterval(() => {
    const now = Date.now();
    loopLagMs = Math.max(0, now - loopLastTick - 1000);
    loopLastTick = now;
  }, 1000);
  if (typeof loopTimer.unref === 'function') loopTimer.unref();

  // 每会话去抖（进程内；重启后首触发即补跑，不丢段）。
  const lastIndexedAt = new Map();
  // 档案快照（size + mtimeMs）：两者都相同 ⇒ 没有新字节，跳过重读；**只在索引成功后记账**（失败可重试）。
  const lastStat = new Map();
  // 统一失败背压（未命中 / 链接失败 / 执行失败：窗口内静默，不重复扫 + 不重复报错；含宿主模块代缓存场景）。
  const lastFailAt = new Map();
  const FAIL_BACKOFF_MS = 5 * 60 * 1000;

  // 压缩事件窗口（进程内近况；重启后清空——只影响提示行，不影响数据）。
  const compacts = [];

  // ---------- 循环防护 P0（dry 干跑观测，受控解冻） ----------
  // 红线：只观测、只写 hooks 观测线；绝不 steer / cancel / 注入。
  const watchEnabled = cfg.loopWatch !== false;
  const watchBuf = new Map();      // `${sid}:${attempt}:${index}:${stream}` -> { text, seen, lastChecked, done, hit:Set }
  const watchProbe = new Map();    // sid -> Set(帧/chunk 类型；前 8 个各记一行，防真值漂移）
  const watchTurnDone = new Set(); // `${sid}:${turn}` 去重
  // 观测线去重（2026-10-15，P1 标定巡检）：同一逻辑事件的多帧（多 attempt / 多 index 前缀）各命中一次时，
  //   落线只记首报 ⇒ `${sid}:${stream}` 已报过即不再落线。**只影响观测线**（不碰 buf.done 判定）；
  //   turn 相命中另带 `src:'turn'` 标来源，供下游把"流已报 + 回合全量复检再报"当同一事件去重。
  const watchStreamHit = new Set();
  // 格式密度窗口（2026-10-15，归因三轮产物）：sid -> { rounds: [{c,b,turn}], ts }（近 10 轮滚动）。
  //   只观测：每轮把本回合 reasoning+text 的加粗标记密度推进窗口，节奏条显示档位 + hooks 落 density 线。
  //   整轮累计（turnAcc）：首验修正——密度口径＝**整轮所有 assistant 消息之和**（对齐分析脚本 r2g/r2h 口径）。
  const densityWin = new Map();
  const turnAcc = new Map(); // `${sid}:${turn}` -> { c, b }
  const DENSITY_WINDOW = 10;
  // 上下文长度代理（2026-10-14 追加；用户令「这个要加」）：自**上次压缩完成**以来本会话累计的流字符数。
  //   只记录、不干预；真实 KV 相位不可由宿主观测，代理仅作离线分析变量（P1 阈值标定用）。无压缩记录时＝自会话开始累计。
  const watchCtxChars = new Map(); // sid -> 累计流字符
  const ctxCharsOf = (sid) => watchCtxChars.get(sid) ?? 0;
  const attemptTurns = new Map();  // attemptId -> {turn, step}（chunk 帧不带 turn/step，start 帧带——2026-10-07 复查）
  const lastAssistant = new Map(); // sid -> {turn, message}（事件流缓存；官方 Session 无同步读者可用）
  const watchLoopCore = () => require_(join(cfg.akashaDir, 'loop-detect.mjs'));

  const probeType = (sid, tag) => {
    const seen = watchProbe.get(sid) ?? new Set();
    if (seen.has(tag) || seen.size >= 8) return;
    seen.add(tag);
    watchProbe.set(sid, seen);
    log({ kind: 'loop-watch-probe', session: sid, type: tag, ctxChars: ctxCharsOf(sid) });
  };

  const feedStreamChunk = (sid, turn, step, keyPrefix, cls) => {
    watchCtxChars.set(sid, (watchCtxChars.get(sid) ?? 0) + cls.text.length); // 上下文长度代理：所有非工具流字符一律累计（只记不裁）
    if (watchCtxChars.size > 256) watchCtxChars.delete(watchCtxChars.keys().next().value);
    const key = `${keyPrefix}:${cls.stream}`;
    let buf = watchBuf.get(key);
    if (!buf) {
      buf = { text: '', seen: 0, lastChecked: 0, done: false, hit: new Set() };
      watchBuf.set(key, buf);
      if (watchBuf.size > 64) {
        let victim = null;
        for (const [k, v] of watchBuf) { if (v.done) { victim = k; break; } } // 优先淘汰已收工的（收口点复核 F2）
        watchBuf.delete(victim ?? watchBuf.keys().next().value);
      }
    }
    if (buf.done) return;
    buf.text += cls.text;
    buf.seen += cls.text.length; // 单调累计：缓冲截尾不影响节流（复核 F1——饱和后尾段仍继续检查）
    if (buf.text.length > 20000) buf.text = buf.text.slice(buf.text.length - 20000);
    if (!shouldCheckStream(buf.seen, buf.lastChecked, cfg.watchCheckEvery, cfg.watchMinChars)) return;
    buf.lastChecked = buf.seen;
    const res = watchLoopCore().detectLoops(buf.text.slice(-8000), { window: 100, blockCount: 3, maxWindows: 9000 });
    const sum = summarizeWatch(res, cls.stream, buf.seen, buf.hit);
    if (sum) {
      buf.done = true;
      // 观测线去重（2026-10-15 首版；**同日复检修正**）：目标是「同一 turn 内的多帧/多 attempt 命中只落首报」。
      //   首版键为 `${sid}:${stream}`（整会话一刀切）——**复检发现会严重欠报**（一个会话的 stream 命中只会剩 1-2 条，
      //   P1 标定的样本量会被砍掉大半）；修正为含 turn ⇒ 同轮去重、跨轮各自落线。
      const dedupKey = `${sid}:${cls.stream}:${turn ?? '?'}`;
      if (!watchStreamHit.has(dedupKey)) {
        if (watchStreamHit.size > 200) watchStreamHit.delete(watchStreamHit.keys().next().value);
        watchStreamHit.add(dedupKey);
        log({ kind: 'loop-watch', session: sid, turn, step, ctxChars: ctxCharsOf(sid), ...sum });
      }
    }
  };

  // V0 遗物兼容：`assistant/chunk` 事件（现役 v4 格式不再发此事件；字段面保留，防旧宿主）。
  const onChunk = (session, event) => {
    const sid = String(session?.id ?? '');   // Q06：完整原始 ID（不剥前缀）
    const chunk = event?.data?.chunk;
    if (!sid || !chunk || typeof chunk.type !== 'string') return;
    probeType(sid, chunk.type);
    const cls = classifyChunk(chunk);
    if (!cls || cls.stream === 'tool') return;
    feedStreamChunk(sid, event?.data?.turn ?? null, event?.data?.step ?? null, `${sid}:${event?.data?.turn ?? '?'}:${chunk.index ?? 0}`, cls);
  };

  // 现役格式：`agent/assistant-stream` 进程内瞬态帧（真值对 dsh-agent-loop AssistantStreamAttempt 与 dsh-headless 消费口径）。
  // frame：{type:'start'|'chunk'|'end', attemptId, turn, step, chunk?}；chunk：text-delta/reasoning-delta/tool-call-delta/block-*/usage/finish。
  const onStreamFrame = (agent, frame) => {
    const sid = String(agent?.session?.id ?? agent?.id ?? '');   // Q06：完整原始 ID（不剥前缀）
    const frameType = String(frame?.type ?? '');
    if (!sid || !frameType) return;
    probeType(sid, frameType + (frame?.chunk?.type ? '/' + frame.chunk.type : ''));
    const attemptId = String(frame?.attemptId ?? '');
    if (frameType === 'start') { // start 帧带 turn/step；chunk 帧不带（2026-10-07 复查）→ 缓存供补全
      attemptTurns.set(attemptId, { turn: frame?.turn ?? null, step: frame?.step ?? null });
      if (attemptTurns.size > 64) attemptTurns.delete(attemptTurns.keys().next().value);
      return;
    }
    if (frameType === 'end') { attemptTurns.delete(attemptId); return; }
    if (frameType !== 'chunk') return;
    const cls = classifyChunk(frame.chunk);
    if (!cls || cls.stream === 'tool') return;
    const meta = attemptTurns.get(attemptId) ?? {};
    feedStreamChunk(sid, meta.turn ?? frame?.turn ?? null, meta.step ?? frame?.step ?? null, `${sid}:${attemptId || '?'}:${frame.chunk?.index ?? 0}`, cls);
  };

  // 格式密度：把本轮 reasoning+text 的字符/加粗推进窗口，返回滚动值（纯计算，无副作用之外只写内存与观测线）。
  const updateDensity = (sid, chars, bold, turn) => {
    if (!sid || !chars) return null;
    const w = densityWin.get(sid) ?? { rounds: [] };
    w.rounds.push({ c: chars, b: bold, turn: turn ?? null });
    if (w.rounds.length > DENSITY_WINDOW) w.rounds.splice(0, w.rounds.length - DENSITY_WINDOW);
    w.ts = Date.now();
    densityWin.set(sid, w);
    if (densityWin.size > 64) densityWin.delete(densityWin.keys().next().value);
    const C = w.rounds.reduce((s, x) => s + x.c, 0);
    const B = w.rounds.reduce((s, x) => s + x.b, 0);
    const rate = C ? (B / C) * 1000 : 0;
    const out = { session: sid, turn: turn ?? null, rate: Math.round(rate * 10) / 10, tag: densityTag(rate), chars: C, bold: B, rounds: w.rounds.length };
    log({ kind: 'density', ...out });
    return out;
  };
  const latestDensity = () => {
    let best = null;
    for (const [sid, w] of densityWin) if (!best || w.ts > best.w.ts) best = { sid, w };
    if (!best) return null;
    const C = best.w.rounds.reduce((s, x) => s + x.c, 0);
    const B = best.w.rounds.reduce((s, x) => s + x.b, 0);
    const rate = C ? (B / C) * 1000 : 0;
    return { rate: Math.round(rate * 10) / 10, tag: densityTag(rate), rounds: best.w.rounds.length, chars: C };
  };

  const rememberAssistant = (session, event) => {
    const sid = String(session?.id ?? '');   // Q06：完整原始 ID（不剥前缀）
    if (!sid) return;
    lastAssistant.set(sid, { turn: event?.data?.turn ?? null, message: event?.data?.message });
    if (lastAssistant.size > 64) lastAssistant.delete(lastAssistant.keys().next().value);
    // 整轮密度累计（2026-10-15 首验修正）：首版只统计「该轮最后一条消息」⇒ 与分析口径（整轮所有消息）不一致，
    //   且样本小易被 2000 门槛挡掉（实测轮 7：单条 1394ch vs 整轮 12666ch）。此处按 (sid,turn) 累计每条 assistant/message 的
    //   reasoning+text 字符与 ** 匹配数；onTurnWatch 消费并清除。
    const turn = event?.data?.turn;
    const msg = event?.data?.message;
    if (turn == null || !msg) return;
    let c = 0, b = 0;
    for (const blk of (msg.content ?? [])) {
      if (blk?.type !== 'reasoning' && blk?.type !== 'text') continue;
      const t = String(blk.text ?? '');
      c += t.length; b += (t.match(/\*\*/g) ?? []).length;
    }
    if (!c) return;
    const k = `${sid}:${turn}`;
    const acc = turnAcc.get(k) ?? { c: 0, b: 0 };
    acc.c += c; acc.b += b;
    turnAcc.set(k, acc);
    if (turnAcc.size > 128) turnAcc.delete(turnAcc.keys().next().value);
  };

  // turn 环：全文检测。取数＝事件流缓存（2026-10-07 复查：官方 Session 无 .events 属性，
  // 同步读者 snapshotEvents/ownEvents 已被官方弃用「新调用禁止」——宿主容器改事件驱动，插件不得伸手进日志）。
  const onTurnWatch = (sidIn, turn) => {
    const sid = String(sidIn ?? '');   // Q06：完整原始 ID（不剥前缀）
    const key = `${sid}:${turn ?? '?'}`;
    if (!sid || watchTurnDone.has(key)) return;
    const cached = lastAssistant.get(sid);
    if (!cached?.message) return;
    if (turn != null && cached.turn !== turn) return; // 缓存尚未到该回合（等 turn/end 兜底）
    watchTurnDone.add(key);
    if (watchTurnDone.size > 200) watchTurnDone.delete(watchTurnDone.keys().next().value);
    const message = cached.message;
    let dChars = 0, dBold = 0;
    // 密度口径（整轮，2026-10-15 首验修正）：优先用 turnAcc（本回合全部 assistant 消息累计）；
    //   无累计时退回「本消息」口径（旧行为，兼容边缘路径）。
    const accKey = `${sid}:${turn ?? '?'}`;
    const acc = turnAcc.get(accKey);
    if (acc) {
      dChars = acc.c; dBold = acc.b;
      turnAcc.delete(accKey);
    } else {
      for (const stream of ['reasoning', 'text']) {
        const text = (message.content ?? []).filter((b) => b?.type === stream).map((b) => String(b.text ?? '')).join('');
        dChars += text.length;
        dBold += (text.match(/\*\*/g) ?? []).length;
      }
    }
    for (const stream of ['reasoning', 'text']) {
      const text = (message.content ?? []).filter((b) => b?.type === stream).map((b) => String(b.text ?? '')).join('');
      if (text.length < 120) continue;
      const res = watchLoopCore().detectLoops(text, {});
      const sum = summarizeWatch(res, stream, text.length, new Set(), 'turn');
      if (sum) log({ kind: 'loop-watch', session: sid, turn: turn ?? null, phase: 'turn', src: 'turn', stream, chars: text.length, ctxChars: ctxCharsOf(sid), hit: sum.hit });
    }
    try { updateDensity(sid, dChars, dBold, turn); } catch { /* 观测不拖垮宿主 */ }
  };

  // 某会话索引成功 → 该会话窗口内「补索引未确认」的压缩条目改记为已收入（档案是全量的，后补成功即真收入）。
  // 2026-10-17 修（告警虚警）：**两处 id 形式不一致** —— `session-compact` 记的是宿主原始 id（带 `session-` 前缀），
  //   而 worker 回传的 `msg.session` 是裸 uuid（实测 logs/hooks.jsonl：compact=`session-d6c6c428-…` / index=`d6c6c428-…`）。
  //   原来用 `c.session === sid` 精确相等 ⇒ 永远匹配不上 ⇒ 12-10 分钟窗口内一直显示"补索引未成功"，
  //   而实际上 2 秒后索引就成功了（同类日志：13:07:40 added 2 / frameFails 0）。
  //   修法：比较前两边都剥掉 `session-` 前缀（形式无关）；命中就落一条 `session-compact-settled` 观测线。
  const normSid = (v) => String(v ?? '').replace(/^session-/, '');
  const childSkipped = new Set();   // 子代理会话（裸 uuid 目录）：每个只记一条 skip 线
  const settleCompacts = (sid, trigger) => {
    const hit = settleCompactsIn(compacts, sid);   // 纯函数（可直测，见文件头导出）
    for (const c of hit) {
      c.recoveredBy = trigger;
      log({ kind: 'session-compact-settled', session: c.session, by: trigger });   // 观测线：证明"后补成功"真的改判了
    }
  };

  // 索引每任务独立进程；失败只记账并退避，绝不自动回宿主执行。
  const workerUrl = new URL('./index-worker.mjs', import.meta.url);
  let worker = null;
  const workerMode = cfg.indexMode === 'inline' ? 'inline' : 'worker';
  let quitting = false;
  let jobSeq = 0;
  const pendingJobs = new Map(); // id -> { sid, trigger, extra, hostMs, stat }

  const queueDepth = () => pendingJobs.size;

  const onWorkerMessage = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') { log({ kind: 'session-worker', event: 'ready', node: msg.node, pid: msg.pid, isolation: msg.isolation }); return; }
    if (msg.type === 'queued') { log({ kind: 'session-worker', event: 'queued', session: msg.session, depth: msg.depth, running: msg.running }); return; }
    if (msg.type === 'bye') { log({ kind: 'session-worker', event: 'bye', processed: msg.processed }); return; }
    if (msg.type === 'process-exit') { log({ kind: 'session-worker', event: 'process-exit', pid: msg.pid, code: msg.code, signal: msg.signal }); return; }
    if (msg.type !== 'result') return;
    const p = pendingJobs.get(msg.id);
    if (!p) return;
    pendingJobs.delete(msg.id);
    if (msg.superseded) return;
    const extra = p?.extra ?? {};
    if (msg.error) {
      lastFailAt.set(normSid(msg.session), Date.now());
      log({ kind: 'session-index-error', session: msg.session, trigger: msg.trigger, message: msg.error, workerMs: msg.ms, hostMs: p?.hostMs ?? null, via: 'worker' });
      return;
    }
    if (p?.stat) lastStat.set(normSid(msg.session), { size: p.stat.size, mtimeMs: p.stat.mtimeMs }); // 只记成功：失败后同档可重试
    log({ kind: 'session-index', session: msg.session, trigger: msg.trigger, turn: extra.turn ?? null, added: msg.added, skipped: msg.skipped, parseFails: msg.parseFails, frameFails: msg.frameFails ?? 0, ms: msg.ms, hostMs: p?.hostMs ?? null, lagMs: loopLagMs, via: 'worker', pid: msg.pid, isolation: 'process' });
    if (msg.ms > 1500) log({ kind: 'session-index-slow', session: msg.session, trigger: msg.trigger, ms: msg.ms, lagMs: loopLagMs, added: msg.added, via: 'worker' });
    // 弧线树 v0.3 自动建树（2026-10-12）：索引成功后按「签名未变即复用 + 10 分钟节流」自建，结果落 tree-auto 线。
    //   机械、无 LLM；全保真仍走 ptr 回原档（节点带 children/treeFingerprint，旧代留档）。
    try {
      const ab = core().autoBuildTree({ session: msg.session, storeFile: cfg.storeFile, minIntervalMs: 600000 });
      log({ kind: 'tree-auto', session: msg.session, trigger: msg.trigger, built: ab.built, reason: ab.reason, treegen: ab.treegen ?? null, nodes: ab.nodes ?? null, segCount: ab.segCount ?? null, via: 'worker-host' });
    } catch (e) {
      log({ kind: 'tree-auto-error', session: msg.session, trigger: msg.trigger, message: e.message });
    }
    settleCompacts(msg.session, msg.trigger);
  };

  function spawnWorker() {
    if (workerMode !== 'worker' || worker || quitting) return;
    worker = new IndexProcess(workerUrl);
    log({ kind: 'session-worker', event: 'spawn', pid: process.pid, isolation: 'process', pending: queueDepth() });
    worker.on('message', msg => { try { onWorkerMessage(msg); } catch (error) { log({ kind: 'session-worker-error', event: 'callback', message: String(error?.message ?? error).slice(0,300) }); } });
  }
  spawnWorker(); // 只创建轻量队列；子进程按任务启动，完成即退出。

  const dispatchIndex = (sid, file, trigger, extra, opts, st) => {
    if (workerMode !== 'worker') return { queued: false };
    const id = ++jobSeq;
    const t0 = Date.now();
    try {
      spawnWorker();
      if (!worker || quitting) throw new Error('index queue unavailable');
      const pending = { sid, trigger, extra, hostMs: 0, stat: st };
      pendingJobs.set(id, pending);
      worker.postMessage({ type: 'index', id, job: { akashaDir: cfg.akashaDir, session: sid, file, storeFile: cfg.storeFile, metaFile: cfg.metaFile, trigger, full: !!opts.full } });
      pending.hostMs = Date.now() - t0;
      return { queued: true, hostMs: pending.hostMs };
    } catch (error) {
      pendingJobs.delete(id);
      lastFailAt.set(normSid(sid), Date.now());
      log({ kind: 'session-index-error', session: sid, trigger, via: 'worker', message: String(error?.message ?? error).slice(0,300) });
      return { queued: false };
    }
  };

  /**
   * 返回索引结论（B1）：{ ok:true, reason:'indexed'|'unchanged' } = 档案内容已在会话层；
   * { ok:false, reason:'no-session'|'backoff'|'not-found'|'error' } = 没收进去；
   * { ok:null, reason:'debounced' } = 去抖跳过（不作结论）。opts.force（压缩路径）绕过去抖与失败背压。
   */
  const indexNow = (sidIn, trigger, extra = {}, opts = {}) => {
    const sid = String(sidIn ?? ''); // 完整原始宿主 ID：inline/worker/compaction 共用此入口，读端仅精确匹配。
    try {
      if (!sid) return { ok: false, reason: 'no-session' }; // 空 id：静默跳过（正常路径不出现；见 README 降级节）
      const now = Date.now();
      if (!opts.force && now - (lastFailAt.get(normSid(sid)) ?? 0) < FAIL_BACKOFF_MS) return { ok: false, reason: 'backoff' }; // 失败背压：窗口内静默（N3：键统一归一化）
      // 2026-10-17：先问"带类型"的解析器——子代理会话用**裸 uuid 目录**（无 session- 前缀），
      //   原实现只拼 'session-<id>' ⇒ 对子代理恒 not-found，每回合刷一条错误（今日 5 条全是它）。
      const arc = typeof core().resolveSessionArchive === 'function' ? core().resolveSessionArchive(cfg.sessionsRoot, sid) : null;
      const file = arc?.file ?? core().resolveSessionFile(cfg.sessionsRoot, sid);
      if (!file) { lastFailAt.set(normSid(sid), now); log({ kind: 'session-index-notfound', session: sid, trigger, message: '未找到会话档案（无档案可索引；2026-10-23 原记 session-index-error，实测 152 次全为此因。GPT 审查：不得复用 session-index-skip——那个 kind 已被 unchanged/去抖占用）' }); return { ok: false, reason: 'not-found' }; }
      if (arc?.child) {
        // 认得出，但**不入小阿卡夏**：子代理转录是"派出去的活"，不是我的会话（也不该占段数/污染检索）。
        //   每个子代理只记一条 skip 观测线，避免刷屏。
        const k = normSid(sid);
        if (!childSkipped.has(k)) { childSkipped.add(k); log({ kind: 'session-index-skip-child', session: sid, trigger }); }
        return { ok: false, reason: 'child' };
      }
      lastFailAt.delete(normSid(sid));
      let st = null;
      try { st = statSync(file); } catch { /* stat 失败 → 走全量 */ }
      if (!opts.force && !shouldIndex(lastIndexedAt.get(normSid(sid)) ?? 0, now, effectiveThrottle(st?.size ?? 0, cfg.minIndexIntervalMs))) {
        log({ kind: 'session-index-skip', session: sid, trigger, sinceMs: now - (lastIndexedAt.get(sid) ?? 0) });
        return { ok: null, reason: 'debounced' };
      }
      // 设计：去抖标记先置位——索引失败后 30s 内不重试（错误背压）；统一失败窗口见 lastFailAt
      lastIndexedAt.set(normSid(sid), now);   // N3：这三个 map 统一用**归一化键**（worker 回调写的是裸 uuid）
      // 廉价快路：字节与 mtime 都没变 → 没有新内容，跳过重读（省一次全量解压）
      if (st) {
        const prev = lastStat.get(normSid(sid));
        if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
          log({ kind: 'session-index-skip', session: sid, trigger, reason: 'unchanged' });
          settleCompacts(sid, trigger);
          return { ok: true, reason: 'unchanged' };
        }
      }
      const t0 = Date.now();
      const disp = dispatchIndex(sid, file, trigger, extra, opts, st);
      if (disp.queued) {
        // 宿主只投递（v0.4）：结果由 worker 回传，落地线条在 onWorkerMessage
        return { ok: null, reason: 'queued', hostMs: disp.hostMs };
      }
      if (workerMode !== 'inline') return { ok: false, reason: 'error' };
      // 只有用户显式配置 indexMode:inline 才使用同步路径。
      const r = core().indexSession({ file, session: sid, storeFile: cfg.storeFile, metaFile: cfg.metaFile });
      if (st) lastStat.set(normSid(sid), { size: st.size, mtimeMs: st.mtimeMs }); // 只记成功：失败后同档可重试
      const dur = Date.now() - t0;
      log({ kind: 'session-index', session: sid, trigger, turn: extra.turn ?? null, added: r.added, skipped: r.skipped, parseFails: r.parseFails, frameFails: r.frameFails ?? 0, ms: dur, lagMs: loopLagMs, via: 'inline' });
      if (dur > 1500) log({ kind: 'session-index-slow', session: sid, trigger, ms: dur, lagMs: loopLagMs, added: r.added, via: 'inline' }); // >1.5s 告警线（2026-10-07 补4）
      settleCompacts(sid, trigger);
      return { ok: true, reason: 'indexed', added: r.added };
    } catch (error) {
      const msg = String(error?.message ?? error);
      const hint = /not yet fully loaded|does not provide an export named|Cannot find module/.test(msg) ? '（疑似宿主模块代缓存——重启桌面端后恢复）' : '';
      lastFailAt.set(normSid(sid), Date.now());
      log({ kind: 'session-index-error', session: sid, trigger, message: (msg + hint).slice(0, 300) });
      return { ok: false, reason: 'error' };
    }
  };

  // 触发面：回合结束（durable）+ 空闲追平 + 定时兜底 + 压缩信号（compaction/end 真值；2026-10-07 复查）。
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'turn/end') indexNow(String(session?.id ?? ''), 'turn-end', { turn: event?.data?.turn ?? null });
      else if (event?.type === 'compaction/end' && event?.data?.error === void 0) {
        const sid = String(session?.id ?? '');   // Q06：完整原始 ID（不剥前缀）
        watchCtxChars.set(sid, 0); // 上下文长度代理归零（相位基准＝最近一次压缩；只记录）
        // 先索引再宣称「已收入」（2026-10 复查）；B1（wave1）：宣称与否取决于索引结论——
        // 压缩是稀有且关键的时刻，force 绕过去抖/背压强制补一次；失败如实记 indexed:false，节奏条不说「已收入」。
        const res = indexNow(sid, 'compaction', {}, { force: true }) ?? { ok: false, reason: 'error' };
        const indexed = res.ok === true;
        compacts.push({ session: sid, ts: Date.now(), indexed, reason: res.reason });
        if (compacts.length > 20) compacts.splice(0, compacts.length - 20);
        log({ kind: 'session-compact', session: sid, indexedFirst: true, indexed, reason: res.reason });
      }
    } catch { /* 静默 */ }
  });
  ctx.on('agent/status', (payload) => {
    try { if (payload?.status === 'idle') indexNow(String(payload?.agent?.id ?? ''), 'idle'); } catch { /* 静默 */ }
  });
  if (watchEnabled) {
    ctx.on('agent/assistant-stream', (payload) => {
      try { onStreamFrame(payload?.agent, payload?.frame); } catch { /* 观测不拖垮宿主 */ }
    });
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type === 'assistant/chunk') onChunk(session, event);
        else if (event?.type === 'assistant/message') rememberAssistant(session, event);
        else if (event?.type === 'turn/end') onTurnWatch(String(session?.id ?? ''), event?.data?.turn ?? null);
      } catch { /* 观测不拖垮宿主 */ }
    });
    ctx.on('agent/turn-stopping', (payload) => {
      try { onTurnWatch(String(payload?.agent?.session?.id ?? payload?.agent?.id ?? ''), payload?.turn ?? null); } catch { /* 静默 */ }
    });
  }

  if (typeof ctx.interval === 'function') {
    try {
      const stop = ctx.interval(() => { try { for (const sid of [...lastIndexedAt.keys()]) indexNow(sid, 'timer'); } catch { /* 静默 */ } }, cfg.timerCheckMs);
      ctx.effect(() => () => { try { stop(); } catch { /* 静默 */ } });
    } catch (e) { log({ kind: 'session-degraded', event: 'timer-register-failed', message: String(e?.message ?? e).slice(0, 200) }); }   // 2026-10-15（plugins S6）：原为静默 catch ⇒ 降级无观测线
  } else {
    log({ kind: 'session-degraded', event: 'timer-unavailable', note: 'ctx.interval 不可用 ⇒ 定时补索引停用' });   // 同族：另一条静默降级路径也补上观测线
  }

  // 退出协议（v0.4）：通知 worker drain 后关闭；5s 未退则强杀。
  ctx.effect(() => () => {
    quitting = true;
    try { worker?.postMessage({ type: 'quit' }); } catch { /* ignore */ }
    const w = worker;
    const t = setTimeout(() => { try { w?.terminate(); } catch { /* ignore */ } }, 5000);
    if (typeof t.unref === 'function') t.unref();
  });

  // 条子：每回合一行（无内容静默）。
  ctx.systemPrompt.context({
    name: 'akasha:session',
    order: cfg.contextOrder,
    text: () => {
      try { return renderSessionLine({ meta: readMeta(), compacts, density: latestDensity() }, Date.now()) ?? ''; }
      catch { return ''; }
    }
  });

  log({ kind: 'session-armed', pid: process.pid, minIndexIntervalMs: cfg.minIndexIntervalMs, timerCheckMs: cfg.timerCheckMs, contextOrder: cfg.contextOrder, loopWatch: watchEnabled, watchMinChars: cfg.watchMinChars, watchCheckEvery: cfg.watchCheckEvery });
}
