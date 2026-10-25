# 阿卡夏之书（Akasha）· v0

> 外置大脑的骨架：给 API 模型用的「记忆 + 知识 + 情绪定价」三合一层。
> 设计稿：`..\research\ai-memory-architecture-20261006.md`（§7 形态 / §8 栈研判 / §10 强制力分层）
> 计划：`..\docs\superpowers\plans\2026-10-06-akasha-v0.md` · `2026-10-07-akasha-sleep-v2.md` · `2026-10-07-time-filter-review.md`

## Install (English)

```bash
git clone https://github.com/Ersith/akasha-book-v2
cd akasha-book/core
node test.mjs           # self-test (291 passed / 0 failed on the shipped snapshot)
node akasha.mjs check   # validate all six stores
```

The five DSH plugins live in `plugins/` (`akasha-gate`, `akasha-hooks`, `akasha-session`,
`akasha-sleep`, `mcp-akasha`). Copy `core/` to a folder of your choice, set `AKASHA_DIR` to it,
replace the `<AKASHA_DIR>` / `<LOCAL_PATH>` placeholders in each `cordis.patch.yml`, then restart
the host. The MCP bridge needs `args: ['<AKASHA_DIR>/mcp.mjs']` (it does not read `AKASHA_DIR`).
If a placeholder is left unreplaced the plugin fails loudly instead of degrading silently.

**Companion systems**: Akasha runs standalone, but the full memory stack assumes **Hindsight** (repo-level memory)
and **OpenViking** (user/persona memory) alongside it — Akasha skips their injected blocks and never writes into their
stores. For raw session lookup it defers to the host's built-in `session_search` / `session_event_read`;
`mcp__akasha__akasha_session_lookup` covers conclusions, decisions and cross-session navigation only.

## 是什么

名字取自「阿卡夏记录」（Akashic records）——传说中记载一切事件与知识的档案。本项目是它的工程化最小版：

- 六类 append-only 数据：`canon`（稳定库）/ `mirror`（镜像库）/ `orphan`（孤案）/ `pricing`（定价表）/ `lexicon`（情绪词表）/ `frontier`（前沿层）；
- 工具面：检索（`lookup` / `brief` / `cross` / `summary` / `show`；前三个支持 `--since/--until` 时间过滤）、镜像匹配（`mirror match`）、校验（`check`）、定价与情绪回写（`price [--apply-store/--apply-id]`）、修订链（`revise`）、退役与删除（`retire [--hard]`）、蒸馏（`sleep`）、结果计数器（`metrics`，含查询维度）、复审到期清单（`audit --due`，I-01 原型：信任级 × 时龄）；
- 一个最小 MCP stdio server——模型侧「先查再答」的现成入口（**23 工具**；2026-10-19 加 companion_recall）；
- **前沿层（frontier）**：收集的前沿论文——「**文献即基石**」（现行数量以 `stats` 为准；由 `tools\import-frontier.mjs` 从设计稿 §4 生成 + 手工补录，幂等追加）。

## 安装（必读）

```bash
git clone https://github.com/Ersith/akasha-book-v2
cp -r akasha-book/core <目标目录>/core
cd <目标目录>/core && node test.mjs && node akasha.mjs check
```

插件安装：把 `plugins/<name>/cordis.patch.yml` 里的 `<AKASHA_DIR>` 换成 `<目标目录>/core` 的绝对路径（或设环境变量 `AKASHA_DIR`），再重启宿主。
**未替换占位符 / 目录不存在时插件会明确报错拒绝启动（fail-closed）**，不会静默降级。

## 配套系统（Companion systems）

阿卡夏本体**可独立运行**（核心库零第三方 npm 依赖）。但在本项目的完整形态里，它与另两层记忆、以及宿主自带的会话检索**分工协作**：

- **Hindsight**（仓库级记忆：架构 / 约定 / 决策 / initiative）——阿卡夏的会话索引与睡眠蒸馏会**跳过**它的注入块（`<hindsight_knowledge>`），两边并行、互不写入对方存储。
- **OpenViking**（用户与人格记忆、跨项目上下文）——同上，跳过 `<openviking-context>` 注入块，不冲突。
- **宿主自带会话检索**（`session_search` / `session_event_read`）——**原始事件、逐字引文、精确过滤（session_ids / 时间 / 事件类型）走官方工具**；阿卡夏会话层只负责**结论 / 决策 / 教训 / 跨会话导航**。这条分工写进了 `mcp__akasha__akasha_session_lookup` 的工具说明；并行会话感知的 `seq` 指针也用 `session_event_read` 深查。

