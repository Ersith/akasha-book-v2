# @akasha-book/session

> 2026-10-17 本地兼容修复（0.3.7-h3）：runtime context 在无内容或降级时统一返回空字符串，避免 Harness 提示词渲染出现 null/indexOf 错误；纯函数和内部状态的 null 含义保持原样。


阿卡夏之书会话层插件 —— **自动增量索引 + 压缩事件行 + 节奏条 + 循环观测 P0（dry 干跑）+ 弧线树**（核心逻辑归 `<AKASHA_DIR>/session.mjs` 与 `akasha\loop-detect.mjs`；手动用法 `node akasha.mjs session …` 与 `node akasha.mjs session loopwatch`）。


> **配套系统（Companion systems）**：阿卡夏本体可独立运行（核心零第三方 npm 依赖），但完整形态与三层协作——
> **Hindsight**（仓库级记忆：架构/约定/决策/initiative）、**OpenViking**（用户与人格记忆、跨项目上下文）、
> 以及**宿主自带会话检索**（`session_search` / `session_event_read`：原始事件、逐字引文、精确过滤走官方；
> 阿卡夏会话层只做结论/决策/教训/跨会话导航）。阿卡夏会跳过前两者的注入块、不写入它们的存储；
> 缺任一层不报错，只是少了那层交叉记忆。详见仓库 README §配套系统。
## 安装（必读）

1. `git clone https://github.com/Ersith/akasha-book-v2 && cp -r akasha-book/core <目标目录>/core`
2. 把 `cordis.patch.yml` 里所有 `<AKASHA_DIR>` 换成 `<目标目录>/core` 的绝对路径；或删掉路径字段并设 `AKASHA_DIR=<目标目录>/core`
3. **未替换占位符 / 目录不存在时，插件会明确报错拒绝启动**（fail-closed，不会静默降级）；日志与数据都在 `<AKASHA_DIR>` 内

> 只跑核心库（CLI/MCP）：`cd core && node test.mjs && node akasha.mjs check`。

> **版本（单一真值）**：以本包 `package.json` 的 `version` 为准 —— 打包时由 npm 写入 tgz 文件名与包元数据，本 README **不再复述版本号**（2026-10-13 审计 P3：此处曾写 v0.2.3 而实际已到 0.3.2-h4，差出两个功能代；同族漂移在 gate / sleep / hooks 的 README 里也都出现过，故统一改为「指真值」而不是「抄版本」）。
> 代际看点（只列可核对的）：0.2.x＝索引 + 压缩线 + 节奏条；**0.3.0（2026-10-10）＝索引 worker 化**（见下节）；0.3.x-h 序列＝壳/装配级修订（h3→h4 仅版号差异、代码全同；**h5（2026-10-14）＝循环观测加 `ctxChars` 上下文长度代理**——只记录不干预，见「循环观测 P0」节，见 `MEMORY-TEST.md` 核实记录；**0.3.4-h2（2026-10-15）＝P0 观测线去重 + turn 相 `src` 标记**——同一逻辑事件只落首报，「流已报 + 回合复检」可被下游区分；**0.3.5-h1（2026-10-15）＝格式密度观测**——每轮把 reasoning+text 的加粗标记密度推进近 10 轮滚动窗口，节奏条显示档位 + hooks 落 `density` 线；见「格式密度」节）。查「当前装载的是哪一版」用 `plugin_manager list_bundles`；查「插件壳与核心库谁需要重启」的证据链见 `akasha/MEMORY-TEST.md`（核心 `session.mjs` 由 worker 现场 `require` ⇒ 核心改动无需重启）。

