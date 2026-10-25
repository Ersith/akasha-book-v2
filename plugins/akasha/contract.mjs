// 阿卡夏核心模块契约 v0（2026-10-20，P4）：只声明「谁可以 import 谁」，不承载运行逻辑。
// 目的：给 177 导出的单文件库加一条可机检的方向边界；先有基线，再谈拆模块。
// 运行：node tools/check-import-direction.mjs（CI/本地同源）；contract.assert 也可被测试调用。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTRACT_VERSION = 1;
export const ROOT = dirname(fileURLToPath(import.meta.url));

/** 层号越小越底层：低层不得 import 高层；同层/高层可 import 低层。 */
export const LAYERS = Object.freeze({
  base: 0,      // 零依赖 / 只依赖 stdlib 与更低层
  domain: 1,    // 数据模型与领域逻辑（session / sleep）
  io: 2,        // 进程/协议边界（mcp）
  app: 3,       // 组合入口（akasha CLI / init）
  test: 4,      // 测试可 import 任意层
});

/** 核心模块登记表；新增根级 .mjs 必须登记，否则 lint 报「未登记模块」。 */
export const MODULES = Object.freeze({
  'json-redaction.mjs': { layer: 'base', note: '脱敏原语' },
  'lib.mjs': { layer: 'base', note: '六库/读写/检索/审计核心' },
  'companion.mjs': { layer: 'base', note: 'CompanionPort 抽象' },
  'adapters.mjs': { layer: 'base', note: '外部适配器（Hindsight/OpenViking/HTTP）' },
  'loop-detect.mjs': { layer: 'base', note: '循环观测' },
  'parallel.mjs': { layer: 'base', note: '并行感知' },
  'session.mjs': { layer: 'domain', note: '会话层索引' },
  'sleep.mjs': { layer: 'domain', note: '睡眠蒸馏' },
  'intercom.mjs': { layer: 'domain', note: '协作信箱（msg/ack append-only + 折叠）' },
  'recog.mjs': { layer: 'domain', note: '再认知离线计划/追加执行' },
  'mcp.mjs': { layer: 'io', note: 'MCP stdio 服务' },
  'akasha.mjs': { layer: 'app', note: 'CLI 组合入口' },
  'init-example.mjs': { layer: 'app', note: '示例库初始化' },
  'context-pack.mjs': { layer: 'base', note: '上下文打包' },
  'forgetting.mjs': { layer: 'base', note: '遗忘曲线纯计算器（M1）' },
  'evidence.mjs': { layer: 'domain', note: 'M2 人工 review-result 证据日志' },
  'evidence-index.mjs': { layer: 'domain', note: 'M2 证据摘要索引/增量重建' },
  'evidence-evaluate.mjs': { layer: 'domain', note: 'M2 证据摘要→M1 评估适配' },
  'record-view.mjs': { layer: 'domain', note: '记录→M1 view 确定性适配' },
  'lookup-time.mjs': { layer: 'domain', note: 'lookup 时间影子评估（不改排序）' },
  'lookup-time-apply.mjs': { layer: 'domain', note: 'lookup 时间排序应用（显式 recent）' },
  'lookup-time-observe.mjs': { layer: 'domain', note: 'lookup 时间成对观察（返回 baseline）' },
  'time-intent.mjs': { layer: 'domain', note: '时间意图门（recent/none）' },
  'session-identity.mjs': { layer: 'domain', note: 'canary 会话身份解析（仅哈希）' },
  'data-view.mjs': { layer: 'domain', note: '数据视图指纹（只读）' },
  'captured-lookup-view.mjs': { layer: 'domain', note: '隔离捕获输入及副本生命周期' },
  'paired-lookup-view.mjs': { layer: 'domain', note: '固定捕获输入的配对观察（未接 CLI）' },
  'm3-resource-budget.mjs': { layer: 'domain', note: 'M3 受管日志与捕获临时文件的跨进程预算' },
  'budgeted-captured-view.mjs': { layer: 'domain', note: '统一预算下的捕获与默认关闭配对入口' },
  'canary-eligibility.mjs': { layer: 'domain', note: 'canary 资格判定（只读）' },
  'canary-bucket.mjs': { layer: 'domain', note: '请求级 canary 分桶' },
  'm3-experiment.mjs': { layer: 'domain', note: 'canary 实验配置（默认关）' },
  'm3-canary.mjs': { layer: 'domain', note: 'canary 纯计划（选择/资格/服务）' },
  'm3-stop.mjs': { layer: 'domain', note: 'canary 停止开关（fail-closed）' },
  'm3-canary-journal.mjs': { layer: 'domain', note: 'canary attempt/terminal 台账' },
  'm3-bench.mjs': { layer: 'domain', note: '离线 paired 基准指标' },
  'm3-review-packet.mjs': { layer: 'domain', note: '盲评包（隐藏 candidate 侧）' },
  'm3-canary-readiness.mjs': { layer: 'domain', note: 'canary 前置闸（只读）' },
  'm4-readiness.mjs': { layer: 'domain', note: 'canary 证据化前置闸（只读）' },
  'mirror-gate.mjs': { layer: 'domain', note: 'mirror 情境闸（只读）' },
  'session-compact.mjs': { layer: 'domain', note: 'session 索引去重计划（纯函数）' },
  'experience-baseline.mjs': { layer: 'domain', note: '自身经验基线对比（纯函数）' },
  'observe-log.mjs': { layer: 'domain', note: '观察日志有界追加' },
  'self-frame.mjs': { layer: 'base', note: '自我帧构造/校验' },
  'self-loader.mjs': { layer: 'base', note: '自我投影 loader/cache' },
  'self-projection.mjs': { layer: 'base', note: '自我投影纯函数' },
  'self-mixed-canon.mjs': { layer: 'base', note: '混合 canon 自我域适配' },
  'cache-budget-validation.mjs': { layer: 'base', note: '自我卡片预算与缓存校验' },
  'self-runtime-compat.test.mjs': { layer: 'test', note: '新 gate 自我投影兼容回归' },
  'self-step.mjs': { layer: 'domain', note: '逻辑步 token/帧绑定' },
  'context-pack.adversarial.test.mjs': { layer: 'test', note: 'context-pack 对抗测试' },
  'context-pack.review-fixture.mjs': { layer: 'test', note: 'context-pack 审阅夹具' },
  'context-pack.test.mjs': { layer: 'test', note: 'context-pack 测试' },
  'intercom.test.mjs': { layer: 'test', note: '协作信箱测试' },
  'intercom-reply.test.mjs': { layer: 'test', note: '协作回复/回执测试' },
  'forgetting.test.mjs': { layer: 'test', note: '遗忘曲线基础测试' },
  'forgetting.contract.test.mjs': { layer: 'test', note: '遗忘曲线契约测试' },
  'forgetting.evidence.test.mjs': { layer: 'test', note: '遗忘曲线证据测试' },
  'forgetting.time.test.mjs': { layer: 'test', note: '遗忘曲线时间测试' },
  'forgetting.review.test.mjs': { layer: 'test', note: '遗忘曲线复审测试' },
  'self-frame.test.mjs': { layer: 'test', note: '自我帧测试' },
  'self-loader.test.mjs': { layer: 'test', note: '自我 loader 测试' },
  'self-projection.test.mjs': { layer: 'test', note: '自我投影测试' },
  'self-step.test.mjs': { layer: 'test', note: '逻辑步测试' },
  'test.mjs': { layer: 'test', note: '测试入口（快照根）' },
  'test-core.mjs': { layer: 'test', note: '主测试套件' },
  'session-clusters.test.mjs': { layer: 'test', note: '会话聚类范围/窗口测试' },
  'session-tree-streaming.test.mjs': { layer: 'test', note: '建树分块读取与节流回归' },
  'session-index-safety.test.mjs': { layer: 'test', note: '索引台账与目录扫描错误回归' },
  'session-index-streaming.test.mjs': { layer: 'test', note: '索引流式扫描与去重回归' },
  'uri-resolve.test.mjs': { layer: 'test', note: 'akasha:// URI 解析/直读测试' },
  'evidence.test.mjs': { layer: 'test', note: 'M2 人工 review-result 证据测试' },
  'evidence-index.test.mjs': { layer: 'test', note: 'M2 证据索引增量/重建测试' },
  'evidence-evaluate.test.mjs': { layer: 'test', note: 'M2 证据→M1 评估回归' },
  'record-view.test.mjs': { layer: 'test', note: '记录→view 映射回归' },
  'lookup-time.test.mjs': { layer: 'test', note: 'lookup 时间影子回归' },
  'lookup-time-apply.test.mjs': { layer: 'test', note: 'lookup 时间排序应用回归' },
  'lookup-time-observe.test.mjs': { layer: 'test', note: 'lookup 时间成对观察回归' },
  'time-intent.test.mjs': { layer: 'test', note: '时间意图门回归' },
  'canary-preconditions.test.mjs': { layer: 'test', note: 'canary 前置件回归' },
  'captured-lookup-view.test.mjs': { layer: 'test', note: '捕获输入/完整性/资源边界回归' },
  'paired-lookup-view.test.mjs': { layer: 'test', note: '共同捕获输入消费及默认关闭回归' },
  'm3-resource-budget.test.mjs': { layer: 'test', note: '统一预算并发、写入不确定及残留回归' },
  'budgeted-captured-view.test.mjs': { layer: 'test', note: '预算捕获、消费与清理集成回归' },
  'canary-eligibility.test.mjs': { layer: 'test', note: 'canary 资格判定回归' },
  'canary-bucket.test.mjs': { layer: 'test', note: '请求级 canary 分桶回归' },
  'm3-experiment.test.mjs': { layer: 'test', note: 'canary 实验配置回归' },
  'm3-canary.test.mjs': { layer: 'test', note: 'canary 纯计划回归' },
  'm3-stop.test.mjs': { layer: 'test', note: 'canary 停止开关回归' },
  'm3-canary-journal.test.mjs': { layer: 'test', note: 'canary 台账回归' },
  'm3-bench.test.mjs': { layer: 'test', note: '离线基准指标回归' },
  'm3-review-packet.test.mjs': { layer: 'test', note: '盲评包回归' },
  'm3-canary-readiness.test.mjs': { layer: 'test', note: 'canary 前置闸回归' },
  'm4-readiness.test.mjs': { layer: 'test', note: 'canary 证据化前置闸回归' },
  'mirror-gate.test.mjs': { layer: 'test', note: 'mirror 情境闸回归' },
  'lookup-mirror-gate.test.mjs': { layer: 'test', note: 'lookup mirror 情境闸 opt-in 回归' },
  'outcome-log.mjs': { layer: 'domain', note: '结果信用旁路（只写日志，不改评分）' },
  'outcome-log.test.mjs': { layer: 'test', note: '结果信用旁路回归' },
  'cas-idempotency.test.mjs': { layer: 'test', note: 'CAS/幂等写路径回归' },
  'proposal-status.test.mjs': { layer: 'test', note: '提案/采纳状态回归' },
  'session-compact.test.mjs': { layer: 'test', note: 'session 索引去重回归' },
  'session-append-idempotent.test.mjs': { layer: 'test', note: 'session 节点追加幂等回归' },
  'manifest-backfill.test.mjs': { layer: 'test', note: '历史 manifest 补齐计划回归' },
  'jsonl-stream.test.mjs': { layer: 'test', note: '大文件 JSONL 流式解析回归' },
  'mirror-gate-recall.test.mjs': { layer: 'test', note: 'mirror 情境闸召回回归' },
  'experience-baseline.test.mjs': { layer: 'test', note: '自身经验基线回归' },
  'observe-log.test.mjs': { layer: 'test', note: '观察日志预算回归' },
  'recog-security.test.mjs': { layer: 'test', note: '再认知计划写库/batchId 安全测试' },
  'contract.mjs': { layer: 'base', note: '本契约' },
});

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.\/[^'"]+)['"]/g;

function moduleOf(raw) {
  const p = raw.replace(/^\.\//, '');
  if (!p.endsWith('.mjs')) return null;
  if (p.includes('/')) return null;              // tools/** 不在根契约内
  return basename(p);
}

/** 扫描根级核心 .mjs 的静态/动态相对 import，按层检查方向并检测环。返回 {ok, errors, edges, checked}。 */
export function checkImportDirection({ root = ROOT } = {}) {
  const errors = [];
  const edges = [];
  const seen = new Set();
  // OSS 扁平布局把 tools/ 拷成 tools-*.mjs 放在 root；它们不属于核心契约面，跳过。
  const isToolName = (n) => n.startsWith('tools-');
  const files = readdirSync(root).filter((f) => f.endsWith('.mjs') && !isToolName(f));
  for (const f of files) {
    if (!MODULES[f]) { errors.push(`未登记模块：${f}（请登记到 contract.MODULES）`); continue; }
    seen.add(f);
    const text = readFileSync(join(root, f), 'utf8').split(String.fromCharCode(10))
      .map((line) => (line.trimStart().startsWith('//') ? '' : line))
      .join(String.fromCharCode(10));
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = moduleOf(m[1]);
      if (!target || target === f || isToolName(target)) continue;
      if (m[1].includes('/') && !m[1].startsWith('./')) continue;
      if (!existsSync(join(root, target))) { errors.push(`${f} 引用了不存在的模块：${m[1]}`); continue; }
      if (!MODULES[target]) { errors.push(`${f} 引用了未登记模块：${target}`); continue; }
      const from = MODULES[f].layer;
      const to = MODULES[target].layer;
      edges.push({ from: f, to: target });
      if (from !== 'test' && LAYERS[to] > LAYERS[from]) {
        errors.push(`方向错误：${f}(${from}) → ${target}(${to})；低层不得 import 高层`);
      }
    }
  }
  // 未登记但存在的根模块已报；登记了却不存在的也报（防止契约腐化）
  for (const f of Object.keys(MODULES)) if (!seen.has(f) && !existsSync(join(root, f))) errors.push(`契约登记了不存在的模块：${f}`);
  // 环检测（只针对根模块；工具子目录不参与）
  const adj = new Map(files.map((f) => [f, []]));
  for (const e of edges) if (adj.has(e.from)) adj.get(e.from).push(e.to);
  const state = new Map();
  const stack = [];
  const dfs = (n) => {
    if (state.get(n) === 2) return;
    if (state.get(n) === 1) { errors.push('import 环：' + [...stack.slice(stack.indexOf(n)), n].join(' → ')); return; }
    state.set(n, 1); stack.push(n);
    for (const m of adj.get(n) || []) dfs(m);
    stack.pop(); state.set(n, 2);
  };
  for (const f of files) if (state.get(f) !== 2) dfs(f);
  return { ok: errors.length === 0, errors, edges, checked: files.length };
}

export function assertImportDirection(opts = {}) {
  const r = checkImportDirection(opts);
  if (!r.ok) throw new Error('模块契约失败（' + r.errors.length + '）：\n' + r.errors.join('\n'));
  return r;
}
