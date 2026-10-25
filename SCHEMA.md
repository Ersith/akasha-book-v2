# 阿卡夏之书 · 数据规范（v0）

六个存储，全部 JSONL（每行一个对象）、append-only。
`id` 规则：`<前缀>-<slug>`（`canon-` / `mirror-` / `orphan-` / `price-` / `lex-`），按存储内查重。
`check` 会逐行校验：坏 JSON 行只报告不抛；缺字段 / 枚举越界 / 重复 id 均报错。

## canon（稳定库）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | 必填 |
| claim | string | 一条可引用的事实断言 |
| source.type | enum | 复现 / 实验 / 官方 / 他人 / 共识 |
| source.ref | string | 出处（文档名 / RFC / 复现记录） |
| source.version | string | 可选；版本（如 v24、RFC 9110） |
| last_reviewed | string | 上次复核 YYYY-MM-DD（慢周期复核的锚） |
| tags | string[] | 可选 |
| hint | string | 可选；**反射文本** ≤80 字（"动手前该做什么"）。由插件在**坑前提示**里原样打出 ⇒ **改条目＝改反射**（2026-10-11 用户裁定：反射要能随工程知识纠错与优化）|
| hint_until | string | 可选；`hint` 的**有效期** YYYY-MM-DD，过期即不再打（防过期反射照打）|
| **triggers** | string[] | 可选；**触发词路由**用（2026-10-11 解冻后新增，外部对照启发）。命中"当前任务文本"里的任一触发词 ⇒ 在**动手前**把该条的 `hint` 端上来。取**专指**词（如"改文件"而非"改"），避免误触；无 `hint` 不触发（fail closed）|
| **when** | object | 可选；**可判定谓词**（2026-10-11 解冻后新增，#9 条件谓词化）。求值器 `lib.mjs::evalCondition`：原子 `eq/ne/gte/lte/in/contains`、逻辑 `and/or/not`；**条件非法 ⇒ 抛错且不打**（fail closed，绝不静默放宽）。可用事实：`turn` / `date` / `usedTools` / `failedRecently`。**不写编译器**——那 290 KB 换的是可编程性，我们要的是可审计性 ✓ |

> **合成禁互引（2026-10-11 立，#32；外部对照启发＝Hindsight 的 `exclude_mental_models`）**：**摘要 / 派生类段落（`kind ∈ {promotion, topic, node}`）只许引用「叶」——普通段（intent/conclusion/action/process）或六库记录 id；禁止引用别的摘要。** 理由：防止错误主张在摘要之间**循环放大**（页 A 引页 B、页 B 引页 A，错误就被"多数票"固化）✓ **可机检**：`check` 报 `summary-cites-summary`（摘要引摘要）与 `promotion-source-not-leaf`（`promoted_from` 指向摘要）✓ **口径（实测标定，勿改宽）**：只查**引用类字段**（`based_on`/`cites`/`refs`/`source`）；**`children` 是树的父子结构，不算引用** —— 第一版判定器漏了这条，把 12 处 L2→L1 的 `children` 误报成"互引" ✗ ⇒ 已立永久守卫（`test.mjs` 三例）✓

> **自动端上来（2026-10-11 立，#13）**：触发词**未命中**时退化为**一次轻量词法召回**，把最相关的一条**直接端上来**（不再只是"提示我去查"）。接受判据经**实测标定**：**归一 ≥1.0 且 绝对分 ≥8**（切题样本 归一 1.59/1.68/3.45 ⇒ 全端；不切题样本 0.82/0.45/0.29 ⇒ 全不端）。技术上**额外做 bigram 展开**（`tokenize` 会把中文长句当**一个 token** ⇒ 不展开则 146 条并列 0.90、阈值失效），**不改全局 tokenize** 以免污染既有检索口径。开关 `autoBringUp`（默认开）；同一条消息只端一次；上限 1 条。

> **触发词路由（2026-10-11 立）**：`triggers` 与 `hint` 配套 —— **事件里记录用户消息、注入时匹配**（宿主注入面拿不到当前用户消息，故用两步式：`session/event` 捕获 ⇒ `system-prompt` 渲染时匹配）。分支优先级：**失败驱动 → 触发词路由 → 首用预告**（同回合只出一条）；去重＝同条目 30 分钟一次；开关＝插件 config `triggerRouting`（默认开）；每次触发落一条 `kind: preflight`（`mode: trigger`）观测线。

> **快照类条目**（版本清单 / 依赖拓扑 / 生态现状等会随时间漂移的观察）：id 带日期后缀（`canon-<主题>-YYYYMMDD`）、`claim` 里写明观测时点与适用的版本坐标、`last_reviewed` = 快照日；更新一律走 `revise` 追加新版，不改原文。**不要写成无日期的常青断言**——过期后会误导下一个会话（用户 2026-10-07 裁定）。示例：`canon-dsh-plugin-inventory-20261007`、`canon-harness-reparse-topology-20261007`。

## mirror（镜像库，五元组）

抽取 / 入库口径＝五元有序集：**情境模式 → 行为 / 动作 → 结果 → 社会反应 → 情绪词**（`MIRROR_TUPLE_FIELDS`）。匹配走结构字段，不靠故事名字面；`story` 只作命名与出处标签。

| 字段 | 说明 |
|---|---|
| id / story | 条目 id；故事 / 出处名（如「伊索寓言·狼来了」——**给名字**；本人日志条目可写会话 ptr / 日期标签） |
| situation | 情境模式（结构，不按字面） |
| behavior | 行为 / 动作 |
| outcome | 结果 |
| social_reaction | 社会反应 |
| emotion | 对应情绪词（可含过渡，如「骄傲转悔恨」） |
| role（可选，wave1） | `solution`（解法）/ `boundary`（边界）；缺省＝未分层。同库分层，改 role 走修订链 |
| evidence（可选，wave4） | `story`（典故 / 教材——给名字）/ `own-log`（本人日志——给证据）。抗教材偏见：检索可 `--evidence own-log` 只要实证 |
| era（可选，wave4） | 时代 / 语境标签（string，如「古希腊寓言」「2026-Q3 本机」） |
| context（可选，wave4） | 适用上下文（string，如「协作信任」「工期竞速」） |
| patterns（可选） | string[] 结构标签；`mirror match` 子串命中加权 ×2 |

> **设计要点（wave4）**：故事给名字、本人日志给证据——二者都进同一五元组，不另开库。原文 append-only，改口走 `revise`。CLI/MCP：`mirror match … [--evidence story|own-log] [--era …] [--context …]`。

## orphan（孤案）

id；summary / observed / hypothesis / would_confirm / would_refute（string）；severity（高 / 中 / 低）；created（YYYY-MM-DD）。
零权重留档；热载三通道见设计稿 §2.8。

## pricing（定价表）

id；behavior（string）；valence（-1..1 数字）；severity_default（1..5 整数）；note（可选）。
- 粒度（2026-10-07，见 canon-pricing-granularity-20261007）：定价对象＝**具体行为**（情绪标签贴行为本身）；机制状态 / 类别（如「触红线」）不是定价对象。记录级 `valence`/`arousal` ＝该记录所载行为之价的实例化；判断 / 召回以行为级定价为依据。

## lexicon（情绪词表）

id；term / trigger / behavior / resolution / source 全部必填（string）。

## frontier（前沿层 · 文献基石）

| 字段 | 说明 |
|---|---|
| id / title / url | 条目 id；标题；链接（须 http(s)） |
| year | 可选（次要链接留空） |
| topic | 主题（记忆系统 / 离线巩固 / 情绪与价值 / 知识边界 / 推理控制 …） |
| status | 已实践 / 已复现 / 高引用 / 待验证（排序：已实践 > 已复现 > 高引用；新文献先「待验证」） |
| last_checked / next_review | 上次核对 / 下次复审（待验证 +90 天，高引用 +180 天；到期用 `frontier due` 列出） |
| supports | 对应设计稿条目（如 §2.7 离线层） |
| note | 一句话（可空） |

基石随 `node init-example.mjs` 从 `data-example/frontier.jsonl` 拷入（仓库里没有 `tools/import-frontier.mjs`）。手工增补走 `add --store frontier --data '<json>'`。

> **写入侧脱敏是"深度"的（2026-10-11 修）**：六库写入统一入口 `appendRecord` 会对记录**递归**过脱敏（`redactDeep` ✓ 覆盖嵌套对象与数组），**不只洗顶层字符串** —— 此前只洗顶层 ⇒ `{nested:{deep:"npm_…"}}` 这类**漏洗** ✗。口径见 `REDACT_RES` 注释（**宁可漏报也不误伤** · **识别面宽为拦得住、受理面窄为说得准**）✓

## 时间字段（双时态，2026-10-07 起）

| 字段 | 谁写 | 说明 |
|---|---|---|
| `event_time` | 条目作者（可选） | **事件时间**：所描述之事发生的时间（建议 YYYY-MM-DD，可 ISO）。写 canon / orphan 时尽量带；不强制、不回填历史。 |
| `logged_at` | 写入路径（自动） | **记录时间**：appendRecord 家族（CLI / MCP / 脚本 / revise 修订行）自动盖 ISO 8601 UTC 戳；自带不覆盖。 |

- 两轴分开：`event_time` 回答「何时发生的」；`logged_at` 回答「何时记下的」——修订链每行都有 `logged_at` ⇒「某条何时被改」可查。
- 校验：两字段若存在须为非空字符串。
- 检索过滤口径：`--since / --until` 按「`event_time` 优先、`logged_at` 回退」的日期级字符串比较（UTC）；无时间戳条目在带过滤时被排除（**2026-10-07 起：输出默认提示「另有 N 条日期未知」——未知≠该时段没有；`--undated` 并入、`--report` 出完整报告**）。
- 读侧年龄前缀（2026-10-14）：lookup / brief / cross / show / session lookup 的命中行带 `[过去·N天]`（或 `[未来·N天]` / `[日期未知]`）。锚＝`event_time`，否则 `logged_at`，否则段上的 `time`。只渲染，不回写。

## 退役与删除（2026-10-08，用户裁定）