> 只装阿卡夏也能用（六库 CLI / MCP / 会话层 / 睡眠都在）；缺 Hindsight / OpenViking 不报错，只是少了那两层的交叉记忆；宿主若没有会话检索工具，两条「回官方深查」的路由会退化为不可用（其余不受影响）。
## 目录

> **两种布局**：开发活树是一个 `akasha/` 目录；开源仓是 `core/`（下面这棵树）+ `plugins/`（五个插件包）与它平级。下面按活树写，仓内把根换成 `core/`。

```
akasha\
  README.md  PROTOCOL.md  SCHEMA.md  MEMORY-TEST.md
  lib.mjs      核心库（零依赖，仅 Node stdlib）
  sleep.mjs    睡眠蒸馏核心（sleepRun + 纯函数；手动 `node akasha.mjs sleep [--dry]`；计划执行 `sleep --apply <planId|文件> [--yes]` / 复位 `sleep --revoke`，规则见 research/sleep-merge-rules-draft-20261014.md）
  akasha.mjs   CLI
  session.mjs  会话层（单会话记忆：读取 / 提取 / 索引 / 检索；`node akasha.mjs session …`）
  mcp.mjs      MCP stdio server（**23 工具**：check / lookup / price / stats / orphan_add / frontier_due / audit / brief / kit / promote / revise / cross / summary / show / mirror_match / metrics / session_lookup / sleep_plan / **review_pack / review_log / review_list / now / companion_recall**）
  test.mjs     自检（核心 / session / CLI / MCP / sleep；下界与自洽断言，防写死漂移）
  tools\       生成与留痕脚本群（import-frontier.mjs / verify-frontier-urls.mjs / frontier-audit-revise.mjs / harvest-*.mjs …）——全部幂等、只追加；文件清单见目录
  data\        canon / mirror / orphan / pricing / lexicon / frontier / session（JSONL，append-only；session＝会话层）
  data\negative.jsonl  负记忆辅助库（rejected-write / undecided）——不计入六库 check
  logs\        hooks.jsonl（宿主钩子 @akasha-book/akasha-hooks 事件记录）+ query-log.jsonl（**查询监控侧线**，I-02：ts/via/cmd/query/hits/zero/ms/session/genre_render/ids；`AKASHA_QUERY_LOG=off` 可关）+ sleep-<date>*.json（蒸馏报告，同日不覆盖）+ sleep-state.json（水位线）+ inbox.jsonl（待办队列）
```

## 快速开始

> 命令都在**库根**内执行：活树是 `akasha/`，开源仓是 `core/`（先 `cd core`，再照抄下面的命令）。