- **触发**：`session/event → turn/end`（按会话去抖 `minIndexIntervalMs`，默认 30s）→ `indexSession` 增量（水位 + 指纹双幂等）；`agent/status → idle` 追平；`ctx.interval` 兜底（`timerCheckMs`，默认 4 分钟——timer 属混入服务，必须 `inject:['timer']`，否则 apply 整段失败且零日志）。
- **压缩事件行**：`session/event → compaction/end`（**成功**压缩，`data.error` 空才记；2026-10-07 复查：旧写法 `agent/created source==='compact'` 是错的——该事件的 source 只有 startup/resume）→ `session-compact` 线 + 节奏条点名（「被折叠历史的细节优先查会话层」）。
- **循环观测 P0（2026-10-07 起，受控解冻第十六次）**：**dry 干跑——只观测、只写观测线；绝不 steer / cancel / 注入**。流环：**现役格式＝`agent/assistant-stream` 帧**（`{type:'start'|'chunk'|'end', attemptId, revision, index, chunk}`——真值对 `dsh-agent-loop` 的 `AssistantStreamAttempt` 与 `dsh-headless` 消费口径三方核实；**chunk 帧不带 turn/step，由 start 帧缓存补全**；`assistant/chunk` 为 **V0 遗物**，仅兼容保留），按 `${sid}:{attemptId}:{index}:{stream}` 累积 delta（`reasoning-delta`/`text-delta`），每 `watchCheckEvery`（480）字符对尾 8K 跑 `loop-detect.detectLoops`；turn 环：`agent/turn-stopping` + `turn/end` 兜底，取数＝**事件流缓存的最新 assistant/message**（2026-10-07 复查：官方 Session 无 `.events` 属性、同步读者已被弃用——插件不得伸手进日志）。命中 → `loop-watch{phase:'stream'|'turn', hit:{type:exact|variant|punct, excerpt≤60}}`；每会话前 8 个新帧/chunk 类型记 `loop-watch-probe`（防真值漂移；**满 8 即停为设计上限**）。**上下文长度代理（h5，2026-10-14；用户令「这个要加」）**：探针与命中额外带 `ctxChars`＝**自上次压缩完成以来**本会话累计流字符（压缩事件归零；无压缩记录时＝自会话开始累计）——只记录、不干预；真实 KV 相位不可由宿主观测，该代理仅供离线分析（P1 阈值标定时查相位性）。**观测线去重 + 来源标记（0.3.4-h2，2026-10-15；P1 标定巡检产物）**：① 流线按 `${sid}:{stream}` **只落首报**——同一逻辑事件在多个 attempt / index 前缀下各命中一次时不再重复写线（此前 0fd706f7#16 曾 49.7s 内落 6 行）；② turn 相命中带 `src:'turn'`——「流已报 + 回合全量复检再报」可被下游当同一事件去重（**turn 兜底本身保留**：流式只看 8K 尾窗，跨窗重复仍需全文复检）。判据侧同步：`punctRuns` 收窄为**同串出现 ≥2 次才入列**（见 `akasha/loop-detect.mjs`；单串虽长也只算合法长串）——P0 命中数会随之下降，属预期。汇总：`node akasha.mjs session loopwatch`。
- **节奏条**：`systemPrompt.context`（`akasha:session`，order 134）——段数 / 会话数 + 回看提示；无数据静默（`null`，不说话）。
- **降级**：核心库不可用 / 日志不可写 / 档案缺失 / 空会话 id（静默跳过）→ 只留痕（`session-index-error`），不炸、不失活（sleep v1.5 同款范式）。背压：**统一失败窗口 5 分钟**（未命中 / 链接 / 执行失败均静默退避；链接类错误附加「疑似宿主模块代缓存」提示——重启桌面端恢复）；stat 快照只在**成功**索引后记账（失败可重试）。
- **性能边界（诚实注记）**：正常触发为全量重读（重解压 + 重解析 + 扫 `sessionsRoot`），基线约 0.32s / 4.7MB；两道减负：档案 size+mtime 未变 → stat 快路跳过；>16MB → 节流 ×4。30s 去抖 + 空闲 / 定时触发下当前规模可接受，再大（>40MB 常态）需改成增量帧读取。循环观测的流式检测为节流检查（每 480 字符一次 8K 尾窗），实测开销可忽略。
- 观测线：`session-armed` / `session-index`（added / skipped / parseFails / ms / lagMs）/ `session-index-skip` / `session-index-error` / `session-index-slow`（>1.5s 告警，含事件循环延迟）/ `session-compact` / `loop-watch` / `loop-watch-probe`，全部写 `akasha\logs\hooks.jsonl`。
- 自测：`node selftest.test.mjs`（桩 ctx 端到端；临时目录，不碰真库；**数不写死**——以实际输出为准，2026-10-13 审计 P3 同族：此处曾写 18/18，实际早已扩到 27 例）。节流以**单调 seen 计数**（缓冲 20K 截尾不影响——复核 F1 修复：饱和后尾段仍继续检查）。