基石分层要求「教程/工具类资料不进 frontier」，而 append-only 只支持追加 ⇒ 需要显式的**移出**原语（CLI；脚本可调 `retireRecord`）：

- `node akasha.mjs retire <store> <id> [--reason '...']` —— **软退役（默认）**：在链尾之后追加一条**墓碑**记录（`id: <链尾 id>-retired`，字段 `retires: <链尾 id>` + `retired_at` + `retired_reason`；其余字段克隆链尾，以便照常通过该校验）。被退役记录**连同其全部修订版本与墓碑本身**都不进「当前集」（`currentRecords`）——因此 `lookup` / `brief` / `cross` / `summary` / `audit` / `stats` / `frontier list` / `orphan list` 全部不再看见它；历史仍在文件里可追溯。
- `node akasha.mjs retire <store> <id> --hard` —— **删除**：把该 id 的整条修订链与墓碑**行**从存储文件移除；移前先把被删行备份到 `data/_trash/<日期>-<store>.jsonl`（保留 append-only 精神：先留副本，再删）。**wave1 起**：读→判→写整段持存储文件锁（与 `appendRecord` 同一把锁），备份 fsync 后再**原子替换**原文件；回收站跟着存储文件走（`<存储文件所在目录>/_trash`；真库即 `data/_trash`，临时库不再污染示例库目录）。
- 幂等：已退役者重复调用返回 `already: true`。
- 校验：`retires` 必须指向存在的 id（悬空指针由 `check` 报错）；`check` 的每库报告新增 `retired` 计数。
- 不变式：退役/删除只作用于该 id 的链，不影响其它记录。
- **幂等判重纪律（2026-10-08 事故后立）**：脚本按 id 判重必须用**历史 id 集合**（`allIds`），**不得用 `currentRecords`** —— 已退役 id 不在当前集，拿它判重会把退役条目当新条目重放（当晚真实事故：4 条被复活并出现重复 id，`check` 报 duplicate）。写入侧另设硬闸：`appendRecord` 拒绝追加已退役 id，确需重加须显式传 `{ allowResurrect: true }`。
- 硬删的「已退役短路只对软退役生效」：对已退役条目执行 `--hard` 必须继续删（否则复活出来的重复行清不掉）。

## 校验命令

```
node akasha.mjs check        # 人类可读
node akasha.mjs check --json # 机器可读（退出码 1 = 有错）
```


> **引用完整性（`cite-dangling`，2026-10-11 增）**：摘要/派生段（`kind ∈ {promotion, topic, node}`）的**引用类字段**（`based_on` / `cites` / `refs` / `source`）里写的 id，**必须真实存在**（同文件段 id ∪ 六库记录 id）✓ **只认结构化字段** —— **不做文本扫描**（文本里的 id 形态含大量"400 字截断"产物，扫了就是假警 ✗ 见 PROTOCOL §七.7⑤）✓

## 审计（可机检的抽样审计）

`node akasha.mjs audit`（可 `--today YYYY-MM-DD` 模拟将来）检查：

- 前沿层到期复审（warn）；canon 复核超期 > 365 天（warn）；
- 重复 URL（info）；孤案积压 > 90 天（info）。

退出码恒 0；结果以 `findings` 数组见 `--json`。

## 主题简报（brief）

`node akasha.mjs brief <主题> [--per N]`（MCP：`akasha_brief`）——把「先查再答」从逐条 lookup 升级为按主题取料：

- 主题词按空格/逗号切分，对六库 `LOOKUP_FIELDS` 计分：整词命中 ×1；含中文且 ≥3 字的词追加相邻二字（bigram）回退 ×0.25（2026-10-07 起）——词组未原样出现也能召回；**回退分 <1 = 弱命中（疑似相关），整词级 ≥1 = 强命中**。`brief` 在强命中为零时明确写「确定不知道」（弱命中仍列出，但不算证据）。孤案 `zeroWeight`：可见、不加权、不算强命中。
- `--since / --until`（YYYY-MM-DD，lookup / brief / cross 通用）：按 `event_time`（优先）|| `logged_at` 的日期级比较过滤（UTC 口径）；无时间戳条目被排除（**默认提示「另有 N 条日期未知」；`--undated` 并入、`--report` 完整报告；非法日期即拒**）；brief 每条命中带 `time` 坐标；
- frontier 命中附加状态权重（已实践 3 > 已复现 2 > 高引用 1 > 待验证 0），每库默认 top **3**（`--per` 可调，与 main 相同）。不传 `--depth` 时主字段是全文；`--depth summary` 才把主字段截到约 400 字，`--depth pointer` 约 80 字。`--reflect` / `--depth full` 是高保真全文（不剥皮、不受剂量闸）；
- 输出带来源态提示：库内强命中标注「记得·库内」；仅弱命中 →「不确定」并引用 cites；无可用证据 →「确定不知道，不要编」（见「知识分层」）。

## 起床包（kit）

`node akasha.mjs kit`（MCP：`akasha_kit`）——开工前一次装配：

- 睡眠摘要（`logs\sleep-state.json`：上次运行/触发/待办数/审计结论/报告名）；
- 待办（`logs\inbox.jsonl`：批次、条数、最新条目摘要）；
- 当前审计（实时 `audit()`：到期/陈旧/重复/积压）；
- 库况（六库计数 + frontier 状态分布）；
- 提示（hints）：待办处理建议、审计警告、开工姿势（先 brief、带来源态）。
- `stateFile` / `inboxFile` 可注入（测试与多实例用）；「开工先 kit」是软协议约定。

## 对位比较（cross）

`node akasha.mjs cross <词> [--per N]`（MCP：`akasha_cross`）——同一主题词在六库的**全部**命中按库并排：

- 当前版本、按命中数排序。主行字段仍是全文来源（canon=claim；mirror=境况→反应；orphan=摘要；pricing=行为；lexicon=词条：行为；frontier=题名），**默认不截断**（读侧只剥完成态符号）；`--depth summary` 才把行宽收到约 300 字，`--depth pointer` 约 80 字；`--reflect` / `--depth full` 给原文、不截断、不剥皮；
- 「同题多源」提示 + 处置姿势：**矛盾不合并**——留档用孤案（orphan add），定论用修订链（revise）；
- 与 `brief` 的分工：brief 是「按相关度取前 N 条」（快速了解），cross 是「全摆出来对位」（裁决用）；两者与 lookup 均支持 `--since / --until` 时间过滤。

## 全库摘要（summary）

`node akasha.mjs summary [--per N]`（MCP：`akasha_summary`）——「不带问题看一眼全库」：

- 六库计数 + 各库最近 N 条（`--per` 默认 3；主行截 160 字）+ frontier 状态分布；
- 审计概要（OK / 警告计数）+ 最近写入（与库脉搏同源）；
- 与 kit 的分工：kit 是开工动作装配（睡眠 / inbox / hints），summary 是库自身全貌陈列。

## 直读（show）

`node akasha.mjs show <id> [--reflect] [--depth pointer|summary|full]`——按 id 跨六库直读。**默认全文**（与不带 depth 的既有读档一致）。`--depth summary` 单条硬顶约 1500 字，`--depth pointer` 约 80 字；`--reflect` 或 `--depth full` 取所查版本全文且不剥皮。命中被修订的旧版本时，提示链尾 id，record 仍是所查版本全文（只有显式摘要/指针档才截断）。配合 lookup / brief 构成「先搜后读」。

## 候选转正（promote）

`node akasha.mjs promote [--dry]`（MCP：`akasha_promote`）——把 sleep 写入 `logs\inbox.jsonl` 的孤案候选（`kind: orphan-candidate`）机械落成孤案条目：

- id = `orphan-b<md5(code|样本)前8位>` ⇒ **幂等**（重跑只跳过，不重复追加）；
- 字段映射：`summary` = `[inbox候选] <code> ×N`；`observed` = note / samples；`hypothesis` / `would_confirm` / `would_refute` 留「（待补）」（零权重留档，等待复盘）；
- **消费记账**：每次处理过候选（转正或跳过）后，向 inbox 追加一行 `kind:"consumed"`（含 `upTo` = 处理时读入的行数、`count` / `skipped`）——`kit` 的待办计数只统计 `consumed.upTo` 之后的批次（2026-10-07 修：转正后计数与唤醒条提醒不再只增不减）；
- severity：`agent-error` → 中，其余 → 低；`--dry` 只报不写（默认执行）。
- 闭环：失败/拦截 → hooks 记录 → sleep 蒸馏 → inbox 待办 → promote 入孤案库。

## 睡眠计划（sleep --plan，wave2 §2 第一批，2026-10-08）

`node akasha.mjs sleep --plan [--out F] [--today YYYY-MM-DD] [--theta 0.8] [--max 20] [--orphan-days 90] [--stale-days 365] [--log F] [--json]`

**只读六库**：不调 `appendRecord` / `revise` / `retire`，不动睡眠水位线（`sleep-state.json`），只写一个计划文件（缺省 `logs/sleep-plan-<today>-<planId 短码>.json`——**2026-10-14 起文件名带短码防同日覆盖**；`--out` 指定；指向存储文件即拒）。**`--apply` / `--revoke` 已实现**（2026-10-14，A 档：keep 一字不动＋absorb 软退役；见上文 merge 节执行段）；`--rollback` 无此旗标（回滚走 `--revoke`）。MCP 只读入口：`akasha_sleep_plan`（见下「可信度」之前的说明）。

计划形状：

```
{ planId, version: 1, mode: "plan-only", createdAt,
  params:  { today, theta, maxOps, orphanDays, staleDays },
  basis:   { <store>: { bytes, sha256 } },        // 六库文件指纹（缺文件：{ bytes:0, sha256:null, missing:true }）
  inputs:  { hooksLog: { bytes, sha256 } },        // canon-stale 引用计数的来源
  ops: [ { op:"merge",   store, keep, absorb:[ids], reason, mergedText:null, evidence },
         { op:"discard", store, id, reason, evidence } ],
  truncated: { total, dropped }, excluded: { protocol, promoted }, skipped: [ { rule, why } ],
  nearMiss: {                                       // v2026-10-10：近失报告（诊断用；不进 planId、不影响 op）
    merge:   { <store>: { theta, candidates, top: [ { a, b, jaccard } ×≤3 ] } },
    discard: { 'orphan-aging':      { thresholdDays, examined, oldest: [ { id, created, ageDays } ×≤3 ] },
               'canon-stale-unused':{ thresholdDays, examined, oldest: [ { id, last_reviewed, ageDays } ×≤3 ], note? },
               'snapshot-superseded':{ stemsExamined, stemsWithMultiple },
               'frontier-duplicate-url': { urlsWithMultiple } } } }
```

