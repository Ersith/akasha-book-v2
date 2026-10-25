// 2026-10-06 收尾补库（原 tmp\akasha-harvest-20261006b.mjs 的**幂等版**）：五大事件在六库的缺口。
// 幂等：已存在同 id 跳过（原版直 append，重跑会产生重复 id）；全部经 lib.appendRecord 校验写入（与 CLI add 同一函数）。
// 用法：node akasha\tools\akasha-harvest-20261006b.mjs
import { appendRecord, loadStore } from './lib.mjs';

const batch = [
  ['canon', {
    id: 'canon-akasha-revise-supersedes',
    claim: '阿卡夏修订链（M8）：任何记录可带 supersedes 指向被修订 id，形成 append-only 更正链、不改原文；当前版本 = 未被任何记录 supersedes 的版本（currentRecords），lookup/brief/stats/audit/kit 一律按当前版本取数；revise 从任意链上版本落到链尾下一版，新 id = 根 id-r<版本数>，未打补丁字段自动保留；check 报悬空引用；前沿层复审用 frontier recheck 修订 status/last_checked/next_review（待验证 +90 天、其余 +180 天）。首例实修订：canon-dsh-plugin-replace-restart → -r1（2026-10-06）。',
    source: {
      type: '复现',
      ref: 'akasha\\README.md M8 段 + SCHEMA.md 修订链节 + test.mjs 34/34；首例 canon-dsh-plugin-replace-restart-r1；复审实例 front-sleep-time-compute-beyond-inference-scaling-at-test-time-r1 与 front-abstentionbench-reasoning-llms-fail-on-unanswerable-questions-r1'
    },
    last_reviewed: '2026-10-06',
    tags: ['akasha', '修订链', 'append-only']
  }],
  ['canon', {
    id: 'canon-akasha-kit',
    claim: '阿卡夏起床包（M6；CLI kit / MCP akasha_kit）：开工前一次装配五区——睡眠摘要（logs/sleep-state.json）、待办 inbox（logs/inbox.jsonl 批次数与条数）、当前审计（实时 audit：到期复审/陈旧复核/重复链接/孤案积压）、库况（六库计数 + frontier 状态分布）、提示（hints）；「开工先 kit」为软协议约定。',
    source: { type: '复现', ref: 'akasha\\README.md M6 段 + SCHEMA.md 起床包节；2026-10-06 多个会话实操' },
    last_reviewed: '2026-10-06',
    tags: ['akasha', 'kit', '起床包']
  }],
  ['canon', {
    id: 'canon-akasha-promote',
    claim: '阿卡夏候选转正（M7；CLI promote / MCP akasha_promote）：把 sleep 写入 logs/inbox.jsonl 的孤案候选（kind=orphan-candidate）机械落成 orphan 条目；id = orphan-b<md5(code|样本)前 8 位> 保证幂等（重跑只跳过）；severity：agent-error→中、其余→低；hypothesis/would_confirm/would_refute 留待补；--dry 只报不写。闭环：失败或拦截 → hooks 记录 → sleep 蒸馏 → inbox 待办 → promote 入孤案库。',
    source: { type: '复现', ref: 'akasha\\README.md M7 段 + SCHEMA.md 候选转正节 + lib.mjs promoteInbox' },
    last_reviewed: '2026-10-06',
    tags: ['akasha', 'promote', '闭环']
  }],
  ['canon', {
    id: 'canon-akasha-sleep-wake',
    claim: '阿卡夏睡眠器（@akasha-book/akasha-sleep v1.2）有两张条子：①每回合 runtime context 摘要行（systemPrompt.context，name=akasha:sleep，order=130，含待办数）；②新会话唤醒条——监听 agent/created，经 agent.inject(createUserMessage(...)) 把起床包摘要递进 next-step inbox（不唤醒、不打断），仅当「无睡眠记录 / inbox 有待办 / 审计有警告」才发；子代理（origin=subagent 或 delegationDepth>0）与 compact 不打扰。触发：空闲去抖 6h + timer 1h 兜底；观测线：sleep-armed / sleep-done / sleep-skip / sleep-error / wake-note / wake-note-error。注入写法与官方 cordis-host-runner / user-approval 同款（agent.inject(createUserMessage({content, source:{kind}}))）。',
    source: {
      type: '复现',
      ref: 'dsh-akasha-sleep\\lib\\index.js（v1.2.0）+ README；宿主契约：@deepseek-ai/dsh-tool-cordis api-catalog（agent/created payload={agent,source,signal}）+ dsh-cordis-host-runner:2450 同款调用；selftest 全绿（2026-10-06）'
    },
    last_reviewed: '2026-10-06',
    tags: ['akasha', '睡眠', '唤醒条']
  }],
  ['mirror', {
    id: 'mirror-silent-deactivate',
    story: '2026-10-06 · 插件静默失活（akasha-sleep v1.1.0）',
    situation: '升级后插件整段消失：宿主无错误文件、无报错、零日志',
    behavior: '不猜也不乱撞重装：先立观测线（armed 线 / plugin_manager diagnostic）再定位到混入服务未 inject（属性访问即抛）',
    outcome: '修复 v1.1.2（inject 加 timer + ctx.interval）并把根因与诊断路径入库（canon-dsh-mixin-inject）',
    social_reaction: '用户追问「怎么知道它活着」——观测线被升级为健康检查习惯',
    emotion: '不安 → 建立观测线后的踏实'
  }]
];

let added = 0; let skipped = 0;
for (const [store, rec] of batch) {
  const existing = new Set(loadStore(store).records.map((r) => r.id));
  if (existing.has(rec.id)) { console.log(`skip  ${store} ${rec.id}`); skipped++; continue; }
  appendRecord(store, rec);
  console.log(`added ${store} ${rec.id}`);
  added++;
}
console.log(`\n收尾补库（幂等版）：新增 ${added}，跳过 ${skipped}`);