```
cd core                          # 开源仓：库根在 core/；活树跳过本步（已在 akasha/）
node test.mjs                    # 自检（全绿 = 可交付）
node akasha.mjs check            # 校验全部数据（exit 非 0 = 有错）
node akasha.mjs stats
node akasha.mjs lookup 狼来了
node akasha.mjs lookup 阿卡夏 --since 2026-10-06      # 时间过滤（event_time 优先、logged_at 回退，UTC 日口径）
node akasha.mjs mirror match 虚构 危险   # 镜像结构匹配（五元组 + patterns）
node akasha.mjs metrics          # 结果计数器（工具成功率 / 拦截 / 审计线 / 引用命中 / 修订链统计 + 查询维度：零结果率 / 高频 / 引用率）
node akasha.mjs price --severity 5 --irreversibility 4 --cost 3 --bad
node akasha.mjs frontier due     # 到期需复审的前沿层条目（基石层）
node akasha.mjs audit            # 机械审计（到期 / 陈旧 / 重复 / 积压）
node akasha.mjs audit --due      # 复审到期清单（I-01 原型：信任级 × 时龄——核心 30d / 一般 90d / 年审 365d；只报不裁）
node akasha.mjs diff --since 2026-10-12 --until 2026-10-13   # 记忆 diff（I-03：新增/修订/退役 + 每步改了什么字段）
node akasha.mjs conflict canon-akasha-usage   # 修订链对比视图（I-04；任意版本 id 或链根 id 均可）
node akasha.mjs conflict 门控                 # 主题相关的冲突候选（只提示不裁决）
node akasha.mjs brief 记忆        # 主题简报（跨六库取料，带来源态与时间坐标）
node akasha.mjs summary          # 全库摘要（六库计数 + 最近条目 + 审计概要）
node akasha.mjs show <id>        # 按 id 直读当前版本（旧版自动指向链尾）
node akasha.mjs kit              # 起床包（睡眠 + 待办 + 审计 + 库况，一次装配）
node akasha.mjs sleep --dry      # 手动蒸馏预演（与插件自动触发共用同一水位线）
node akasha.mjs promote --dry    # 候选转正（inbox 孤案候选 → 孤案库；幂等，dry 只报）
node akasha.mjs cross 重启        # 对位比较（同题词六库并排，当前版本，主行不截断）
node akasha.mjs frontier recheck <id> --status 高引用   # 前沿层复审（修订 + 顺延 next_review）
node akasha.mjs session help     # 会话层用法（调用分级表）
node akasha.mjs session index <sessionId> --full   # 索引一个会话档案（含被官方压缩掉的历史）
node akasha.mjs session lookup <词> [--process]    # 会话层检索（结论优先；过程段按需才纳入）
node akasha.mjs session lookup <词> --raw-process  # 反思通道：过程段原文直出（**不剥皮**）
node akasha.mjs lookup 门控 --reflect               # 反思通道：六库原文不剥皮（默认剥完成态符号：⇒→→ / ✓ 删 / 好。→。＝体裁隔离 P0）
node akasha.mjs brief 阿卡夏 --dose-threshold 5     # 剂量闸（I-12：符号负荷超阈 ⇒ 后续条目摘要化；0=关闸、--reflect 不受限）
node akasha.mjs review pack <id>                     # I-10 复审输入包（链尾全文+来源+因果邻居+三问协议）→ 交 fresh 子 agent
node akasha.mjs review log <id> --verdict 维持 --by subagent   # 复审留痕（review-cycle）；维持会自动打复审戳
node akasha.mjs review list                          # 读复审留痕线（logs/review-log.jsonl）
node akasha.mjs mirror match <情境> --reflect        # mirror 五元组默认剥皮（叙事正文）；--reflect 给原文
node mcp.mjs                     # MCP stdio server（喂 JSON-RPC 行）
```

## 测试

命令同样在**库根**内执行（活树 `akasha/`，开源仓 `core/`）：

```bash
node test.mjs                 # 核心自检：CLI / MCP / sleep / session / 数据下界与自洽
node ../tests/run-review5.mjs # 【仅开源仓】四套行为回归：redaction / retrieval / sleep / identity
```

- 插件包各自的 `selftest.test.mjs`：在 `plugins/<包名>/` 下 `node selftest.test.mjs`。
- 结果口径：全绿 = 可交付；`test.mjs` 里的 SKIP 是「本部署没有该数据面」（例如不带会话档案），不算失败。

## 数据纪律

- append-only：只追加、不改行；更正 = `revise` 追加新版（supersedes），`currentRecords` 取链尾（对应设计稿「冲突不合并」）。
- 并发：同机 `.lock` 文件锁（按 pid 判活）；锁释放失败或临界区超预算记 `logs/lock-warn.jsonl`（不写六库）；跨主机共享库文件不支持。
- 双时态：`event_time`（事件时间，可选、作者写）与 `logged_at`（记录时间，写入路径自动盖戳）两轴分开。
- `check` 是「可机检层」的雏形：**能机检的才算硬约束**（设计稿 §10）。

## 路线图