- **近失报告（`nearMiss`，2026-10-10 起）**：把「离触发差多远」摆出来——`ops` 为空时不再是无解释的黑箱（CLI 在 0 op 时打印一行摘要）。它**不参与 planId 哈希、不影响任何 op**；合并段列出各库 Jaccard 最高的 ≤3 对，丢弃段列出最老的 orphan / canon 年龄与同主题多快照、同 URL 组数。

- **确定性**：`planId = "plan-" + sha256({ params, basis, inputs, ops })` 前 16 位；`createdAt` 不参与。同库、同日志、同参数 ⇒ 同 ops、同 planId。库变一个字节 ⇒ basis 变 ⇒ planId 变（将来 apply 据此拒绝过期计划）。
- **merge**（同库、都在当前集）：
  - `near-duplicate`：主文本 token Jaccard ≥ θ。主文本：canon=`claim`；mirror=`situation`+`behavior`；lexicon=`term`+`trigger`；pricing=`behavior`。token = `tokenize` 切词，含中文的词再拆相邻二字。orphan 零权重，不参与合并。
  - `duplicate-url`（frontier）：url 精确相等（与 `audit` 同口径）。
  - keep 按 **R4 代际规则**（2026-10-14 用户裁定落地；草案 R4）：同源快照两代（版本标记可解析且互异）⇒ **取最新**；真重复（无版本标记）⇒ 取链根 `logged_at` 最早（同则根 id 字典序）；判不了（标记混用/重复）⇒ `keep: null` + `needsHuman: true`（`--apply` 拒绝该 op）。keep 只吸收与它**本身** ≥ θ 的条目（每个 absorb 在 `evidence.pairs` 里都有直接相似度；换 keep 后 absorb 从全组重算）。`mergedText` 恒为 `null`——合并文本由模型 / 人填，代码不生成语义文本。
  - **执行（2026-10-14 实现 A 档）**：`sleep --apply <planId|文件> [--yes] [--only <id>] [--force]`——keep **一字不动**，absorb 逐条软退役（`retired_reason: 'merged-into <keep>'`）；默认 dry；basis 指纹过期 ⇒ 拒绝。**生产路径拒绝非演练的 `--force`**（`sleep --apply --yes --force` 直接退出，不写库）；指纹过期请重新 `sleep --plan`。`--force` 只可与演练同用（不加 `--yes`），用来查看过期计划会做什么。豁免面/needsHuman ⇒ 拒绝；审计＝review-log（verdict 合并/退役）+ `logs/sleep-apply-<planId>.json` 回执。`sleep --revoke` 同款复位。
- **discard**（先于 merge 判定）：
  - `snapshot-superseded`：canon 链根 id 形如 `<主题>-YYYYMMDD`，同主题存在日期更晚的当前快照；
  - `canon-stale-unused`：`last_reviewed` 超过 `staleDays`，且 hooks 日志里 `kind:"usage"` 从未引用该链上任何 id。**日志缺失 = 引用数未知 → 不出此类 op**（记入 `skipped`）；
  - `orphan-aging`：`created` 超过 `orphanDays`，且这段时间内链上没有修订（无确认）。
- **永不进计划**：协议条（`isProtocolId`）、带 `promoted_from` 的链（升格记录，§1 的源段关系不在这里动）、已退役条目（不在当前集）、frontier 的 discard（只走 `frontier recheck`）。每条记录至多出现在一个 op 里。
- **上限**：按（merge 先于 discard → 库序 → reason → id）排序后取前 K（`--max`，缺省 20），截去数记在 `truncated`。

**P4 立场（已定；2026-10-14 已实现）**：`revokes` 不走 `allowResurrect` 的门——存在撤销某墓碑的 `revokes` 时，即便 `allowResurrect:true` 也拒绝再追加同一 id（文案「已恢复为当前版本，要改走 revise」）；回滚验收比**当前集**的 `(根 id, 正文)`，不比逐行，历史行一条不删。**实现**：撤销记录＝`{id: <墓碑>-revoked, revokes: <墓碑 id>, revoked_at}` 元数据行（不进当前集）；`currentRecords`/`retiredIds` 视被撤墓碑为未退役；`revokeRetire(store, id)` 追加之；`sleep --revoke <planId>` 按回执把已执行合并/退役整批复位。悬空 `revokes` 由 `check` 报错。

## MCP：`akasha_sleep_plan`（wave2 §2.2，只读）

`tools/call` 名字 `akasha_sleep_plan`。参数只有 `today` / `theta` / `maxOps` / `orphanDays` / `staleDays`（都可选）。返回与 CLI `sleep --plan` 同一个计划对象，但 **`out: false`：不写计划文件、不写六库、不动水位线**，也没有 `apply`。日志与库路径固定为进程默认值，不接受模型传入路径。

## 历史回放（sleep --replay，B2 · §2.4.6 / §3.4.6）

`node akasha.mjs sleep --replay [--log F] [--out F] [--today YYYY-MM-DD] [--theta 0.8] [--max 20] [--orphan-days 90] [--stale-days 365] [--json]`

**只读。** 读一份 hooks 日志（缺省 `logs/hooks.jsonl`），用与 `sleep --plan` 相同的规则算出当时的 ops，再对**同一份日志原样**跑两遍 `recallSignals`。不写六库、不写计划文件、不动水位线。`--out` 省略则只打印；给了路径才写回放 JSON（指向存储文件即拒）。`--apply` / `--rollback` 仍未实现，与 `--replay` 同用直接拒绝。没有 MCP 入口。

- **正确口径（验收）**：`recall.replayed.misses - recall.asRecorded.misses` 不得 > 0。B2 只认「失败前有没有成功的查库动作」，不认查中了哪条、层级系数是多少、计划打算 absorb / discard 谁。所以分层和合并建议**不能**让这份历史日志的 misses 上升。`replayId` 由日志指纹、planId、两遍计数和将移出的 id 哈希，`createdAt` 不参与。
- **对照口径（不采用，防幸存者偏差）**：把「点名的 id 全部落在将被 absorb/discard、或当前已 refute 的集合」的召回行从日志里删掉再数。这个数上升，只说明「假装那些查库没发生」会多出漏召——**不能**拿 apply 之后的 miss 率证明合并无害。没点名 id 的查库行保留（无法证明它依赖被删条目）。`keep` 留下，只把 `absorb` 与 `discard` 的 id 算作移出。

## 可信度（wave2 §3，2026-10-08）

> **`verification.kind` 的取值**（2026-10-11 手检补；常量 `lib.mjs::VERIFY_KINDS` ✓ 此前 SCHEMA 未列）：`replay`（历史回放复现）· `experiment`（新做实验）· `doc`（官方文档／规格）· `incident`（事故实证）· `refute`（**证伪**——把"不是这样"也记下来 ✓ 与落码记录的「证伪·剔除」同精神）。校验在写入侧强制（非法值拒写 ✓）。

存量不重写：没有 `credibility` 字段。层级由代码从 `source.type` 和修订链上的 `verification` 推导（`credibilityOf`）。升格（`promoted_from`）**没有加成**，层级就是写下的 `source.type`。

**为什么 T2（本人实验）高于 T3（官方文档）。** 实验是这套环境里自己跑出来的结果；官方文档写的是设计意图，版本一漂移就不是这台机器上的事实（快照类条目的既有纪律：带日期、不写常青断言）。所以本人受控实验压过官方文档。官方文档仍高于他人事故（T4）和未经验证的共识（T5）。实验不是复现：没走完回放的停在 T2，不得借「我试过」写成 T1。

| 层 | 含义 | `source.type` | 排序系数 |
|---|---|---|---|
| T1 | 本人回放（复现成功） | 复现 | 1.0 |
| T2 | 本人实验（受控尝试，未完整复现） | 实验 | 0.9 |
| T3 | 官方文档 | 官方 | 0.8 |
| T4 | 他人事故 / 经验 | 他人 | 0.65 |
| T5 | 未验证共识 | 共识 | 0.5 |

系数只乘 **排序权重**，并出现在命中行的展示标签上。不参与 `strong` / `weak`：`strong` 仍是整词命中 ≥ 1，孤案仍是 `zeroWeight`。没有 `source.type` 的库（mirror / orphan / pricing / lexicon，以及未带验证事件的 frontier）系数 = 1，不发明层级。

**验证事件**（可选，只允许出现在带 `supersedes` 的修订版上）：

```
verification: { kind: "replay" | "experiment" | "doc" | "incident" | "refute", at, ref }
```

`ref` 必填（会话 ptr、frontier id 或 URL）。沿链从根版 `source.type` 起步，逐条应用（修订版若改了 `source.type`，先按新类型重定，再应用本条 verification）：

- `replay` → T1；`experiment` → 不超过 T2（已是 T1 则保持）；`doc` → 不超过 T3；`incident` 只是佐证，不改层；
- `refute` → `refuted`，检索权重 0。之后若再有 `replay` / `experiment` / `doc`，以新的验证事件为准（`refuted` 取消）。

**类 → 有效期**（类由代码判定，不进记录字段；改天数 = 改本节再改 `CRED_DEFAULTS`）：

| 类 | 判定 | 有效期 |
|---|---|---|
| 协议 | 链上任一 id 命中 `isProtocolId` | 不衰减 |
| 快照 | **根** id 以 `-YYYYMMDD` 结尾 | 自当前版 `last_reviewed` 起 90 天 |
| 前沿 | `store == frontier` | 不另起时钟：`next_review <= today` 即过期（与 `audit` 的 frontier-due 同口径） |
| 常青 | 以上都不是 | 自最近一次验证（`incident` 不算）或 `last_reviewed` 中较晚者起 180 天 |

