# 阿卡夏之书（Akasha）· 核心库

> 面向语言模型智能体的**可审计外置记忆层**——模型无关、文件式、零依赖（仅 Node stdlib）。
> 设计、实现与初步运营报告见 `../paper/`；本目录是可直接运行的核心。

## 快速开始

```bash
node init-example.mjs      # 初始化示例库（六库中性示例 + frontier 文献基石；--reset 可重来）
node test.mjs              # 自检（292 项：291 通过 + 1 项按数据面 SKIP；全绿 = 可交付）
node akasha.mjs check      # 校验全部数据（exit 非 0 = 有错）
node akasha.mjs stats      # 计数与来源分布
node akasha.mjs brief 修订  # 主题简报（跨六库取料，带来源态与时间坐标）
node akasha.mjs lookup 信任 --since 2026-01-01   # 检索（可加时间过滤）
node akasha.mjs lookup 信任 --load-balance         # A1 检索负载均衡（默认关；只动排序）
node akasha.mjs mirror match 虚构 危险            # 镜像结构匹配
node akasha.mjs cross 示例                        # 对位比较（同题词六库并排）
node akasha.mjs sleep --dry                       # 睡眠蒸馏预演（dry-run，无副作用）
node akasha.mjs sleep --plan                      # 合并 / 丢弃计划（只读六库，只写 logs/sleep-plan-<日期>.json；apply 未实现）
node akasha.mjs sleep --replay --log <hooks.jsonl>  # 历史回放（只读：同一份旧日志上 misses 是否上升；省略 --out 不落盘）
node akasha.mjs session index <会话档案>           # 会话层：抽取段并索引（含被压缩折叠的历史）
node akasha.mjs session lookup <词>                # 结论优先检索（--level nodes|segs；--process 深取回档）
node akasha.mjs session promote <segId> --to <库>   # 段升格（默认预览；--apply 才写；--to 必填）
node akasha.mjs session tree --build --session <id>  # 弧线树（入口→停靠→ptr 下钻）
node akasha.mjs session loopwatch                  # 循环观测（dry 干跑）汇总
node mcp.mjs               # MCP stdio server（22 工具；喂 JSON-RPC 行）
```

## 六库（append-only JSONL）

| 库 | 回答的问题 | 关键字段 |
|---|---|---|
| canon 稳定库 | 「什么是稳的」 | claim / source.type / source.ref / last_reviewed |
| mirror 镜像库 | 「这类处境是怎么回事」 | situation → behavior → outcome → social_reaction → emotion |
| orphan 孤案 | 「什么是反常的」 | summary / observed / hypothesis / would_confirm / would_refute（零权重） |
| pricing 定价表 | 「这个行为值多少」 | behavior / valence / severity_default |
| lexicon 情绪词表 | 「这叫什么情绪」 | term / trigger / behavior / resolution |
| frontier 文献基石 | 「证据在哪」 | url / year / topic / status / next_review / supports |

## 数据纪律

- **append-only**：只追加、不改行；更正 = 修订链（`supersedes` 旧版，原文永久保留；`currentRecords` 取链尾）。
- **双时态**：`event_time`（事件时间，可选）× `logged_at`（记录时间，写入自动盖戳）。
- **只经校验写入**：`lib.appendRecord` / CLI / MCP 工具；直接改 `data/*.jsonl` 会破坏校验与链条。
- 快照类条目 id 带日期；状态枚举见 `SCHEMA.md`。

## 文件

- `lib.mjs` 核心库 · `sleep.mjs` 睡眠蒸馏 · `session.mjs` 会话层 · `loop-detect.mjs` 循环检测器 · `akasha.mjs` CLI · `mcp.mjs` MCP server · `test.mjs` 自检
- `init-example.mjs` 示例库初始化器 · `SCHEMA.md` 数据规范 · `PROTOCOL.md` 软协议（与模型协作的行为约定）
- `data/` 运行时数据（初始化后生成）· `data-example/` 文献基石源（公开论文元数据）

## 与宿主集成（可选）

`../plugins/` 提供 DeepSeek Harness（DSH）插件五件：`@akasha-book/gate`（写入门控 + 纪律注入）/ `@akasha-book/hooks`（事件记录 + 输出审计）/ `@akasha-book/sleep`（调度与注入条子）/ `@akasha-book/session`（会话层调度 + 循环观测〔dry〕）/ `@akasha-book/mcp`（MCP 注册桥）。依赖矩阵见 `../deps.md`。

## License

见仓库根 `../LICENSE`。
