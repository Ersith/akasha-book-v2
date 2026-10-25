// M3 · conservative recency-intent gate for time ranking.
// Only explicit temporal/status phrases count; bare technical substrings do not.
export const RECENT_CUES = [
  /最近(?!邻)/,
  /最新(?:进展|状态|情况|版本|消息|动态|审计|结果|修复|更新)/,
  /当前(?:状态|情况|进展|版本|进度)/,
  /目前(?:状态|情况|进展|进度)/,
  /现在(?:的)?(?:状态|情况|进展|怎么样|如何)/,
  /今天|昨天|刚刚/,
  /本周|这周|本月|近况/,
  /进展到哪|做到了?哪|到哪一步了/,
  /截止(?:到|目前|今天|现在)/,
  /现阶段/,
  /还在不在|修好了吗|完成了吗|上线了吗/,
  /还有什么没做/,
];

const DEFINITIONAL = /(?:是什么意思|什么意思|怎么解释|定义是什么|词义)/;
const NEGATED_TIME = /(?:不要|别|不用|无需|不按|不要按|忽略|不看).{0,16}(?:最新|最近|当前|时间|时效).{0,12}(?:排序|优先|调整|排)/;

/** High-precision cue classifier; default is none, never inferred from data. */
export function classifyTimeIntent(query) {
  const text = typeof query === 'string' ? query : '';
  if (DEFINITIONAL.test(text)) return { kind: 'none', source: 'definitional', matched: [] };
  if (NEGATED_TIME.test(text)) return { kind: 'none', source: 'negated', matched: [] };
  const matched = RECENT_CUES.filter((re) => re.test(text)).map((re) => re.source);
  return { kind: matched.length ? 'recent' : 'none', source: matched.length ? 'cue' : 'default', matched };
}

/** explicit: auto | recent | none. Explicit recent can override the classifier. */
export function resolveTimeIntent(query, explicit = 'auto') {
  if (!['auto', 'recent', 'none'].includes(explicit)) throw new TypeError('time intent 必须是 auto/recent/none');
  if (explicit === 'recent') return { kind: 'recent', source: 'explicit', matched: [] };
  if (explicit === 'none') return { kind: 'none', source: 'explicit', matched: [] };
  return classifyTimeIntent(query);
}