过期只把 **展示层** 降一档并标「待复核」（T5 无处可降，保持 T5 并标「待复核」；没有层级的只标「待复核」）。排序仍用存储层系数。`today` 可注入，拨回即恢复。无锚点日期则不算过期。

**refuted 怎么看。** 默认 `lookup` / `brief` / `cross` 不返回。要看：`show <id>`（附 `credibility.steps`，逐版说明为什么是现在这层），或 `--include-refuted`（只此一个意思）。六库**没有** `--all`（那是 `session lookup` 的动作段归并开关）；传了就拒绝。MCP 对应字段是 `includeRefuted`，没有 `all`。

**睡眠待办（只提醒，不改库）。** `sleep` 扫描当前集：`refuted` → inbox 一条 `code:refuted`；存储层 T5 且 hooks 日志里 `usage` 引用该链合计 ≥ 3 → `kind:verify-candidate`。日志缺失 = 引用数未知，不出 verify-candidate。阈值 3 是本节定的「高频」（设计稿只说高频、没给数）。

## 修订链（append-only 之上的更正）

「追加式更正不改原文」的正式机制——**任何记录可以带 `supersedes: <被修订 id>`**：

- **当前版本** = 没有被任何记录 `supersedes` 的记录（`currentRecords`）；`lookup / brief / stats / audit / kit` 一律按当前版本取数；
- `node akasha.mjs revise <store> <id> --data '<json>'`（或 `--data-file <路径>`，省掉 shell 引号地狱）：从任意链上版本出发都落到**链尾的下一版**；新 id = `<根 id>-r<版本数>`；未打补丁的字段自动保留；记录里自动带 `supersedes`；
- `check` 会报**悬空引用**（`supersedes` 指向不存在的 id）；
- 前沿层复审快捷方式：`node akasha.mjs frontier recheck <id> --status <S> [--next-review D] [--note ...]`——修订 status / last_checked / next_review（默认 +90d 待验证 / +180d 其余）；
- 修订只追加、不改原文；链条可回溯（根 → r1 → r2 …）。
- **mirror 的「改口」就是修订链**：`node akasha.mjs revise mirror mirror-xxx --data-file reword.json`——境况/旧反应（situation/behavior）保留在旧版，新反应/结果/气质写进新版；「人生经验的改口」不覆盖历史，链条本身就是成长记录。

## 镜像结构匹配（mirror match，2026-10-07 起）

`node akasha.mjs mirror match <情境文本> [--limit N] [--mode task|improve|all] [--role solution|boundary] [--evidence story|own-log] [--era 子串] [--context 子串]`（MCP：`akasha_mirror_match`）——按**结构**匹配五元组（situation ×2）+ `patterns` 加权；可按证据口径 / 时代 / 语境过滤。返回 top N（五元组全文 + role / evidence / era / context / story / patterns）。
- **分层查询（wave1）**：`--mode task`（MCP `mode:"task"`）＝解法 + 未分层（做任务）；`--mode improve`＝边界 + 未分层（改流程 / 复盘）；缺省 `all` 不过滤（与旧行为一致）；`--role solution|boundary` 严过滤（只要该层）。非法值报错（exit 1），不静默放宽。

## 知识分层（wave4，2026-10-10）

路由（由近到远，**不**另开存储）：

| 层 | id | 说明 |
|---|---|---|
| 模型内建 | `model` | 官方模型知识；不可审计，只作起点 |
| 技能/插件 | `skill` | 宿主 skill / 工具说明 |
| 本地大图馆 | `library` | 本地库同步；**级别看 tier**（T1 已复现 / T2 自证·不升共识 / T4 他人·待补引）；原文不可变，注释走 `revise`；frontier 继续用 `frontier due` / `recheck` **排期刷新** |
| 外网检索 | `web` | **宿主可插**；core 只暴露 `webSearchRequest` / `knowledge.search` 契约（`interface: akasha.hostWebSearch`），按 **citation × credibility**（对齐 T1..T5 权重）排序建议；**不**在 core 实现搜索器 |

认知态（`knowledgeRoute` → `brief` / `lookupDetailed.knowledge`）：

| stance | 何时 | 说辞 |
|---|---|---|
| `known` | 有强命中 | 「记得·库内」；命中行带可信度层级 |
| `uncertain` | 仅弱命中 | 「不确定」——必须引用 `cites`（id / tier / ref），不得写成确定 |
| `confirmed-unknown` | 无可用证据 | 「确定不知道」——不要编；`search` 契约供宿主接外网 |

与既有可信度（wave2 §3）正交：T1..T5 只描述 **library** 层条目质量；分层决定「查到哪一层、如何开口」。

> **与 PROTOCOL「来源态四标签」的关系（2026-10-11 手检补）**：**本表是「检索侧」的机检结论**——库里有没有、命中强还是弱，由 `knowledgeRoute` **自动算**，用在 `brief` / `lookup` 的开口句 ✓（`akasha.mjs:48` 的映射：`known`→「记得·库内」· `uncertain`→「不确定」· `confirmed-unknown`→「确定不知道」）。**PROTOCOL 的四标签（学过 / 接触过 / 记得·库内 / 搜到）是「输出侧」的来源声明**——**模型自己标**这条断言从哪来 ✓。二者**正交、不互替**：一次回答完全可以「检索侧 `known`（库里确实查到）」而「输出侧标 `学过`（这条判据其实来自权重）」⇒ **混用会让人读不懂开口句** ✗（手检时确认二者不是漂移、是分工，但此前文档没写明 ✓）

## 弧线树 v0.3 · 自动建树（2026-10-12；`autoBuildTree`；CLI `session tree --auto`）

**v0.3.1 调参（2026-10-12 同日追加，用户令「调细吧」）**：新增 **`segCap`（默认 40）**——单块段数上限，与 `chunkTurns`（轮数换块）**并联生效**，先到先切。
- **病根（实测）**：超长 turn 会把「只按轮数切」憋成巨型块——本会话曾出现 **1006 段/块**，7fe8ec84 最大 **835 段/块**，导致整会话只有 3–4 个节点。
- **选值依据（13 会话对照，只读测量）**：cap=40 ⇒ 合计 516 块/最大 40；cap=30 ⇒ 687；cap=25 ⇒ 835；cap=20 ⇒ 1032。取 **40**（≈一轮实料；再细则节点翻倍、渲染与检索变吵）。
- **实测效果**：`391c6ea4` 4 → **48 节点**（36 块）｜`7fe8ec84` 53 → **507 节点**（385 块）｜`f362b992` 37 块；三棵树最大块 **= 40**（硬约束成立）。
- 关掉上限：显式传 `segCap: 0`（守卫里用它做旧行为对照）。
- 打包：`@akasha-book/akasha-session` **0.3.2-h5**（restart-required）。

- **两条闸（机械、无 LLM）**：
  1. **签名未变即复用**——指纹 = `{segCount, latestSeq}`，挂在新代节点的 `treeFingerprint` 字段（**不新增元数据档**）；一致 ⇒ `{built:false, reason:'fingerprint-unchanged'}`。
  2. **节流**——`minIntervalMs`（默认 10 分钟，从上一代的 `logged_at` 推 lastBuildAt）内不重建 ⇒ `reason:'throttled'`（带 `nextEligibleInMs`）。
- **旧代留档 + 无损可展开**：重建 = 新 `treegen` 整批追加；旧代原地保留（append-only）；节点带 `children`/`ptr`，全保真仍走 **ptr 回原档**（语义不变）。
- **接通点**：`@akasha-book/akasha-session` 的索引成功回调（`tree-auto` 观测线：`{built, reason, treegen, nodes, segCount}`；失败落 `tree-auto-error`）。**热替换说明**：本轮把插件 `index.js` 同步进 profile（回滚点 `index.js.bak-pre-treeauto-20261012`）——**插件侧最终仍走下次插件批次统一打包**。
- CLI：`session tree --auto --session <id> [--interval ms] [--force]`（`--force` 跳过两道闸）。
- 真库实测：7fe8ec84 首建 **71 节点 / 15388 段**；二跑如实 `fingerprint-unchanged`。

## 英文盲区修复（2026-10-12；`loop-detect.mjs` 双门槛 + 词级 bigram）

- **病灶**：窗口合格线原为「bigram 多样性 ≥10 **且 CJK ≥20%**」⇒ **纯英文/低 CJK 文本整段失明**（挡星号线/代码碎片的设计代价，收口点复核 F3 记录在案）。
- **修法（选项 B）**：`windowGate()` 双门槛——**中文线** CJK ≥20%（原线保留）**或 字母线** `[A-Za-z]` ≥50%；相似度集合并入 **`wordBigrams()`**（相邻两个纯字母词，如 `the|pipeline`）——英文靠词级、中文仍靠字级。
- **反侧不破**：星号分隔线 / 纯符号仍不合格（无字母无 CJK）；正常中文散句零误报（守卫 3 条反例）。
- **复检（旧语料重扫，2026-10-12）**：小会话全 0；两大会话新增命中 **26** 条，全部为**代码/参数在 reasoning 里的重述**（2026-10-07 基线即记为「良性」的同一类）⇒ 新增 `looksLikeCode()` **分级标记**（`exact[].codeLike`，CJK <10% ⇒ true；**只分级不改变检出**）。
- **口径**：检测器只报「文本重复」事实，**不判良恶**；`codeLike` 让人一眼分辨「代码重述 vs 散文打转」。
- 守卫：`test.mjs`「英文盲区」正反例 4 条（英文必报 / 分隔线不报 / 中文散句不报 / 中文重复块不回归）。

## 盲区地图 + 纪律单源渲染（#16 / #27，2026-10-12 窗口 9）

**#16 盲区地图（`blindspotMap`；CLI `blindmap <词…>`）**

- 输入一批查询词 → 逐条分级：`blind`（**无强命中**）· `thin`（强命中不足）· `covered`；每条带 `reason`（为什么算盲区）+ `action`（下一步怎么走：progressiveRecall / 标注来源态 / 落 orphan）。
- `summary` 给计数并明说「**这是法定输出**（不许静默省略）」。
- 与 #4 BLINDSPOT 的分工：#4＝「**面**没检」（会话层/外网）；本件＝「**查询邻域**空或薄弱」。