## 打包 / 安装

```powershell
cd <LOCAL_PATH>
npm pack
# 然后：plugin_manager install_bundle <tgz 绝对路径>（本 profile 为启动型：装载/替换以重启生效，以安装返回为准）
```

## v0.3.5-h3（2026-10-15，首验口径修正）

- **首验（重启后第一次运行）读到的真问题**：density 线报 `chars:1394`，而该轮实际文本 12666ch——**首版只统计了"该轮最后一条消息"**；而阈值（15/40/120）与全部归因分析都是"**整轮所有消息**"口径。两个口径不一致，且小样本会被节奏条的 2000 门槛挡掉（实测正是如此——密度行没显示）。
- **修**：`rememberAssistant` 按 `(sid,turn)` 累计每条 assistant/message 的 reasoning+text 字符与 `**` 匹配数（`turnAcc`），`onTurnWatch` 消费并清除；无累计时退回"本消息"口径（兼容边缘路径）。
- **测试**：新增"整轮累计口径"用例（同 turn 两条消息之和＝1000ch/20**）⇒ selftest **33/33**。
- **口径断层注记**：hooks 里 **00:21:18Z 那条 density 线（rate 23 / chars 1394）是旧（单条）口径**，此后为新（整轮）口径；分析时注意分段。

## v0.3.5-h2（2026-10-15，复检修正）

- **复检抓到的真缺陷**：h1 引入的观测线去重键写成 `${sid}:{stream}`（**整会话一刀切**）——比设计意图（"同一 turn 内多帧只落首报"）严苛得多，会让一个会话的 stream 命中只剩 1-2 条（**P1 标定样本量会被砍掉大半**）。**修正为 `${sid}:{stream}:{turn}`**：同轮去重、跨轮各自落线。
- **测试同步**：原用例（多 attempt 跨 turn 期望 1 条）改写为两条断言——同 turn 两 attempt 只落 1 条 + 跨 turn 落 2 条（防回退哨兵）。
- **另一处复检如实记录**：核心 `loop-detect.mjs` 的 punct 判据收紧（2026-10-15 同日）**在插件进程内不即时生效**（`require` 缓存；`watchLoopCore()` 首次 require 后驻留）——**CLI/新进程用新版；插件侧要重启**。重启后两端一致。

## v0.3.5-h1（2026-10-15，格式密度观测）

- **背景**：三轮退化归因（`canon-degradation-attribution-20261015` / `-r2` / `-r3`）锁定——**加粗标记密度（`**`/千字）是失稳的先行指标**；全库 70 会话里峰值密度 >190 的两个会话正是全库唯二失稳会话；密度随会话自激爬升（跨轮漂移，×2-10），>40 失衡出现、>190 崩溃。
- **本版（观测层，零干预）**：每个 turn 结束时累计本回合 reasoning+text 的字符与 `**` 匹配数，推进**近 10 轮滚动窗口**；节奏条（`akasha:session` 注入行）追加一行 `📊 格式密度 X/千字（档区 · 近 N 轮）｜分级：黄≥15 橙≥40 红≥120｜高位时降格式负载`；hooks 落 `density` 线（rate/tag/chars/bold/rounds）。
- **分档（初值，可校准）**：绿 <15 · 黄 15-40 · 橙 40-120 · 红 >120（依据见归因报告）。
- **自指防护**：密度观测行**自身不含任何加粗标记**（selftest 有哨兵断言）——观测行不得喂密度；窗口 <2000 字符不显示（样本不足静默）。
- **验收**：selftest **32/32**（新增：densityTag 四档边界 / 渲染行含档位与样本门槛 / 端到端 rate=20.0 落线 + 自指哨兵）。
- **查询**：`node akasha/tools/density-status.mjs`（读 hooks 的 density 线，显示最近状态与各会话最新档）。

## v0.3.4-h2（2026-10-15，P1 标定巡检 · 观测线去重 + turn 来源标记）

