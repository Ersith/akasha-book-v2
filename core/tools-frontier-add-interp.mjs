// frontier-add-interp.mjs —— 「看过即入基石」（2026-10-11 用户令）：把已看过的论文收入 frontier（基石）。
//   纪律：**证据级别必须标注**——本次全部为「检索级接触」（标题 + 摘要/片段，未逐篇精读）⇒ status=待验证、next_review=+90 天；
//   精读后再经 `frontier recheck` 升为 高引用/已复现/已实践。
import { appendRecord, currentRecords, loadStore } from 'file:///<AKASHA_DIR>/lib.mjs';

const TODAY = '2026-10-11';
const PLUS90 = '2027-01-09';   // 待验证默认 +90 天（与 CLI frontier recheck 口径一致）

const ENTRIES = [
  {
    id: 'front-llm-language-network-2024', year: 2024, topic: '机理可解释性',
    title: 'The LLM Language Network: A Neuroscientific Approach for Identifying Causally Task-Relevant Units',
    url: 'https://ar5iv.labs.arxiv.org/html/2411.02280',
    supports: ['因果任务相关单元的定位方法（神经科学式定位 + 消融验证）', '「脑区」类说法的学术对应物'],
    note: '检索级接触（标题 + 摘要/片段），未逐篇精读。出处：用户转述的网络评论核查（2026-10-11）。NAACL 2025。',
  },
  {
    id: 'front-mixture-cognitive-reasoners-2026', year: 2026, topic: '机理可解释性',
    title: 'Mixture of Cognitive Reasoners: Modular Reasoning with Brain-Like Specialization',
    url: 'https://ar5iv.labs.arxiv.org/html/2506.13331',
    supports: ['把「类脑功能特化」当作架构手段（模块化推理）', '「脑区」叙事被吸收进架构探索的直接证据'],
    note: '检索级接触；ICLR 2026（proceedings/2026/hash/1a596f50…）。原文 arXiv 2506.13331。出处：网络评论核查（2026-10-11）。',
  },
  {
    id: 'front-inducing-dyslexia-vlm-2026', year: 2026, topic: '机理可解释性',
    title: 'Inducing Dyslexia in Vision Language Models',
    url: 'https://ar5iv.labs.arxiv.org/html/2509.24597',
    supports: ['定向破坏某能力（消融/诱发障碍）看下游影响的标准手段', '能力可定位性的因果证据'],
    note: '检索级接触；ICLR 2026。出处：网络评论核查（2026-10-11）。',
  },
  {
    id: 'front-self-reference-epistemic-regime-2026', year: 2026, topic: '机理可解释性',
    title: 'Self-Reference as a Distinct, Causally Suppressed Epistemic Regime in Large Language Models: Geometry, Deception Circuits',
    url: 'https://zenodo.org/records/18982285/files/Alieksieienko_SelfReference__.pdf?download=1',
    supports: ['「自指处理」作为可定位机制（≠ 意识）', '反驳「模型有自我意识区域」这一滑移的关键对照'],
    note: '检索级接触（Zenodo 预印本，非同行评审）。**收录目的＝作为「概念滑移」的对照**：论文谈 self-reference / 认识论机制，不谈意识。',
  },
  {
    id: 'front-emotions-where-art-thou-2026', year: 2026, topic: '情绪与价值',
    title: 'Emotions Where Art Thou: Understanding and Characterizing the Emotional Latent Space of Large Language Models',
    url: 'https://ar5iv.labs.arxiv.org/html/2510.22042',
    supports: ['LLM 情绪隐空间的可表征性（支撑「情绪可被当作信号使用」的假设）', '与定价/情绪轴的对照'],
    note: '检索级接触；与既有情绪/价值线（定价 × 情绪）相关。出处：网络评论核查的顺带发现（2026-10-11）。',
  },
  {
    id: 'front-nine-emotion-centroids-2026', year: 2026, topic: '情绪与价值',
    title: 'Nine Emotion Centroids: A Label-Free Valence Axis That Transfers Across Four Modalities',
    url: 'https://browse-export.arxiv.org/pdf/2608.18090',
    supports: ['无标注 valence 轴、跨四模态迁移（与「效价/唤醒」两轴设计可对照）', '情绪维度可机械提取的证据'],
    note: '检索级接触（arXiv 2608.18090）。与 lexicon / pricing 的 valence×arousal 设计同族，值得精读对照。',
  },
];

const have = new Set(currentRecords(loadStore('frontier').records).map((r) => String(r.id)));
let n = 0;
for (const e of ENTRIES) {
  if (have.has(e.id)) { console.log('  跳过（已存在）：' + e.id); continue; }
  appendRecord('frontier', {
    ...e,
    status: '待验证',
    last_checked: TODAY,
    next_review: PLUS90,
    source: { type: '官方', ref: '网页检索（2026-10-11，用户转述评论的核查）' },
    event_time: TODAY,
  });
  n += 1;
  console.log('  + ' + e.id + '（' + e.topic + '）');
}
const after = currentRecords(loadStore('frontier').records);
console.log('新增 ' + n + ' 条；frontier 现行 = ' + after.length + '（待验证 ' + after.filter((r) => r.status === '待验证').length + '）');