**#27 纪律单源渲染（`DISCIPLINE` → `renderDiscipline()` / `verifyDiscipline()`；CLI `discipline [--check F]`）**

- **单源**＝`DISCIPLINE`（version + sections: 来源态 / 排序钉子 / 红线 / 库界 / 写入）；`renderDiscipline()` 出 Markdown（含「勿手改」抬头）。
- `verifyDiscipline(text)` **逐行比对**：不一致 ⇒ `ok:false` + 前 10 处差异（行号/期望/实得）——**漂移必被抓**（实测：改一个字即报「行 14：期望 «…零编造（一票否决）» 实得 «…零编造（改过）»」）。
- 用途：对外文档/注入文本改从单源生成；改纪律只改一处。

## 写入回执 + 代际指纹（#23 / #24，2026-10-12 窗口 8）

**#23 committed 语义（`committedOf`；CLI `add` 已接入）**

- 回执形状固定：`{ok, committed, id, reason}`——**未落盘不得口头「已收入」**；成功 `reason:null`，失败 `committed:false` + 原因。
- CLI `add` 两条路径实测：失败（缺字段）→「未落盘：校验失败…（committed=false）」；成功 →「已追加：…（committed=true）」。
- 范围（如实）：本轮只统一**核心 CLI 的 add 面**；`revise`/`retire`/promote 等写面**仍走各自返回值**（形状已兼容 `committedOf`，可逐步接入）。

**#24 代际指纹（`generationInfo` + `CODE_GENERATION`；CLI `generation`）**

- `code_generation` = **模块加载时**核心三件（lib/session/sleep）mtime 指纹（进程内恒定）；`disk_generation` = 当前盘上指纹。
- 不一致 ⇒ `stale_on_disk:true` / `restart_required:true`（**「跑的是旧代码」一眼可辨**）；一致 ⇒ 明确说「无需重启」。
- 用途：升级/修 bug 后自检（对齐灵枢 `cg(op=info)`；也解释「为什么改了代码没生效」）。

## 校准 / 否定降权 / 渐进式检索（#15 / #25 / #26，2026-10-12 窗口 7）

**#15 来源态校准（`calibrationOf`；CLI `calibration`）**

- 输入 `[{confidence, correct}]` → `{gap, ece, buckets, n, ok, note}`：**gap = 平均自报 − 实际正确率**（>0 过度自信）；`ECE = Σ(桶占比 × |桶内实际−桶内自信|)`。
- **纪律**：样本 < `minN`（默认 10）⇒ `gap/ece=null` 且 `ok=null`；**当前库无此采样**（自报把握 × 实测对错）⇒ CLI 如实报 `ok=null`——**采样机制本身是下一个缺口**（候选：复盘时顺手记 `confidence`）。

**#25 否定/反事实降权（`negationPenalty`；`lookup --negation-penalty`）**

- 判据：正文含**强否定/撤回标记**（作废/失效/不再成立/被拒/撤回/不采用/不可用…）⇒ 系数 `0.75^n`（最多三档）。
- **只进排序键**（`rank × negFactor`），**不改 score、不改命中面、不隐藏**（A5）；**默认关**。

**#26 渐进式检索（`progressiveRecall`；CLI `recall`）**

- 宽（原查询）→ 逐步收窄（词数递减）分步实跑，每步给 `{query, tokens, hits, strong, stance}`；**DEFER ≠ 失败**（空查询显式 `deferred:true`）。
- 用途：残缺 query 也能收敛；把「宽面偏大」变成可执行的多步计划。

## 负记忆两层 + 盲区显式化（#2 / #4，2026-10-12 窗口 6）

**#2 负记忆（`data/negative.jsonl`；`recordRejected` / `listRejected`；CLI `negative [list|add]`）**

- 两层：`kind: 'rejected-write'`（**被拒的写入**——gate/门控拦下的尝试）｜`'undecided'`（**未决**——等数据/等裁定）。
- 字段：`{id(neg-…), ts, kind, reason, what(≤200 字), ref}`——**只记 kind/reason/短描述，不记正文**（防把负记忆当第二资料库）。
- **与六库分隔**：独立文件、不进 `STORES`、不参与检索排序与 `check`（它是「走不通的路」的档案，不是知识）。
- 用途：失败回查原料（「这条路试过、为什么不通」）；下一批可接 `metrics` 读数（回滚/失败面）。

**#4 BLINDSPOT 显式化（`blindspotsFor`；`lookup`/`brief` 返回体 + CLI `blindspots`）**

- 形状：`[{what, why, action}]`——**这次没检的面**必须说出来（对齐「确定不知道」的诚实口径，**不静默省略**）。
- 常驻两条：会话层（单入口设计，走 `session lookup`）· 外网检索（宿主未接）；带 `--perspective` 时追加「未标 perspective 的条目不参与过滤」。

## fail-loud + perspective（#36 / #37，2026-10-12 窗口 5·2）

**#36 fail-loud（`assertDataRoot`；CLI 启动即验）**

- 判据：数据根**目录存在**且**至少一个库文件存在**；否则 CLI **报错并 exit 2**——**绝不静默建空库装健康**。
- 覆盖：`AKASHA_ROOT` 环境变量现已真正生效（此前只在文档里；本轮把 `DATA` 改为可覆盖）——迁移/演练/坏根测试都用它。
- 例外：自举类命令（将来加 init/doctor）不验；其余读命令全部先验。

**#37 perspective（`world` / `experience`）**

- 字段：`perspective: 'world' | 'experience'`（可选，人工填；`experience`＝自己踩过的坑，`world`＝教材/常识）。校验：非法值 `check` 拒。
- 检索：`lookup --perspective experience|world`——**只过滤命中面、不加权、不改排序**（A5）；缺省条目不参与过滤（视为「没标」）。
- 现状（如实）：**活库 0 条已标** ⇒ `--perspective experience` 现为「无结果 + confirmed-unknown」（诚实返回，非故障）。标注从下一次复盘起逐步补。

## 可解释性三件（#31 检索梯 / #35 trace / #33 expand，2026-10-12 窗口 5）

**#31 检索梯 `brief.ladder`（+ CLI `brief --ladder`）**

- 形状：`[{layer, hit, stopped, why, note}]`，层级固定：`canon-strong → canon-weak → other-strong → orphan → session → web`。
- **停点唯一**（有且只有一层 `stopped:true`）：有强命中即停在 `canon-strong`（why=「命中足够，未继续下钻」）；其余层给「为何没下钻」（无命中 / 被上层截停 / 未开——会话层走 `session lookup`、外网宿主未接）。
- 纪律：**只提示不拦截**（不改检索行为，只是把「停在哪一层」说出来）。

**#35 `lookup --trace`（+ `lookupDetailed().trace`）**

- 形状：逐条 `{id, store, score, rank, strong, tier, displayTier, stale, severity, complexity, factor, factorApplied, balance, zeroWeight}`——**计分零件全摊开**（可审、可复核、可 A/B）。
- 口径自证：孤案/零权重 ⇒ `factorApplied:false`（rank=score）；`balance.enabled:false` ⇒ 校正 1。

**#33 `show <id> --expand`（+ `expandRecord()`）**

- 行为：先取链尾 → 沿 `promoted_from` 回溯（可多层）→ 返回 `{found, id, store, origin, chain, note}`；id 逐库查找。
- **悬空如实**：源段不在 `session.jsonl` ⇒ `origin.dangling:true`（不编、不吞）；无 `promoted_from` ⇒ `origin:null` + note「原生条目」；提示全保真路径＝`ptr 回原档`。

## 外置 policy + directive 级门控 + citeAllowlist（#28 / #34 / #30，2026-10-12 窗口 4）

**policy（`loadPolicy` / `isWriteTool` / `policyDeny`，`lib.mjs`；gate 消费）**