- **背景**：循环观测 P1 第三次标定（125 命中 / 1016 探针）时发现两类"数据不纯"——① 同一逻辑事件多帧重报（0fd706f7#16 在 49.7s 内落 6 行，其中同 turn 的 reasoning/text 快照各落 1 行；c8621203#6 同一秒落 3 行）；② punct 类占命中 25%，抽查全为**良性标点串**。
- **修①（本版，壳级）**：流线按 `${sid}:{stream}` **只落首报**；turn 相命中带 `src:'turn'`——下游可把「流已报 + 回合复检再报」当同一事件。**turn 兜底保留**（跨 8K 尾窗的重复只有全文复检看得见）。
- **修②（核心库，无需重启）**：`akasha/loop-detect.mjs` 的 `punctRuns` 判据收窄——**同串出现 ≥2 次才入列**（新增 `punctRepeats` 计数随行）；单串虽长也不再算环源。刻意**不做**"连续三连"加严：采样计数（每 0.5s 一行 `——：` 进度条）是正常用法，会伤合法长任务。
- **验收**：核心 `node test.mjs` **249/249**（新增 punct 判据收紧用例：真重复命中 / 单串不误报 / 合法长串零误伤 / 多行重复计数）；插件 `node selftest.test.mjs` **30/30**（新增：多 attempt 只落首报 + turn 相 `src` 标记）。
- **预期后果**：P0 命中数将显著下降（此前 punct 假阳性被剔除）；P1 阈值标定需在**新判据数据**上重跑基线。

## v0.3.3-h1（2026-10-14，GPT 第四轮 · Q06）

- **会话 ID 完整保留**：索引器不再剥 `session-` 前缀——台账/段记录存**完整原始宿主 ID**，inline、worker 和 compaction 触发路径保持同一身份。目录查找兼容不改变写入的 ID；读端（sleep）仅精确匹配，不把不同合法 ID 互作别名。
- **旧数据处理（第五轮 · V02）**：33037b3 已完整保留 ID 的记录无需身份格式标记，仍可精确读取。更早的短 ID 记录缺少可核对映射时不自动归属；应先核对原会话档案与完整 ID，再由用户安排重索引。本修复不迁移、不改写现有生产记录。
- 测试同步：selftest 的「前缀归一（记账用裸 id）」用例改为「完整保留」断言（**28/28**）。

## v0.3.0（2026-10-10）—— 索引 worker 化（会话层计划里的 v0.4 队列项）

- **架构**：宿主回调只投递（`postMessage`，µs 级返回）；常驻 worker 线程 `lib/index-worker.mjs`（apply 即预热）串行执行索引、同会话排队去重；重活不再占用宿主事件循环。
- **观测语义**：`session-index` 新增 `via`（worker/inline）与 `hostMs`（宿主投递耗时）；**`session-index-slow` 此后表示「后台耗时 >1.5s」——宿主卡顿请看 `hostMs` / `lagMs`**。
- **降级链**：`indexMode: 'worker' | 'inline'`（默认 worker）；worker **连续** 3 次失败（任何成功即回零）自动降级 inline，落 `session-worker degraded-inline` 线。
- **跨进程锁**：`indexSession` 以 `session-meta.json.lock` 串行化「读水位 → 追加 → 记账」（复用 `lib.withFileLock`；陈锁 30s 夺取、等待上限 5s）——worker 与 CLI `session index` 互斥。
- **退出协议**：dispose → `{type:'quit'}` → drain → 关闭；5s 未退强杀。
- **实测**：热路径 `hostMs=0`；2.1MB 档案 inline 宿主阻塞 161ms → 投递 0.06ms；真实 17.53MB 档案 1267ms → 0.37ms；部署后首个真活 `via=worker ms=840 hostMs=0 lagMs=10`。
- **测试**：`node selftest.test.mjs`（含 2 条 worker 用例）；OSS 版同套。（2026-10-10 当时的计数为 **22/22**；现以实际输出为准——2026-10-13 实测 **27/27**，其中 1 条「store 恰好 3 行」断言因 v0.3 自动建树落地而过期，已改为断逻辑内容。）
- 回滚：备份 `_rollback-20261010-session-v04\`；或 `indexMode: 'inline'` 即回旧路径。

## 源与许可（Source & License）

- 源仓库：https://github.com/Ersith/akasha-book-v2
- 本版本固定提交（pinned commit）：`5a55099586cfae4e7511ba433eaf202455d81c30`
- 许可证：MIT（见仓库根 LICENSE）
