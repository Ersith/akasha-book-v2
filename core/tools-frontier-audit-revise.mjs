// 前沿层文献核对·修订批（2026-10-07）：把首轮核对的结论落成修订链 + 两条审计入库（幂等）。
// 幂等：修订以「核对标记」防重复；canon 以 id 存在性防重复。
// 用法：node akasha\tools\frontier-audit-revise.mjs
import { appendRecord, loadStore, currentRecords, revise } from './lib.mjs';

const MARK = '2026-10-07 核对';

const fixes = [
  {
    id: 'front-memory-for-autonomous-llm-agents-mechanisms-evaluation-and-emerg',
    patch: { url: 'https://arxiv.org/abs/2603.07670', year: 2026 },
    note: `${MARK}：HF 页对脚本不可达 → 改 arXiv 正源（abs 200，题名一致）。摘要核实：把 agent 记忆形式化为 write–manage–read 循环 + 三维分类（时间跨度 / 表征基底 / 控制策略）+ 五类机制（上下文压缩 / 检索增强存储 / 反思自改 / 分层虚拟上下文 / 策略学习管理）+ 评估与工程现实（写路径过滤、矛盾处理）。与本项目「六库 + 修订链」正面对照。`
  },
  {
    id: 'front-why-language-models-hallucinate',
    patch: { url: 'https://arxiv.org/abs/2509.04664' },
    note: `${MARK}：ar5iv 镜像偶发不可达 → 改 arXiv 正源（abs 200、题名一致；重试同证）。`
  },
  {
    id: 'front-abstentionbench-reasoning-llms-fail-on-unanswerable-questions-r1',
    patch: { url: 'https://arxiv.org/abs/2506.09038' },
    note: `${MARK}：ar5iv 镜像不可达 → 改 arXiv 正源（abs 200、题名一致）。`
  },
  {
    id: 'front-entry-2',
    patch: {},
    note: `${MARK}：标题为导入期占位（「示例文献」），载体 PsycNet 2004-13181-005（前瞻记忆 / 线索触发）；待换真实文献出处。`
  },
  {
    id: 'front-qca-deviant-case',
    patch: {},
    note: `${MARK}：原 CEU PDF 链接已失效（站点改版）；替代候选 = Rohlfing & Schneider 2013「Formalized Case Selection for Process Tracing after QCA」(zenodo.org/records/4589400)，待人工定夺换源。`
  }
];

const canonBatch = [
  {
    id: 'canon-frontier-audit-20261007',
    claim: '前沿层首轮文献核对（2026-10-07）：68 条当前版本逐条抓取原始 URL（tools/verify-frontier-urls.mjs，5 并发 / 30s 超时 / 标题相似度）——53 条脚本可达（其中标题相似度 ≥0.5 的强证一批；低相似多因页面为 PubMed 精简标题或中文标题对英文页,非错配）；7 条出版社反爬 403（ACM×2 / Wiley / Cambridge / Royal Society / T&F / Taylor&Francis——记录未证伪，DOI 可检索）；5 条站点对脚本不可达（arXiv 瞬时超时 1 条经重试可达；ERIC / CiNii / BBC / CEU 各 1 条：CiNii 与 BBC 经网页检索确认页面存在）；1 条 HF 页不可达但论文存在（已改 arXiv 正源）；2 条 ar5iv 镜像偶发超时（已改 arXiv 正源）；1 条占位标题（front-entry-2 待换源）；1 条链接失效（front-qca-deviant-case 替代源待定）。结论：**无「查无此文」的编造条目**；问题集中在链接可达性与少数元数据。证据：logs/frontier-url-audit-2026-10-06.json（+ -retry.json）。',
    source: { type: '复现', ref: 'tools/verify-frontier-urls.mjs 实跑 68/68 + 8 条重试（--only --seq --timeout=30000）+ web_fetch/web_search 复核 6 条；修订 5 条见各 -r 记录（2026-10-07）' },
    last_reviewed: '2026-10-07',
    tags: ['frontier', '文献核对', '审计']
  },
  {
    id: 'canon-frontier-usage-20261007',
    claim: '基石使用核查（2026-10-07）——已建机制 ↔ 支撑文献逐对核实（抓摘要）：①睡眠器 ← Sleep-time Compute（2504.13171：空闲期预计算，GSM/AIME 省约 5x 测试时算力；我们只做简化离线蒸馏，未复现实验）②弃权纪律 / 来源态 ← AbstentionBench（2506.09038：推理微调平均损害弃权 24pp、系统提示有助不根治）+ Language Models (Mostly) Know What They Know（2207.05221：模型自评自身知识边界）③羞耻定价 ← Calibrated Language Models Must Hallucinate（2311.14648：校准模型在长尾事实上必然产生一定幻觉——策略层价格设计的理论下限）④记忆管线对照 ← Mem0 / Zep / A-MEM（生产级管线 / 时序知识图谱 / 自组织链接，三条均可达）⑤镜像库 ← Moral Stories（2012.15738：规范 / 意图 / 后果的故事标注，可从叙事做行为归类）⑥总体设计对照 ← Memory for Autonomous LLM Agents 综述（2603.07670：write–manage–read + 五类机制，与六库设计互为镜像）。结论：六条主线机制均有可核实的文献支点；无「文献挂着但说不上支撑什么」的空挂。',
    source: { type: '复现', ref: 'web_fetch 逐条抓摘要（2026-10-06/07，含首轮复审两条）+ 与 dsh 侧实现逐对对照（research/ai-memory-architecture-20261006.md §4 地图）' },
    last_reviewed: '2026-10-07',
    tags: ['frontier', '基石使用', '对照']
  }
];

let rev = 0; let skip = 0;
for (const t of fixes) {
  const cur = currentRecords(loadStore('frontier').records).find((r) => r.id === t.id);
  if (!cur) { console.log('MISS  ', t.id); continue; }
  if ((cur.note || '').includes(MARK)) { console.log('skip  ', cur.id); skip++; continue; }
  const patch = { ...t.patch };
  if (t.note) patch.note = (cur.note ? cur.note + ' | ' : '') + t.note;
  const r = revise('frontier', cur.id, patch);
  console.log('revise', cur.id, '->', r.id);
  rev++;
}
for (const rec of canonBatch) {
  const existing = new Set(loadStore('canon').records.map((r) => r.id));
  if (existing.has(rec.id)) { console.log('skip  canon', rec.id); continue; }
  appendRecord('canon', rec);
  console.log('added canon', rec.id);
}
console.log(`\n文献核对修订：${rev} 条（skip ${skip}）；canon 审计条目按需追加`);