- **默认内嵌**（= gate 现行为 + 补面）：`writeTools: edit/write/apply_patch/**ops_replace**` · `shellTools: pwsh/bash/dsh_wsl/**ops_bash**` · `forbidden: [akasha-data-direct-write]`（拦直写 `akasha/data/*.jsonl`）· `directives` 清单（`data-direct-write` = gate 硬拦；`irreversible-backup` = 软提示）。
- **外置**：`akasha/policy.json`（`AKASHA_POLICY` 可覆盖路径）存在则**并集合并**（默认 ∪ 外置 ⇒ **外置只许更严**）；`forbidden[]` 形状 `{id?, pattern, why?}`，匹配前把 `\` 归一为 `/`（避免转义地狱），命中 ⇒ 拒绝写该目标。
- **空策略不假装合规**：外置某面为空 ⇒ 记 `warnings`（gate 侧同样告警），绝不静默放行。
- **#34 落点**：`data-direct-write` 保持 **gate 硬拦**；`ops_replace` / `ops_bash` 补进拦截面（dsh-ops 落地后的新写盘入口）；gate selftest 覆盖清单同步 +2 条。**gate 1.3.0-h5 已装（restart-required，待下次重启激活）**。

**citeAllowlist（#30；lookup / brief / cross / show / session lookup / --recall 返回）**

- 形状：`[{id, store, tier, strong}]`——**本回合取回的 id 清单**（事前形状；事后仍由 `output-audit` 抓假 id）。lookup / brief 的清单在裁剪前定稿（与 main 一致，裁剪不改写它）；cross / show 为本轮返回。
- 软协议：本回合断言**优先引用清单内 id**；清单外 = 无据（要么先查、要么明说不知道）；**零命中 ⇒ 空清单**（不冒充有据）。
- 轻量核对：`checkCitations(cited, allowlist)` 返回 `{ok, outside, allowed}`，只报引用是否落在本轮清单内，**不拦截**任何读/写通道。

## 回滚命令化 + 自治读数族（#19 / #1，2026-10-12 窗口 3）

**#19 `rollback`（追加反向修订，不删原文）**

- 语义：对「指定日期起**新增的修订版**」，追加一条**反向修订**（内容=前一版；新 id = 被打版 `+r1`；带 `rollback_of` 指回被打版），**绝不删原文**（append-only 不破）。
- 命令：`node akasha.mjs rollback <store> [--since YYYY-MM-DD] [--apply]`——**默认 dry**（只出计划）；`--apply` 才写；**幂等**（已回滚过 ⇒ 计划清空、重跑无事可做）。
- 禁止：协议条（`canon-akasha-usage*`）不可批量回滚（须人工 `--allow-protocol`）。
- 验收：守卫（dry 不写 / apply 还原内容 / 二次 dry 为空 / 行数只增不减）。

**#1 自治读数族 `readings`（只读·如实）**

- 命令：`node akasha.mjs readings`。五读数：`recallMissRate`（失败回合未先查库占比，97 线）/ `toolFailureRate` / `refuteRate`（verifier 行；**当前线未铺 ⇒ null**）/ `samePitRecurrence`（同工具错误 ≥2 次的组数）/ `rollbackChains`（含 `rollback_of` 的修订链占比）。
- **纪律（用户口径）**：**样本不足 ⇒ `value:null` 且 `ok:null`**（never PASS）；缺失项在 `missing` 点名、每项带 `note`；绝不静默、绝不冒充。
- 现状如实：`ok=null`（缺 `refuteRate` —— verifier 观测线未铺）；其余四项可算。


## 可复现性 · 同分次序（#8，2026-10-12 窗口 3）

- **次序显式化**：`lookup` 排序 = `rank ↓` → `score ↓` → **时间（新者优先）** → **id 升序**。前两级同分时**不再依赖插入序**（数组顺序＝档案顺序，跨索引批次会漂移）；后两级保证「同一查询任意两次运行结果全等」。
- **验收**：连跑 10 次结果全等（守卫）；真库四个查询复核通过。
- **不变量**：top-20 上限不变；`strong` 仍只看整词命中；孤案 `rank=score`。

## 多路召回 + RRF 融合（#7，2026-10-12 窗口 3）

- **默认关**：`lookup --recall` / MCP `akasha_lookup {recall:true}`；不带参数行为与并前**完全一致**（route-off 零变化）。
- **路**：① **词法路**（`lookupDetailed`——现有计分与四因子重排在**路内**生效）；② **引用路**（#6 关系边的**反向索引**：谁引用了词法命中者 ⇒ 带回「结构邻居」）。
- **融合**：`RRF = Σ 1/(k + rank_i)`（k=60）；**RRF 只定名字与次序，最终仍按现有四因子重排**（A5：修正不替代主语义）。
- **可审计**：返回 `rrf:{lexical,citation,k}`；每条带 `rrfScore` / `paths:['lexical','citation']`。
- **边界（如实）**：会话层路未并入（跨库，需要时另开）；引用路只扩「两步内」邻居；真库现仅少量 `relates_to` 边 ⇒ 引用路目前收益有限，随关系边增多而变强。
- **A/B 实证（真库）**：「三套系统 边界」单路 20 → 多路 20，**引用路 +1**（`canon-rank-controller-view-20261012-r2`，词法本没命中）✓

## 触发词路由与反射字段（#13 / #10，2026-10-11 起、2026-10-12 窗口 2 补校验）

- **字段**（canon 可选）：`hint`（**≤80 字**反射文本——「改条目＝改反射」）、`triggers`（触发词数组，非空字符串）、`hint_until`（到期日 `YYYY-MM-DD`，过期即不打）。
- **运行时**（`@akasha-book/akasha-sleep` ≥1.5.x，插件侧）：每回合读最近用户消息 → 命中 `triggers` 且条目未退役 / 未过期 / `when`（#9）成立 ⇒ **动手前**注入一行 `[触发] <词> ⇒ <hint> —— 条目 <id>`；**同条 30 分钟一次、每回合最多一条**（防刷屏）；`triggerRouting:false` 可关。
- **校验**（2026-10-12 窗口 2 补）：写入侧走核心 `validateRecord`——`hint` 非空且 ≤160 字硬上限（超长会被显示侧 80 字裁剪，故拦）、`triggers` 非空字符串数组、`hint_until` 日期形。
- **与「坑前提示」同族**：后者由工具名/动作自动匹配（`hintForTool`）；本字段是**条自带触发词**的通用形态。
- 现状：活库 15 行带 `hint`，其中 2 条带 `triggers`（`canon-trap-edit-context-mismatch-r2` / `canon-trap-quoting-escapes-r2`）。

## 条件谓词化 + 不适用条件（#9 / #3，2026-10-11 起、2026-10-12 窗口 2 收口）

**#9 条件谓词化**（`validateCondition` / `evalCondition`，`lib.mjs`）：把「生效条件 / 不适用条件」从散在代码里的 `if` 变成**跟着数据走的 JSON 条件**（可查、可审、可单测）。

- **原子**：`{ field: 值 }` ⇒ 相等；`{ field: { eq|ne|gte|lte|in|contains: 值 } }`。
- **组合**：`{ and: […] }` · `{ or: […] }` · `{ not: 条件 }`。
- **纪律**：**非法条件抛错，绝不静默放宽**（未知算子 = 非法）；求值只读、无副作用。
- **不写编译器**（C 组裁定）：要的是可审计性，不是可编程性。

**#3 mirror `not_applicable`**（2026-10-12 窗口 2）：

- 字段：`not_applicable: <条件>`（可选；命中 ⇒ 该镜像在**当前处境**下不适用，应被排除）。
- 校验：形状与算子合法性走 #9 校验器（非法条件进 `check` 失败）。
- 检索：`mirror match <文本> [--na '{"field":"值"}']`——`--na` 传**当前处境的事实对象**；不传 = 不过滤（缺上下文 ≠ 不适用）。MCP `akasha_mirror_match` 同步 `notApplicable`。
- **只读过滤**：不改写、不删条、不排序加权（A5 纪律：修正不替代）。
- 活库现状：**10/10 条已按修订链补标**（`-r3`/`-r4`）；`check` 全绿。
- 验收：`test.mjs` 两条守卫（形状能红 + 接线能红 + 不误伤）。

## 排序补齐（严重度 × 可信度 × 复杂度，wave3，2026-10-10）

`lookup` / `brief` / `cross` 的 **rank**（排序权重）在可信度系数之上再乘严重度与复杂度。只影响排序与命中行上的 `severity` / `complexity` / `factor` 字段；**不改存储**，不新增 schema 字段。

```
factor = credibility × severity' × complexity'
rank  = (词法分[+ frontier 状态][+ 负价 tip]) × factor   // 孤案：rank = 词法分（zeroWeight）；命中带 factorApplied:false（factor/severity/complexity 仍给出对照，但不乘进 rank）
```

- **credibility**：已有 `credibilityOf(...).weight`（T1..T5；refuted = 0）。过期只降展示层，不改这个系数。
- **severity**（不写库，从已有字段读）：`orphan.severity` 高/中/低 → 1 / 0.75 / 0.5；`pricing.severity_default` 1..5 → n/5；否则若有 `arousal` → `0.5 + 0.5×arousal`；再否则 1。
- **complexity**（无独立字段）：若严重度已来自显式 severity 且有 `arousal`，则 `arousal` 映射为复杂度代理；若严重度已来自 `arousal`，复杂度固定 1（防双计）；否则 1。
- **类别模板**：由 `credibilityOf.cls` 选定（protocol / snapshot / frontier / evergreen）。**协议条**强制 severity'=complexity'=1（不让 arousal 抬协议排序）。
- **时间**：仍只做 `--since/--until` 过滤与有效期门，**不是**主排序权重。
- **strong / weak**：仍只看 `scoreTokens` 整词命中 ≥ 1；乘子不参与。
- **A1 检索负载均衡**（`research/weight-internalization-pid`）：默认 **关**（`RANK_DEFAULTS.loadBalance === false`）。CLI `--load-balance` / MCP `loadBalance:true` 才启用。只乘校正项，**不改** score/strong、不隐藏、不删条，与 credibility/pricing 正交。
  - 误差：条目近期 `usage` 次数 vs 软配额（窗口内 total/distinct）。
  - 超配额 → 降（P，防垄断）；窗口零引用且本命中为弱命中 → 探索加成（防饿死）；集中度 HHI 斜率上升超阈 → 对超配额项再刹车（D；改善不抖）。
  - **常驻提示豁免**：协议类（`cls === "protocol"` / `canon-akasha-usage*`）∪ 自我层（id 前缀 `canon-self-concept` / `canon-address-layers` / `canon-memory-auto-record`，或 tag『自我』）不参与上述校正，`correction` 恒为 1，`reasons` 含 `protocol-exempt` 或 `self-layer-exempt`——每会话必引的条目不被当成垄断。
  - **根 id 归一**：usage 日志与检索命中可能混用根 id / `-rN` 版 id；`usageWindowFromRecords` 与 `loadBalanceCorrection` 两侧均经 `rootIdOf`（剥尾部 `-rN`）再计数/查表，修订链用量可累积。
  - 参数：`LOAD_BALANCE_DEFAULTS`（windowMs=7d，kP/kExplore/kD，slopeThresh，min/maxCorrection）。命中行带 `balance: { correction, count, quota, reasons, params }` 可审计。
- **emotionBoost**：API 保留；`brief` 的 base 不再加 arousal（改走严重度乘子），负价只留 +0.25 tip。

## A2 上下文预算分配（wave4 · DeepSeek-V4.1-Flash / CSA2 S=2）

默认 **关**（`CONTEXT_BUDGET_DEFAULTS.enabled === false`）。`kit({ contextBudget:true })` / CLI `budget --enable` 才计算。只分配各注入来源的 **token 额度**，**不改**排序、strong/weak、存储与修订链。`self`/`usage` 豁免敌对缩额（同 A1）。

**来源**（`CONTEXT_BUDGET_SOURCES`）：`self` / `usage`（协议用法条）/ `kit` / `session` / `retrieval`。

**公式（误差驱动，小步近平衡，恶化才刹车）**：

```
rescueNorm = min(2, rescues / rescueScale)
idleNorm   = min(2, idle / idleScale)
rawΔ       = kRescue·rescueNorm − kIdle·idleNorm
若 |rawΔ| < nearEps → rawΔ *= kNear
若 idleSlope > slopeThresh 且 idleNorm>0 且 rawΔ≤0
           → rawΔ -= kD·(idleSlope−slopeThresh)/slopeThresh
