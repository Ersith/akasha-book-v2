// akasha/loop-detect.mjs
// 空转/思考环检测器（2026-10-07，受控解冻第十五次；机械代理，纯函数）
// 方法论：Circular Reasoning（2601.05693，语义重复先于文本重复）→ bigram Jaccard 近重复；
//        RADAR（2609.38817，异常先于重复）→ 输出前置信号而非只抓末端标点串；
//        dsh-thinking-loop-guard（MIT，2026-08）→ 归一化 + 滑动窗口块重复（window 100 / count 3）为基线参数。
export function normalize(s) {
  return String(s ?? '')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[，。；、：:！？!?…—–－\-—~〜·,.()（）【】\[\]《》<>"'“”‘’「」『』`|/\\]+/gu, '');
}

export function bigrams(s) {
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 词级 bigram（空格语言用；2026-10-12 英文盲区修复——中文无空格由字级 bigram 承担，英文靠这条）。
 *  取「相邻两个纯字母词」拼成一个键（如 `the|pipeline`）；无词序列则空。 */
export function wordBigrams(raw) {
  const out = new Set();
  const words = String(raw ?? '').toLowerCase().match(/[a-z][a-z0-9'-]*/g) ?? [];
  for (let i = 0; i + 1 < words.length; i += 1) out.add(words[i] + '|' + words[i + 1]);
  return out;
}

/** 双门槛窗口合格线（2026-10-12 起）：
 *  - 多样性：字级 bigram ≥10 种（原线保留）；
 *  - 脚本门槛：**中文线** CJK ≥20%（原线）**或 字母线** `[A-Za-z]` ≥50%（纯英文/低 CJK 文本 ⇒ 旧版整段失明，本批修）。
 *  反侧不破：星号分隔线 / 纯符号碎片在两条线下都不合格（无字母、无 CJK）。 */
export function windowGate(s) {
  const bgs = bigrams(s);
  if (bgs.size < 10) return null;
  let cjk = 0, let2 = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk += 1;
    else if (/[A-Za-z]/.test(ch)) let2 += 1;
  }
  if (cjk / s.length >= 0.2) return 'cjk';
  if (let2 / s.length >= 0.5) return 'letters';
  return null;
}

/** 集合并（词级 + 字级；英文用两路，中文实际以字级为主）。 */
export function mixedBigrams(normWindow, rawWindow) {
  const out = bigrams(normWindow);
  for (const g of wordBigrams(rawWindow)) out.add(g);
  return out;
}

/** 代码态标记（2026-10-12 复检）：窗口里 CJK 极少而 ASCII 扎堆 ⇒ 「像代码/路径/参数」。
 *  用途＝**分级展示**（不改变检出）：基线与历史都证明「代码重述」是良性重复的一大来源，
 *  与「散文/推理原地打转」不是一回事——标出来，让人一眼分辨该不该管。 */
export function looksLikeCode(s) {
  if (!s.length) return false;
  let cjk = 0;
  for (const ch of s) if (/[\u4e00-\u9fff]/.test(ch)) cjk += 1;
  return cjk / s.length < 0.10;
}

/** 标点/冒号连排 ≥ minRun（现症末端形态兜底；先于归一化统计）。
 *  **不含空白**（2026-10-07 复查：原字符类含 `\s` ⇒ markdown 列表 `：\n  -` 被误判为标点串，
 *  阿巴阿巴试用 5 条命中全为误报——列表符号链不应成"标点串"。 */
export function punctRuns(raw, minRun = 6) {
  const out = [];
  const re = new RegExp(`[：:—–－\\-=~〜、，。；？！.,;?!]{${Math.max(4, Number(minRun) || 6)},}`, 'gu');
  for (const m of String(raw ?? '').matchAll(re)) {
    const run = m[0];
    if (/[：:—–－]/.test(run)) out.push(run.slice(0, 40));
  }
  return out;
}

/**
 * 重复标点串过滤（2026-10-15，P1 判据收紧）：同串出现 ≥2 次才入列，并按首现顺序输出。
 *  背景：P0 命中里 punct 类占 25%，抽查全为「良性单次串」（表格/标题/论文式破折号）——
 *  单次出现是**合法长串**，不是环；只有同一串重复出现才构成"原地打转"的最小证据。
 *  ⚠️ 刻意不做「连续行内三连」加严：采样计数（如每 0.5s 一行 `——：` 进度条）是**正常用法**，
 *  会伤害合法长任务；病态与否交给 P1 候选的「60s 窗口 ≥3 次」时间聚集判据 + 人工判读。
 */
export function punctDupRuns(raw) {
  const counts = new Map(); // key（前 40 字）→ 次数
  const order = [];         // 首现顺序
  for (const run of punctRuns(raw)) {
    if (!counts.has(run)) order.push(run);
    counts.set(run, (counts.get(run) ?? 0) + 1);
  }
  const runs = order.filter((r) => (counts.get(r) ?? 0) >= 2);
  const repeats = {};
  for (const r of runs) repeats[r] = counts.get(r);
  return { runs, counts: repeats };
}

/**
 * detectLoops(text, opts) -> { exact, variant, punctRuns, punctRepeats, stats }
 *  exact：归一化后 window 字滑窗出现 ≥ blockCount 次（块重复）；
 *  variant：相距 ≥ 2×window 的两窗 Jaccard ≥ sim（变体重复，≈语义近似代理）；
 *  punctRuns：**重复**标点串（原文本统计，同串出现 ≥2 次才入列——2026-10-15 收紧：
 *    原判据单次出现即报 ⇒ 良性标点串（表格/标题/分隔）占 P0 命中 25%，掩盖真信号）；
 *  punctRepeats：串 → 出现次数（随 punctRuns 同步，供阈值标定）。
 */
export function detectLoops(text, { window = 100, blockCount = 3, sim = 0.85, step = 1, cap = 60000, maxWindows = 12000, maxVariantPairs = 240 } = {}) {
  // step=1（2026-10-07 修：奇周期循环在步长 2 采样下相邻重复对不可见——turn 环自检首跑即踩中）。
  // 覆盖上限 = step × maxWindows ≈ 12K 归一字符，且**优先保留尾部**（循环随时间升级；更长文本请分段）。
  // 2026-10-12 起：**英文盲区已修**——窗口合格线改双门槛（CJK ≥20% 或 字母 ≥50%），相似度集合并入词级 bigram。
  const raw = String(text ?? '');
  const { runs: puncts, counts: punctRepeats } = punctDupRuns(raw);
  const norm = normalize(raw).slice(0, cap);
  const n = norm.length;
  const exact = [];
  const variant = [];
  let windows = 0;
  if (n >= window) {
    // 窗口合格性：多样性 ≥10 种 bigram + 脚本门槛（CJK ≥20% 或 字母 ≥50%）——过滤星号分隔线 / 代码碎片。
    //  2026-10-12 英文盲区修复：原线只有 CJK 门槛 ⇒ 纯英文整段失明；现改双门槛，并把**词级 bigram** 并入相似度集合。
    const wins = [];
    const gates = new Set();
    for (let i = n - window; i >= 0; i -= step) { // 尾优先收集（上限截断时保尾部）
      const s = norm.slice(i, i + window);
      const g = windowGate(s);
      if (!g) continue;
      gates.add(g);
      wins.push({ at: i, s, bgs: mixedBigrams(s, s) });
      if (wins.length >= maxWindows) break;
    }
    windows = wins.length;
    const count = new Map();
    for (const w of wins) count.set(w.s, (count.get(w.s) ?? 0) + 1);
    for (const [s, c] of count) if (c >= blockCount) exact.push({ count: c, excerpt: s.slice(0, 60), codeLike: looksLikeCode(s) });
    const stride = wins.length > 600 ? 7 : wins.length > 200 ? 3 : 1;
    const sample = wins.filter((_, idx) => idx % stride === 0).slice(0, maxVariantPairs).sort((a, b) => a.at - b.at);
    const bgs = sample.map((w) => w.bgs);
    for (let i = 0; i < sample.length; i += 1) {
      for (let j = i + 1; j < sample.length; j += 1) {
        if (sample[j].at - sample[i].at < window * 2) continue;
        if (jaccard(bgs[i], bgs[j]) >= sim) variant.push({ atA: sample[i].at, atB: sample[j].at, excerpt: sample[i].s.slice(0, 60) });
      }
    }
    return {
      exact,
      variant: variant.slice(0, 10),
      punctRuns: puncts,
      punctRepeats,
      stats: { chars: raw.length, normChars: n, windows, gate: gates.size === 1 ? [...gates][0] : (gates.size ? 'mixed' : null) }
    };
  }
  return {
    exact,
    variant: variant.slice(0, 10),
    punctRuns: puncts,
    punctRepeats,
    stats: { chars: raw.length, normChars: n, windows, gate: null }
  };
}