- **M1 接入 ✅**：`@akasha-book/mcp-akasha`（`mcp__akasha__*` 十六工具在线，2026-10-06 起逐批增设）。
- **M2 门控 ✅ v0**：AGENTS §6 来源态约定 + `audit`；`@akasha-book/akasha-hooks` 记录层 → `logs\hooks.jsonl`；`@akasha-book/akasha-gate`：`data\` 写入门 + `akasha:protocol` 系统提示（v1.1 起渲染时读库）。
- **M3 睡眠 ✅ v0 → v1.4**：`@akasha-book/akasha-sleep`（调度与注入）+ `akasha\sleep.mjs`（蒸馏逻辑，逻辑归库）——空闲（6h 去抖）+ 定时兜底（1h）触发；手动 `node akasha.mjs sleep`；报告同日不覆盖。
- **M4 取料 ✅**：`brief`（跨六库 + 状态权重 + 时间坐标）/ `cross`（对位比较）/ `summary`（全库摘要）。
- **M5–M8 ✅**：首次真实 harvest / `kit` 起床包 / `promote` 候选转正 / 修订链（`revise` + `currentRecords` + `frontier recheck`）。
- **M9 运营增强 ✅（2026-10-07）**：检索子词回退（整词 ×1 + 中文 ≥3 字 bigram ×0.25，弱/强分层）；双时态字段；`show` 直读；`--since/--until` 时间过滤 + brief 时间坐标；sleep v2 逻辑归库 + 手动触发；测试 50/50。
- **M10 核心补齐 ✅（2026-10-07，六项）**：情绪回写（`price --apply-store/--apply-id`）+ 病史注入（`kit.history`）+ 镜像结构匹配（`mirror match`）+ 输出后置审计与使用计数（hooks v1.1：假 id → `output-audit`、真 id → `usage`）+ 结果计数器（`metrics`）+ 回查条（sleep v1.5：失败窗口 → 脉搏条追一行）。测试 57/57；MCP 十六工具；插件 v1.5.0 / v1.1.0 **待重启激活**。
- **M11 会话层 ✅（2026-10-07）**：单会话记忆层（`session.mjs`）——会话档案（含官方压缩掉的历史）→ 段级条目（结论优先）→ 检索 / 注入块；CLI `session index|lookup|context|stats|help` + MCP `akasha_session_lookup`（第 17 工具）；六库零改动，会话层数据独立（不入六库检索）。测试 57→**68/68**（含红→绿与收口点独立复核修复）；真实马拉松样品索引 1384 段 / 0.4s。计划：`docs\superpowers\plans\2026-10-07-session-layer-v0.md`。
- **M12 小阿卡夏插件 ✅（2026-10-07，热生效）**：`@akasha-book/akasha-session` v0.1.1——自动增量索引（turn/end 去抖 30s + idle 追平 + 4min timer 兜底；stat 快路 + >16MB 自适应节流）+ 压缩事件行 + 每回合节奏条（order 134）。收口点复核（1 严重 + 7 次要）修复 `inject` 缺失等；selftest **11/11**（主套件 70/70）；安装返回 `applied`，真宿主 armed 实证。源码 `dsh-akasha-session\`；计划 `docs\superpowers\plans\2026-10-07-akasha-session-plugin.md`。
- **M13 抽象层「弧线树」✅（2026-10-07，会话层 v0.2）**：机械递归摘要树——按回合切块（L1 弧 → L2 幕，>2 块递归、≤3 层；gist 结论优先 + `extra` 评分扩面 + `treegen` 代际）；CLI `session tree [--build]` / `session node <id>` / `lookup --level nodes|segs` 跨层检索；导航纪律（树＝入口→停靠→ptr 下钻）。**度量**：保真（顶结论 100% / 提及 62% / 段 60%，`research\session-tree-v02-fidelity.md`）+ A/B 对照（树 **19/20** vs 平铺 **14/20**，结构题树独占，`research\session-tree-v02-ab-report.md`）；MemoryAgentBench 四能力题型对齐（T6）。测试 **72/72**；插件零改动（自动建树留 v0.3）。计划 `docs\superpowers\plans\2026-10-07-session-tree-v0.md`。
- **M14 循环观测 P0 ✅（2026-10-07，小阿卡夏子功能）**：三环架构之**干跑观测**并入会话层插件 **v0.2.3**（restart-required）——流环（**现役格式＝`agent/assistant-stream` 帧**；`assistant/chunk` 系 V0 遗物）delta 累积 + 480 字符节流 + 8K 尾窗）+ turn 环（事件流缓存全文）+ 帧/类型探针 → `loop-watch` **只写观测线、绝不干预**；CLI `session loopwatch`；检测器 step=1（奇周期）+ punct 不含空白（2026-10-07 两遍复查修复批）。对照与综合设计：`research\loop-detect-opencode-vs-guard-20261007.md` / `loop-guard-synthesis-20261007.md`；复查报告 `research\session-family-review-20261007.md`；selftest **18/18**。P1 温和恢复（steer → cancel(keepInbox) → 降档）待 P0 数据 + 另裁定。

> 本仓为隐私重置版：`core/data` 为中性示例，`core/data-snapshot` 为合成夹具；不含真实用户记忆。