若来源 ∈ exemptShrink（self/usage）且 rawΔ<0 → rawΔ = 0
share'     = clamp(baseShare·(1+rawΔ), minShare, maxShare)
归一化后 tokens = round(share·totalTokens)   // 不再强制偶数对齐
```

**相位稳健（生产主策略＝冗余，不是 padding）**：

- V4.1-Flash CSA2 **S=2** 存在 stride-周期：偶 residue 组准确率系统高于奇组（论文 Δres≈6.09pp @128K 极端；日常短上下文更弱）。相位由 **provider 内压缩边界 + 整段 prompt 分词** 决定——**客户端无法对齐**。
- 论文里的 padding / 取齐 stride 是**实验对照**，不是修复。`alignTokenCount` / `padBlockToStride` 仍导出，标为 `experimentalControl`。
- **冗余放置**（`placeWithRedundancy`）：关键事实/片段至少两份，中间奇数 token 偏移以翻转 residue，使至少一份落在较好相位；先 `nearestFetch`（按 distance↑ / priority↓）缩短暴露距离。
- **验收**（`phaseResidueSample`）：多长度前缀扰动（预算变化会改相位）→ 按 residue∈{0..S−1} 采样 → **主指标 best−worst gap**（不是只报平均）；附 `residueMeans` / `residueGap` 对照论文 Δres。CLI：`budget --phase-check <文本>`。

**信号**：`budgetSignalsFromRecords` 读 `kind:"budget-rescue"|"budget-idle"`（带 `source`），兼认 gate-self/usage、召回工具等。审计：`sources[s].{share,tokens,rawDelta,reasons,…}` + `phase.method=redundancy+nearest-fetch`。

## 装载/注入面契约（per-call cap，2026-10-12 窗口 1 落地）

> 与 A2（自适应分配器，默认关）**解耦**：本契约＝「每次查阅的 token 天花板」，**默认生效**（`opts.contextBudget === false` 可关）。实现在 `clipByBudget`。

- **地板保底**：**全条目都装不下**时，仍返回**排名第一**（`floorApplied: true`）——不许「空结果 ≈ 库里没有」。
- **单条自跳**：某条自身超上限 ⇒ 只跳它，**后面更短的照收**（`oversize` 单独记账）；不许大条目卡死整页。
- **可观测**：每次返回的 `budget` 带 `truncated`（= 被上限裁掉的条数，与 `trimmed` 同值）· `oversize` · `floorApplied` · `nextOffset`，并在 `hint` 里写明续取方式。
- **默认上限 4096 tok**（天花板的性质、防跑飞；实测 lookup「记忆」1485 / cross「记忆」2544，均不被裁）。
- 验收：`test.mjs`「#29 装载契约」守卫（地板 + 自跳 + 可观测 + 默认不误裁）。


## 视角字段（perspective，预留·2026-10-12 立口径）

- **`perspective: "world" | "experience"`**，**可选**；`world`＝别人说的（教材/公式/常识/典故），`experience`＝我们自己踩过的（亲历的坑、代价、恢复过程）。缺省 = 不填 = 不过滤（旧条目零破坏）。
- **只许人工 / 升格时填**——**禁止自动 LLM 抽取**（抽取会制造「看起来很真」的伪亲身经历，正撞零编造红线）。
- **检索**（解冻后接）：可选参数 `--perspective experience|world`，**只做过滤、不改加权、不改排序语义**（A5 纪律：修正不替代）。
- **校验（待接）**：非法值（如 `"fact"`）→ 应当在 `check` 被拒；**当前 check 尚未校验此字段**（如实标注）——校验器接线与检索过滤同批，列入「窗口 1/2 吸收批次」待解冻。本条与「双时态展示」同属输出/字段口径族——**字段先立、过滤与校验后上**。
- 来源：Hindsight 对照 #37（2026-10-11 裁定接受）；口径定稿 `docs/hindsight-learnings-evaluation-20261011.md` §二 #37。

## 情绪字段（valence / arousal，2026-10-07 起）

- 任意库记录可带**可选** `valence`（[-1,1]）与 `arousal`（[0,1]）；越界拒绝（pricing 库的 `valence` 仍为必填）。
- **回写通道**：`node akasha.mjs price --severity N --irreversibility N --cost N [--good|--bad] --apply-store <store> --apply-id <id>`（MCP `akasha_price` 的 `applyStore/applyId`）——计算后经**修订链**写回该条目（追加新版，不改原文）。
- **用途**：`arousal` 进排序严重度乘子（见上「排序补齐」）；负价在 brief 行前加 `⚠`，并留 +0.25 tip。`emotionBoost`（arousal×0.5+负价）API 仍保留可测，但 brief 排序不再把它整段加进 base。`kit.history` 输出负价 top3（**病史负价注入**的最小形态）。

## 输出审计与使用计数（v0，2026-10-07 起）

- 钩子插件（`@akasha-book/akasha-hooks` v1.2）监听 `agent/assistant-stream`，对 committed 的 assistant 文本跑 `auditText`（纯函数）：
  - 引用**不存在**的库 id → `output-audit` 观测线（编造引用嫌疑）；
  - 引用**真实**库 id → `usage` 观测线（**条目级使用计数 v0**）。
- **v1.2 修复（2026-10-07 复查）**：官方 revision **逐帧递增**——累积必须按 `attemptId` 连续（修复前按 revision 重置 ⇒ 每 chunk 清空、`output-audit`/`usage` **恒 0 条**）；id 跨帧切分可还原。
- 边界（诚实）：assistant-stream 为 emit 语义——**只审计、不拦截**（「幻觉闸门」的输出改写留待宿主能力）；审计只做可机检硬核（id 存在性），「无据的普通断言」的语义审计留待未来。

## 结果计数器（metrics，2026-10-07 起）

`node akasha.mjs metrics [--since D]`（MCP：`akasha_metrics`）——工具成功率 / 门控拦截 / agent 错误 / 回合 / 睡眠 / 唤醒条 / 审计线 / 引用命中 / 修订链统计（总数与最长链）；数据源＝`logs\hooks.jsonl` + 六库修订链。

**召回信号（`recall`，wave1 · B2）**——双路召回漏掉的，只能事后从日志认出：
- **按会话分区**（wave1.1）：会话 id 取宿主真值——`tool` 线的 `session` ＝ `tools/result` 的 `exec.agent.id`（DSH `ToolExecution.agent` 由 agent loop 设置；`Agent.id` 类型即 `SessionId`）；`turn-end` 的 `session` ＝ `session/event` 的 `session.id`；`agent-error` 的 `session` ＝ `payload.agent.id`。三者同值（agent 以其会话 id 为身份；`session-` 前缀归一）。窗口＝**同一会话内**相邻两条 `turn-end` 之间，并发会话互不混窗；子代理有自己的会话 id，单独成窗。
- 旧日志兼容：不带 `session` 的行进「未归属」窗口（＝旧的全局口径），任一 `turn-end` 都会关闭它；未归属的召回对同期任何会话都算数（宽口径，不夸大漏召）。`recall.sessions`（分区数）/ `recall.unattributed`（未归属行数）标出口径。非 agent loop 发起的工具调用（无 `exec.agent`）本来就没有会话，归入未归属。
- 召回＝只读查库面成功调用：MCP `mcp__akasha__` + {`akasha_lookup` / `brief` / `cross` / `kit` / `show` / `summary` / `mirror_match` / `session_lookup` / `frontier_due`}，或 hooks 在 shell 工具线上标注的 `akashaCli`（akasha CLI 查库子命令名，只记子命令、不记命令原文）；
- 失败＝非记忆工具 `ok:false` 或 `agent-error`（记忆工具自身失败、`gate-denied` 不计）；每窗口只看**第一次**失败；
- 计数：`failureTurns`（有失败的回合）/ `recalledBefore`（失败前查过库）/ `misses`（失败前没查库）/ `lateRecall`（miss 中事后才查）/ `missRate` / `samples`（≤5，`{ts, what, session}`）。
- 同一口径进睡眠报告 `counters`（`failureTurns` / `recalledBefore` / `recallMisses` / `lateRecall`），门口条子在 `recallMisses>0` 时追「失败前未查库 m/n 回合」；**并进待办（wave1.1）**：`buildTodos` 追加 `{ kind:"review", code:"recall-miss", count, failureTurns, lateRecall, note, samples }`（排在最后，样本带会话 id），随批次写入 `logs/inbox.jsonl`；属复盘项，`promote` 不会把它自动转成孤案。只计数、不判语义：漏召是否「本该查到」由复盘（模型 / 人）判断。

## 关系边（relates_to / relations，2026-10-12 窗口 1 解冻批落地）

- **字段（均可选）**：`relates_to: [id…]`（无类型关联）· `relations: [{ type, id }…]`（带类型；`type` 为**自由字符串**——无白名单，如 `supports` / `contradicts` / `relates` / `promoted_to`）。缺省 = 不过问，旧数据零破坏。
- **校验分两层**：
  - **形状层**（`validateRecord`）：`relates_to` 须非空字符串数组；`relations` 须对象数组且每项 `type`/`id` 非空字符串。
  - **悬空层**（`checkRelations`，同库）：目标须能在同库解析——① 精确命中任何行 id；② **修订 id 形状 `root-rN` 解析到根 id**（防「引用被修订过的条目」误报）。解析不到 ⇒ `check` 报「指向不存在的 id」。
- **边界（如实）**：只查**同库**；跨库引用（如 canon 引 orphan）暂不校验，需要时再开。`retires` 墓碑 id 可解析（历史可溯）。
- **用途**：引用完整性从「正文文本扫描」升级为**结构检查**；#18 冲突检测（`contradicts` 边型）依赖本字段。
- 命令：`node akasha.mjs check`（全库；关系错误随行报出）。测试：`test.mjs`「#6 关系边」守卫（能红 + 不误伤 + 修订 id 不误报）。

## 冲突检测（#18，2026-10-12 窗口 1 落地）

- **纪律**：**只提示不裁决**——检测器只报「同题并存候选」，是否真冲突**永远由人经修订链处置**（对齐红线「同题多源不合并」）。
- **判据（两段）**：
  1. **撤回侧**：条目文本含**显式撤回/更正标记**（`作废 / 失效 / 不再成立 / 已废弃 / 已放弃 / 已推翻 / 已排除 / 被拒 / 拒绝采纳 / 撤回 / 取消采用`）——**刻意不用「不/无」等高频字**（凡长文皆有，判据会失效；真库校准实证）。
  2. **同题侧**：与另一条共享 ≥3 个**稀有词**（document frequency ≤3；词面＝词级 token + **纯 CJK 二字组**，去标点混入），且 **Jaccard（稀有词面）≥ 0.02**。
- **排除**：已被修订链显式处置的（互为祖先/后代）不算候选——那是「已裁决」。
- **输出**：按 Jaccard 质量排序，**默认上限 20 对**（去重 A×B / B×A）；每对带 `ratio` / `common` / `markers` / 固定 note。
- **命令**：`node akasha.mjs check --conflicts [N]`（默认打 12 对；`--json` 取机器面）。实现在 `detectConflicts`（`lib.mjs`）。
- **已知边界（如实）**：判据是**词面**的——「同义改写说反话」检测不到；词面撞车也可能报出「非真冲突」的候选（故只提示不裁决、且给证据供人快速判读）。

## 会话层（session，2026-10-07 起）

单会话记忆层（设计稿 `docs\superpowers\specs\2026-10-07-session-akasha-design.md` v0.4；计划 `docs\superpowers\plans\2026-10-07-session-layer-v0.md`）：会话档案（含官方压缩掉的历史）→ 段级条目 → 结论优先检索。

- 数据：`data/session.jsonl` + `data/session-meta.json`。这是**同库分层**（v0.1→v0.2，独立库方案已撤回），不是第二套产品：同一 CLI / 同一数据目录 / 同一 MCP 进程。段不进六库 `STORES`，因此 `audit` 不扫它，避免污染 canon。升格入口见下方（另写六库记录 + `check` 只核对 id 与标记）。
- 段字段：`id`（`seg-<sid8>-<seq>-<指纹>`，同内容幂等、档案重写漂移追加新版）/ `store:"session"` / `session` / `seq` / `time` / `turn` / `step` / `kind`（intent / action / conclusion / process）/ `gist`（截断 200–400 字）/ `why`（可选）/ `keywords`（≤12）/ `tools`（**只记工具名，不记成败**）/ `ptr`（原档指针：`seq`；action 另带 `callSeq`）/ `logged_at`。
  - **id 方案（2026-10-15 更新）**：`sid8` ＝ 「会话 id 去 `session-` 前缀后的前 8 字符」+ `-` + `fp8(sid)` **全 8 hex**。原 `sid.slice(0,8)` 在 `session-` 前缀上恒等（该前缀恰 8 字符）⇒ 前缀会话段 id 撞号、被静默跳过；且**指纹若只取前 4 hex**（djb2 高 16 位）对「仅末尾 1 字符不同」的 id 恒定不敏感 ⇒ 必须全 8 hex。会话 id 另有**归一约定**：入库一律存**裸形态**，读侧 `sessionMatches` / `resolveSessionPrefix` 兼容两种形态（老键仍可查）。
- **升格（wave2 §1）**：`conclusion` / `action` 可另写一条六库记录（不是把段搬进六库）。六库可选 `promoted_from`：`{ store:"session", id, session, seq, at, replay?, replay_at? }`。`replay` 只允许 `"manual"`，且**仅** canon 的 `source.type=复现` 必填——段里没有成败，不能代核，须 CLI `--confirm-replay`。其它来源写了 `replay` 即拒绝。会话侧只追加 `kind:"promotion"` 标记（`{ id, seg, promoted_to:{store,id}, at }`，不进检索正文）；lookup 命中折叠 `promoted_to`（目标已软退役则 `retired:true`）。命令：`session promote <segId> --to <store> [--data '<json>'] [--confirm-replay] [--apply] [--repair]`。**`--to` 必填**（拿不准用 `orphan`，零权重，不是默认）；**默认不写**，`--apply` 才写。先写六库再写标记。`check` 三向：段不存在 / 标记指向的六库记录不存在 / 有 `promoted_from` 却没标记（`--repair` 只补标记）。没有升格记录且 `session.jsonl` 不存在时 check 不读它；有升格记录但文件缺失 → `promotion-session-missing`；坏行报错。check 不打开 zstd 原档。MCP 本轮没有写入口。
- 命令：`node akasha.mjs session index <sessionId|文件路径> [--full]` / `session lookup <词> [--kind a,b --level nodes|segs --since D --until D --process --limit N]` / `session context [--session ID --budget N]` / `session tree [--build] --session ID` / `session node <id>` / `session loopwatch [--since D] [--json]` / `session stats` / `session help`；MCP：`akasha_session_lookup`。
- **抽象层 v0.2（2026-10-07）**：段之上加**节点**（`kind:"node"`，id `node-<sid8>-L<n>-…-<会话指纹>`）——**id 尾部的会话指纹为 2026-10-15 追加**（原 `sid.slice(0,8)` 同前缀会话撞号；置于末尾以保住 `node-<sid8>-L…` 既有前缀形状；取 `fp8(sid)` 全 8 hex）。节点＝机械树：按回合切块 → L1 弧 → L2 幕（>2 块递归、≤3 层）；节点含 `children` / 时间范围 / `gist`（400 字·展示）/ `extra`（1200 字·评分扩面，不渲染）/ `treegen` 代际（重建＝新代，旧代留档不参与检索）。**检索跨层**：lookup 默认纳入节点（只取当前代）；`--level nodes|segs` 分面。**导航纪律**：树＝入口 → 节点停靠 → 段 / ptr 下钻；保真实测（`research\session-tree-v02-fidelity.md`）：顶结论 token 100% / 块级提及 62% / 段层 token 60%——**全保真唯一保证＝ptr 回原档**。
- **查询纪律**：结论＋动作＝第一入口；过程段仅按需局部调取、绝不整体查阅；官方压缩摘要仅作背景，冲突以可回原档的会话层为准。
- **调用分级**：被动行 → 定向轻查（session lookup / 主库 lookup·brief）→ 停靠与导航（session tree / node）→ 深取回档（--process / ptr 回原档 / 主库 cross·show）。
- 计分：与主库同一 `scoreTokens`（整词 ×1 + min(Σ回退, 0.9)；结论 +1.0 只进排序权重）。`strong` 表示至少一次整词命中。
- 覆盖边界：旧格式（8–9 月 chunk 型）仅部分可抽取；读取侧 `frameFails` 记录损坏 / 半写帧；会话层条目**免复审**（天然带时间，非知识断言）。
- 插件（`@akasha-book/akasha-session` v0.2.3，2026-10-07 起）：`turn/end` 去抖（30s/会话）自动增量索引 + 压缩事件行（`compaction/end` 真值；成功才记；**wave1 起压缩先强制补索引（绕过去抖/背压），`session-compact` 线带 `indexed`/`reason`——仅 `indexed:true` 时节奏条说「已收入」，否则提示「可能未进会话层」与回退路径；同会话后续索引成功即改口**）+ 每回合节奏条（`systemPrompt.context`，order 134）；**v0.2 起含循环观测 P0（dry 干跑——只观测不干预）**：流环（**现役格式＝`agent/assistant-stream` 帧**：reasoning/text-delta 累积，480 字符节流 + 8K 尾窗；`assistant/chunk` 系 V0 遗物仅兼容保留；chunk 帧的 turn/step 由 start 帧缓存补全）+ turn 环（turn-stopping/`turn/end` 兜底，取数＝事件流缓存全文）+ 帧/类型探针 → `loop-watch` / `loop-watch-probe` 观测线（写 `logs\hooks.jsonl`；汇总 `session loopwatch`）。观测线 `session-armed` / `session-index` / `session-index-skip` / `session-index-error` / `session-compact`。

## 因果注释字段（I-09，2026-10-14；**字段先行**）

| 字段 | 类型 | 说明 |
|---|---|---|
| `caused_by` | string[] | 可选；**估计的因果父**（上游，id 引用）。写入时标注——LLM 近似即可，不必完整因果推断 |
| `led_to` | string[] | 可选；**已知的下游**（它催生了什么，id 引用）|

- **用途**：复审「为什么」类问题时沿链遍历——`review pack <id>` 已把它作为**必要上下文**呈现；**检索侧暂不改**（「为什么」类检索改造**后置**，2026-10-14 决定）。
- **纪律**：只标**确有把握**的因果（宁可少标）；双向标注（A `led_to` B ＋ B `caused_by` A）更有用，但不强制；值必须是非空字符串数组（`validateRecord` 拦空数组 / 非字符串）。
- **试点（2026-10-14）**：`canon-genre-p0-20261013` `led_to` → `canon-genre-p1-dose-20261013` / `canon-idle-resume-v110-20261013`；后者回填 `caused_by`。

## 复审线（review）；I-10，2026-10-14

- **排期**：`audit --due` 复审到期清单（核心 30d / 一般 90d / 年审 365d；I-01 落地）。
- **输入包**：`node akasha.mjs review pack <id> [--json]` —— 条目全文（**链尾＝当前版本**，显式跳链）＋来源证据（`source.ref`）＋必要上下文（`caused_by` / `led_to` 邻居）＋**审查协议**（三问：① 事实核对 ② 有没有更好解法 ③ 幻觉 / 失效 / 被推翻）。交给 **fresh 子 agent**（零上下文——对照参照的价值所在）。
- **处置链**：主会话裁决 → `revise` 追加，三种落法：**修正**（纠错）/ **升级**（更好解法）/ **维持**（`last_reviewed` 打复审戳「YYYY-MM-DD 已复审」）。
- **留痕**：`review log <id> --verdict 维持|修正|升级 [--by self|subagent] [--note "…"]` → 追加 `logs/review-log.jsonl`（`review-cycle` 事件：谁审的 / 审的哪条 / 结论）；读回用 `review list [--limit N] [--since D]`。
- **免复审**：会话层条目（天然带时间，非知识断言）。
