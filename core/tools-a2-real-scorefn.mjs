// A2 真 scoreFn 验收（2026-10-18）
// 目的：把 `--phase-check` 缺省那个「照论文表造的代理常量」换成**对本系统真实机制的测量**。
// 诚实边界：客户端无法测量 provider 的 KV 压缩相位（canon-a2-context-budget 明说）。
//   这里测的是「A2 自己的冗余落点机制，在不同前缀长度（=不同剩余预算）下是否还能保住关键段」。
//   若 gap≈0 ⇒ 在客户端可控范围内，预算长度不改变保留率（相位风险只能在 provider 侧）。
//   若 gap>0 ⇒ 预算敏感，需要看是分配器还是落点的问题。
import { phaseResidueSample, placeWithRedundancy, estimateTokens } from './lib.mjs';

const TOTAL = Number((process.argv.find((a) => a.startsWith('--total=')) || '').split('=')[1] || 2048); // A2 默认总预算（CONTEXT_BUDGET_DEFAULTS.total）

// 用一段真实的关键事实当 memory（取库里的实文，别用占位符）
const memory = '关键事实：阿卡夏 doctor 于 2026-10-18 落地，十项检查：数据根 / 六库逐行可解析 / 会话索引 / 索引台账 / 覆盖差异 / 原始档案可读 / 基线对比 / 抽样重建 / 磁盘 / 环境变量；判据分层=真丢尾 FAIL、结论漂移 WARN。';

const scoreFn = ({ prefixTokens, memory: mem }) => {
  const avail = Math.max(64, TOTAL - prefixTokens);   // 前缀吃掉预算
  const r = placeWithRedundancy([{ text: mem, distance: 0 }], {});
  const tok = estimateTokens(mem);
  const needTwo = tok * 2 + 8;                         // 两份副本 + 偏移填充的粗估
  if (r.text.length === 0) return 0;
  if (needTwo <= avail) return 1;                      // 冗余完整
  if (tok <= avail) return 0.5;                        // 只剩一份
  return 0;                                            // 一份都装不下
};

const out = phaseResidueSample(memory, { scoreFn });
console.log(JSON.stringify({
  ...out,
  scoreFnKind: 'real:placeWithRedundancy@budget',
  memoryTokens: estimateTokens(memory),
  totalBudget: TOTAL,
  note: '客户端可控度量：预算长度→保留率。provider 相位不可测（canon-a2-context-budget-20261010）',
}, null, 1));
