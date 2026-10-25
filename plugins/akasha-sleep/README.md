# @akasha-book/sleep


> **配套系统（Companion systems）**：阿卡夏本体可独立运行（核心零第三方 npm 依赖），但完整形态与三层协作——
> **Hindsight**（仓库级记忆：架构/约定/决策/initiative）、**OpenViking**（用户与人格记忆、跨项目上下文）、
> 以及**宿主自带会话检索**（`session_search` / `session_event_read`：原始事件、逐字引文、精确过滤走官方；
> 阿卡夏会话层只做结论/决策/教训/跨会话导航）。阿卡夏会跳过前两者的注入块、不写入它们的存储；
> 缺任一层不报错，只是少了那层交叉记忆。详见仓库 README §配套系统。
> 2026-10-18 压缩后重投（2026-10-18）：监听 `compaction/end` 成功后置 `pendingPostCompactWake`，下一回合由 `akasha:post-compact-wake` 条子（order = pulseOrder+4）重投完整起床包（复用 `buildWakeNote`，一次性、每行 ≤80）；失败压缩不计；`postCompactWake:false` 可关。来源：拆 Prime Agent 的 Continual Harness（digest 在 compaction head 也投递）。**版本以本包 `package.json` 为准**（本文件不复述，避免文档漂移）。
>
> 2026-10-18 并行会话感知（1.10.26-h1）：在上一版（独立审核 6 条 P0）基础上再补自排除——`exclude` 增加 `curSid`（事件派生的会话 id，在 retarget 覆盖前捕获），修回合边界自指；其余同上一版：摘要先按 Markdown 结构切段（标题/列表/有序项/✅）再从非首句找「完成/下一步」，排除负例；meta 键统一归一 + 按 source 目录过滤子代理；指针改全 id；`order=131`；注入 `safeInject(..., {untrusted:true})`。
>
> 2026-10-18 并行会话感知（1.10.23-h1）：新增 `akasha:parallel` runtime context 条——读 `akasha/data/session.jsonl` 的 conclusion 段（独立小索引，不写会话层），把其他主会话最近 60 分钟内的最新结论压成「做了什么 / 完成 / 下一步」三行，每条带 `seq` 指针（深查用 `session_event_read`，不做全局检索）；子代理不进；无条目静默。
>
> 2026-10-17 本地兼容修复（1.10.22-h2）：runtime context 在无内容或降级时统一返回空字符串，避免 Harness 提示词渲染出现 null/indexOf 错误；纯函数和内部状态的 null 含义保持原样。


阿卡夏之书睡眠器 —— **调度与注入**（蒸馏逻辑归核心库 `<AKASHA_DIR>/sleep.mjs`；手动触发 `node akasha.mjs sleep [--dry]` 与之共用同一水位线）。

## 安装（必读）

1. `git clone https://github.com/Ersith/akasha-book && cp -r akasha-book/core <目标目录>/core`
2. 把 `cordis.patch.yml` 里所有 `<AKASHA_DIR>` 换成 `<目标目录>/core` 的绝对路径；或删掉路径字段并设 `AKASHA_DIR=<目标目录>/core`
3. **未替换占位符 / 目录不存在时，插件会明确报错拒绝启动**（fail-closed，不会静默降级）；日志与数据都在 `<AKASHA_DIR>` 内

> 只跑核心库（CLI/MCP）：`cd core && node test.mjs && node akasha.mjs check`。

> **版本（单一真值）**：以本包 `package.json` 的 `version` 为准；本 README **不再复述版本号**（2026-10-13 审计 P3：此处曾停在 v1.5.5 而实际已到 1.7.x-h 线）。当前装载版本用 `plugin_manager list_bundles` 查；装载态与源的逐字节一致性核查方法见 `akasha/MEMORY-TEST.md`（prompt-safety 双侧 `diff -q` 先例）。

- **会话身份隔离（第五轮 · V02）**：C3 与指代检索仅按完整宿主 ID 精确匹配；当前会话无 intent 时保持静默。`session-1`、`1`、`session-session-1` 不互作别名。此前的单前缀兜底也会误读新版完整 ID 记录，现已移除。33037b3 中无身份格式标记但保留完整 ID 的记录仍可精确读取；更早被剥前缀的记录需要人工核对原会话档案后重索引，不自动猜归属或迁移生产库。
- **v1.10.18-h1（2026-10-17，batch14 · H4-E 睡眠 TEMP 陷阱目录泄漏修复；产源自清—四件测试套件，**未安装、未重启**）**：四套（gate / preflight / route / stateful）在**模块顶层** `mkdtempSync('<名>-default-trap-')` 建陷阱目录、**从无清理** ⇒ 每跑一轮就在 `%TEMP%` 留一个空目录（batch13 清单实测：存量 255、单日 +134）。修法各一行：三件（gate / preflight / stateful）补 `process.on('exit')` 兜底 `rmSync`；route **已有** exit 钩子但 `DEFAULT_TRAP` 从未 push 进 `cleanupDirs` ⇒ 补 push。
  - **两态实测**（`runs/audit-1016-batch14/seg-sleep/landing/logs/regression-run.json`）：`<TEMP_DIR>` 跑前 255 → 跑后 255、五套逐套即时比对新增 0；**负对照**（去补丁副本，`logs/neg-control.json`）四件各 +1 ⇒ 补丁是「零残余」的有效因子。真家目录（`~/.akasha/logs/` 的 `hooks.jsonl` + `sleep-state.json`）bytes/lines/mtime/sha 四属性**跑前=跑后**；`akasha/test.mjs` 276-0、`node --check` ×7 全绿。
- **v1.10.17-h1（2026-10-17，batch10 · 处置 batch8 复核 `VERIFY-S4` §5 的三条低级别；改动仅 `route.test.mjs` 一件，**未安装、未重启**）**：
  - **F-S4-2（H+++ "半牙" ⇒ 真增量）**：H+++ 原有三条断言（`{status:3}` / `{code:'ETIMEDOUT'}` / `{code:'ETIMEDOUT',signal:'SIGTERM'}`）与**集成路重复**（分别由 H-5「exit 3 ⇒ raw 3」与 H-3「超时 ⇒ raw 'ETIMEDOUT'；真实形状同时带 code+signal」驱动）⇒ 删去，换三条**集成路产不出的类型守卫格**：`{status:0}`（合法退出码，防真假陷阱）/ `{status:'3'}`（非数字 status）/ `{code:42,signal:'SIGKILL'}`（非字符串 code ⇒ 落 signal 格）。
    - **两态 × 四变异实测**（`runs/audit-1016-batch10/seg-sleep/landing/tools/probe-F-S4-2-teeth.mjs`）：旧套件对「真假陷阱 / 松类型 status / 松类型 code」三个变异**全绿（抓不到）**；新套件分别在 **421 / 422 / 423** 行当场红。而「signal 提前于 code」的变异**两版都由 H-3（344 行）**抓住 ⇒ 删掉的三条不承重、新加的三条各有独立分辨力。
  - **F-S4-1（测试件是否在 `review-lag` 面内）⇒ 核实为"报"，盲区不成立**：派生副本两态（工具 `review-lag.mjs` 落在副本根下自定位；它**不读 `AKASHA_DIR`**）——控制态（戳内那一版字节）`exit 0 无滞后：7 个面内核心件均未被改动`；把 `route.test.mjs` 加一行注释 ⇒ `exit 1` 且点名 `dsh-akasha-sleep/route.test.mjs —— 戳内，但 sha 与戳不符`。⇒ 测试件**本就在面内**（`collect()` 收 `dsh-akasha-*/*.test.mjs`，戳内 5 个测试件各有 sha）。两层覆盖口径：**`review-lag` 管「改了没审」**（含测试件；新件走 mtime 路径）、**`family-sweep` 管「源↔安装副本漂移 + 子套件实跑」**（测试件按设计不进生产包 `files[]`，故其漂移面不含测试件 —— 不是盲区）。
  - **F-S4-3（"stderr-滞后在集成路径上无驱动"）⇒ 核实为误判，未采纳补丁**：`route.test.mjs` 的 **H++ 段**（1.10.16 起就在）正是该集成用例 —— 同 tag `stderronly` 的桩工具把滞后写 stderr 后 `exit 1`，断言显示面静默 + `code:-1` + `line:''` + `raw:1` + `counter=1`。隔离验红（`landing/tools/probe-F-S4-3-hpp.mjs`）：把 H++ 段逐字抽出成 mini 套件，对 `lib/index.js` 打「stderr 并入首行判据」变异 ⇒ mini 套件在 H++ 首条断言当场红。⇒ 复核给的 6 行补丁与既有 H++ **重复**（同 tag、同三条断言且更弱），不落。
  - ⚠ **本版令审核戳过时**：`route.test.mjs` 内容已变（`caaee4d09c808a59` → `e8b86790e9a6a21a`）⇒ 重审 + 重打戳之前，`review-lag` 会正当地报「改了没审」（已实测点名该件）。
- **v1.10.16-h1（2026-10-16，batch7 独立复核 VERIFY-S3 §5 修复批；依据 `akasha/gate-out/gate-selffix/runs/audit-1016-batch7/seg-sleep/verify/VERIFY-S3.md`）**：
  - **F4（中）· 复位遗漏 ⇒ 段序耦合**：`resetFull` 上一批只加在 `route.test.mjs` 的 H 段，**G 段仍只复位 `at`** ⇒ 同键前置段之后 G 段落线 **0 行**（`assert.equal(rl.length,1)` 假红；`rl[0].code` 读 undefined 抛 TypeError）。本批把「凡断言**本段是否落线**一律用 `resetFull`；`resetThrottle` 只留给节流断言」钉死，**A/B/C/D · F · G** 三段落线断言前的复位一并改 `resetFull`（节流分离处仍只复位 `at`）。
  - **F7（中）· `route.test.mjs` 补家目录零写入守卫**：5 套里 gate/stateful/preflight 早有、route 没有 ⇒ 将来任一段漏 `log:` 会**直写真家目录且无断言**（复现：漏 `log:` 一段 + 修前工作源 ⇒ 套件仍打印 all assertions passed，而家目录 `hooks.jsonl` 被追加 3 行）。照抄 gate 三行模式：`DEFAULT_TRAP` → `AKASHA_DIR` **先设后动态 import** → 末尾 `T()` 断言陷阱目录零写入；报红形态与另三套同款（`FAIL` 行 + 汇总行）。
  - **F5 · 键与存储同粒度**：`review-lag` 去重键与落线都用截断 80 字的 `shown` —— 旧写法键用**未截断** `v.line`、存储 `slice(0,80)` ⇒ 只在第 80 字之后不同的两条真状态会落成两行「除 ts 外逐字节相同」的记录。
  - **F6 · raw 取值域**：补 `'SIG:<name>'` 格（`e.signal` 存在且 **code 缺失**时记；POSIX 可达、本机不可达）；`'ENOBUFS'` 归位（**不是** spawn 级）；分类逻辑提为顶层导出 `rawOfError`（生产与测试同一份实现）。
    - ⚠ **实测顺序（本批新发现）**：Windows 超时被杀**同时带** `signal='SIGTERM'` 与 `code='ETIMEDOUT'`（status 为 null）⇒ 分类器里 **code 必须先于 signal**，否则 raw 从 `'ETIMEDOUT'` 退化成 `'SIG:SIGTERM'`（route H-3 用例当场红；证据 `landing/tools/probe-timeout-shape.mjs`）。
  - **F1/F2 · 文本更正**：① 「滞后态 `code:1` **不带** `raw`」与代码相反 —— 实测滞后行 = `{"code":1,"raw":1,"line":"⚠ …"}`，本版起更正为「滞后态也带 `raw`（= 它的退出码）」。② `node <缺脚本>` **不是** `error.code='ENOENT'` —— 七种调用形态实测 `status:1`、**`code=undefined`**（node 起得来、模块解析失败、stderr 打 `MODULE_NOT_FOUND`）；`'ENOENT'` 只出现在**可执行本体 / cwd 找不到**时。
  - **F8 · H 段加固**：① 补**键变更靶心**用例（同桩目录：语法错 raw=1 → exit 3 raw=3；中间**只复位 at** ⇒ 必须 2 行；再跑同态 ⇒ 仍 2 行）；② 补 **stderr-滞后**用例（D3 契约破坏面：显示静默、`code:-1` + `line` 空）；③ `'-'`/`'SIG:x'`/`'ENOENT'` 三格 Windows 不可达 ⇒ 直测 `rawOfError`；④ 「工具没装」用例里**恒真**的 `raw !== -1` 断言改为按平台钉真值；⑤ **超时值改 cfg 可注入**（新字段 `reviewLagTimeoutMs`，默认 5000 ms；用例注入 1000）⇒ route 套件 **6.4 s → 3.3 s**，不再每次回归实等 5 s。
  - **F3 · 注释口径**：`route.test.mjs` 三处「造 **spawn 级**失败」改为「造**最贴近生产的『工具没装』形态**（node 起得来、模块解析失败 ⇒ `raw=1`）；真 spawn 级需连可执行都找不到，本套件不造」。
  - **F9/F10**：口径更正 —— 包内套件是 **5 套**（selftest / gate / stateful / preflight / route），不是 6 套；README 一处裸 LF 改回 CRLF（本文件纯 CRLF）。
- **v1.10.13-h1（2026-10-16，独立审修复批 P1–P6；审报告 `akasha/gate-out/gate-selffix/runs/audit-1016-batch5/seg-sleep/REPORT-S.md`）**：**`review-lag` 每回合钩子自 1.10.12 起是死路由**——它挂在 `agent/turn-end`，而宿主**不存在**该事件（`dsh-scope` 的 scoped-events 生成表与 api-catalog 的 `agent/*` 全表只有 `turn-stopping` 等；全树 grep 零发射方）⇒「改了没审」提示**从未显示过一次**。修复：**P1** 改挂 **durable 路由** `session/event`（`type==='turn/end'`；与 `akasha-hooks`/`dsh-akasha-session` 同一条，宿主按 `(session, event)` 两参发布、`data={turn,reason}`），结果改存**进程级单例**（检查与会话无关——原按会话分桶：落桶≠渲染桶即静默，且最坏 8 桶 × 1 次/分）；60 s 节流 / 5 s 超时 / 全 try **全保留**（cordis `emit` 无 try ⇒ 监听器抛错会穿透到发射点，这层是承重墙）。**P2** 显示行去双前缀 + `clip`：117 字 → **27 字**。**P4** `gate-window-miss` 加 **10 分钟去重**（实测原 ~7–8 行/分）+ 记**真文件大小**（`tailReadText` 增 `size`；原 `fileBytes` 恒 = 262144 读入窗口）+ unknown 身份闸。**P4b** 状态变化才落 `kind:'review-lag'` 观测线（原实现成功/失败都不留痕，"它跑没跑过"事后无从核）。**P5**（工具侧 `akasha/tools/review-lag.mjs`，本批唯一的包外改动）`hookActions` 整读 → **尾部 2 MiB 窗口读**（日志无界增长，防顶 5 s 超时）。**P6** 本条 + 新套件 `route.test.mjs`（桩宿主 A/B 实测：旧版触发 **0** 次 / 新版 **1** 次 + 跨会话节流）。**未动**：`review-lag.mjs` 的 FACE 判据面与 60 s 节奏。
- **v1.10.15-h1（2026-10-16，batch6 复核 VERIFY-S2 修复批）**：**D1** `review-lag` 观测线加 `raw`（**字段面变更，用法同步**）：`code:-1` 此前同时承担「工具没装 / 语法错 / 超时 / 其它退出码」四类，事后审计无法区分「工具没装」与「工具跑了但崩了」。现在**非滞后态**带 `raw`（真因），`code` 仍只表达滞后 / 非滞后两态，显示面与 `isLag` 判据不变。
  - **`raw` 取值域**：`number`＝子进程真实退出码（如 `1`＝node 模块解析失败/语法错，`3`＝工具自身退出 3）｜`'ETIMEDOUT'`＝超时被杀｜`'ENOBUFS'`＝stdout 超 maxBuffer（**不是** spawn 级）｜`'SIG:<name>'`＝被信号杀死（`e.signal` 存在且 **code 缺失**时记；POSIX）｜`'ENOENT'`/`'ENOTDIR'`/`'EACCES'` 等**字符串**＝**spawn 级**错误（`error.code`；⚠ 只在**可执行本体 / cwd 找不到**时出现 —— `node <缺脚本>` **不落这一格**，见下方更正）｜`'-'`＝连编号与字符串都取不到（兜底）。**滞后态（`code:1`）也带 `raw`**（≡ 它的退出码，实测滞后行 = `{"code":1,"raw":1,"line":"⚠ …"}`；**v1.10.16·F1 更正** —— 原文写「滞后态不带 raw」，与代码相反）：`code + line` 已足够表达「有滞后」，故 raw 在此只作退出码确证。
  - **去重键变更**：`code|line` → `code|raw|line` ⇒ **同一 code (-1) 下原因不同各留一行**（原来四种原因互相去重、只留第一条）。审计时按 `raw` 区分事故类型；**行数会随原因种类增加**（不是噪声，是信息）。
    - **可观测面实测**（`landing/tools/probe-h3.mjs`）：单例的 `logged` 键**跨模块实例存活、跨用例生效** —— 只复位 `at` 时后一次同态不落线；测试里要逐驱动各留一行须 `at/value/logged` 三字段全复位（`route.test.mjs` 的 `resetFull`）。
  - ⚠ Windows 实测（`landing/tools/probe-h4.mjs`）：脚本路径不存在 / 目录不存在 / 路径是目录 —— 三种都**不是** spawn 级 ENOENT，而是 node 起得来、模块解析失败 ⇒ `raw=1`。「工具没装」在当前平台的 raw 就是 **1**，与语法错同值但都≠滞后（判据仍靠 stdout 有无）。
    - **v1.10.16·F2 更正（平台真相）**：直接跑 `node <缺脚本>`：`status:1`、**`error.code=undefined`**（node 自己在 stderr 打 `MODULE_NOT_FOUND`）；`code='ENOENT'` 只出现在**可执行文件/cwd 找不到**时。（batch7 VERIFY-S3 §1.2 七种调用形态实测；POSIX 侧未实测，如实标注。）
  - **D3（契约写下来，走注释路线）**：判据只认**工具 stdout 的首条非空行**（+ `exit 1`）⇒ **`review-lag.mjs` 的首行必须走 stdout**（`console.log`）。若将来把它改到 stderr / 套一层吞掉 stdout 的 wrapper ⇒ 真滞后会被判成「工具起不来」（显示面静默、观测线 `-1`，**新的静默失败模式**）⇒ 改输出通道＝改契约，须同批改判据。**未选**「判据放宽到认 stderr 标记」（会给一条没写下来的契约再加判据面，且任何在 stderr 打印该标记的工具都会被算成「有滞后」）。
  - **D7**：`gate.test.mjs` 的「家目录零写入」守卫由**裸 `assert.equal`** 改为与 `stateful`(`⑦`)/`preflight`(`F`) 同款 `T()` 自建计数 ⇒ 报红统一为 `FAIL …` 行 + 末行汇总（不再被未捕获栈盖掉）。
  - **D2（注释口径收窄）**：`reviewLagState` 是**模块级**单例 —— 只保证「**同一模块实例**内重复 `apply()` 不重复 exec」；**重新求值（新模块实例 ≈ HMR 重挂）各持一份节流**，不等于进程全局唯一。
  - 自测：`route.test.mjs` 新增 **H 段**（D1 五驱动：语法错 / 模块缺失 / 目录缺失 / 超时 / 真滞后 / exit 3，逐条断言 `raw`；超时驱动实等 ~5 s）；`gate.test.mjs` F 守卫改 `T()`。
  - 依据：`akasha/gate-out/gate-selffix/runs/audit-1016-batch6/seg-sleep/verify/VERIFY-S2.md` §5（D1/D2/D3/D7）；落地证据 `runs/audit-1016-batch7/seg-sleep/landing/**`。
- **v1.10.12-h1（2026-10-16）**：新增 **`review-lag` 每回合钩子**（用户裁定「钩子应对应动作、自己触发，不能靠关键词/自觉」）+ **`gate-window-miss` 观测线**（门档尾窗截断且未命中 intent ⇒ 留痕：**不是"没有意图"，是看不见**）。⚠️ 两条首版各有缺陷、当日独立审捉出、**1.10.13 修复**：钩子挂的 `agent/turn-end` 宿主不存在（死代码）；`gate-window-miss` 无去重且 `fileBytes` 语义错。
- **v1.10.11-h1/h2/h3（2026-10-15，门档批）**：**h1** 门档 `akasha:gate`（order 136；`gateTriggerOf`/`GATE_TRIGGERS` **顶层导出**、测试与生产同一份；三类触发：代码 / 审计 / 迁移·不可逆；**负例优先**防每回合都响）+ C3 哨兵传参修（原传 `null` 走恒假比较 ⇒ 未知会话下永不触发；h1 先修 `undefined`，h2/h3 收敛为 V02「身份未知 ⇒ 静默」）。**h2** **跨组件 ID 约定**（核心存裸 uuid ↔ 宿主给完整 `session-` 前缀 ⇒ 读侧「精确优先 + 归一兜底」；这是 gate/stateful 同时静默的真根因）+ 审计类词表补口语（「全量检查/排查/体检/审一下」等——原 7 条实测 6 条不触发）。**h3** `buildWakeNote` 的「待办 N」口径写明**本次生成**（非当前总数）+ V02 哨兵契约注释（身份未知 ⇒ 静默、不回退他会话）。
- **v1.10.10-h1（2026-10-15）**：与 **1.10.9-h1 同内容**（重打包 bump，代码零差异——供 OSS 同步）。
- **v1.10.9-h1（2026-10-15，第五轮 V01–V07 合入）**：`latestIntentGist` 加**哨兵契约**——`'(unknown)'`/`null`/`''` 一律返回 null（**不回退他会话**；显式 `undefined`＝任意会话只留给离线诊断）；去掉"旧数据单前缀差兜底"，改回**完整 ID 精确读**。
- **v1.10.8-h1（2026-10-14，第四轮 Q06）**：`normSid` 归一弃用（多对一无法区分 `session-1` 与 `1` 两个合法 ID）——读侧改「**精确优先 + 单前缀差兜底**」，生产者（session 插件）改存完整原始 ID。
- **v1.10.7-h1（2026-10-14，GPT 第三轮批收尾）**：**normSid 上移模块级**（此前误放 apply 内 ⇒ latestIntentGist 的 N09 过滤运行时 ReferenceError 被 catch 吞、C3 全哑——复跑捉出）。
- **v1.10.6-h1（2026-10-14，GPT 第三轮批 · N08–N11）**：**指代召回按身份过滤**（`recentIntentGist` 经规范化 id 过滤；unknown 不读共享最后一条——N08）；**会话身份归一**（`session-1` ≡ `1`，与索引器剥前缀口径对齐——N09）；**失败压缩不计成功**（`data.error` 非空另计，不再触发多余补查提醒——N10）；**工具执行参数读 `exec.arguments`**（宿主 ToolExecution 真实契约优先，修「查过库仍显示未查」——N11）。
- **v1.10.5-h1（2026-10-14，GPT 复核二轮批 B3）**：**渲染/事件全程显式会话身份**——text 回调带 `context`（按 `context.agent` 选桶）；`session/event` 按宿主真实 **(session, event)** 两参契约消费（压缩计数/用户消息触发路由回归）；回合真值补 `turn/start`（取消/异常回合后 C3 当轮标记正常失效 ⇒ C1 恢复）；**无身份输入归 unknown 桶（不继承上一会话）**；preflight 去抖与 `latestIntentGist` 均按会话隔离（A 的冷却/intent 不再串到 B）。**她方合约复跑**：A/B 渲染各归其位、两参契约下压缩+触发恢复、aborted 后 C1 恢复、unknown 不继承 ✓。
- **v1.10.3-h1（2026-10-14，外部审查修复批 B）**：动态 context 出口（约定/指代/处境三处）全部 `safeInject` 包裹——库原文含合法模板示例（如 `{{unknown}}`）时不再炸宿主渲染（真宿主纯渲染函数复跑 ✓）。
- **v1.8.0-h1（2026-10-13，空转补救）**：新增 **空转检测 + 续跑注入**——监听 `agent/assistant-stream`，**committed 且整轮正文为空**即判为「空转」（用户侧表现就是"卡住"）；落观测线 `idle-turn`，并 **`agent.inject` 一条续跑指令**（`idle-resume`）。**关键设计依据**（来源＝ARTEX 深读笔记的「Stop 钩子」）：这类失效**没有报错、没有异常、没有失败的调用**，所以**普通重试层够不着它**——必须挂在**回合结束**这一层才看得见；且**刻意不"原样重发"**上一轮输入（那只会复现同一种失效）。护栏：30 秒防抖（同一次失效期内不反复注入）、**未提交的回合（用户打断等）不算空转**。自测 +7 断言（有正文不注入 / 空转注入 / 防抖 / 未提交不算 / 观测线两条）。
- **v1.7.2-h1（2026-10-13，举一反三 S4）**：**状态条（`akasha:stateful`）取 intent 改尾部窗口读**——原先每次渲染 `readFileSync` **整读 `session.jsonl`**（当时 21 MB）再 `.slice(-200)`；现只读**尾部 256 KB**，实测真库 **19.5 MB → 262 KB、57 ms → 0.9 ms**，gist 结果逐字相同。两个纯函数（`tailReadText` / `latestIntentGist`）提升为**顶层导出**（生产与自测同一份实现），自测新增回归：真库「尾读 vs 整读」gist 一致 + 单行无换行 / 注入段跳过 / 窗口起点切在行中三边界。
  - 口径差异（如实）：旧口径按 **200 行**回看、新口径按 **256 KB** —— 记录变长/变密时两者覆盖并不等价（哪个更远取决于行密度）；本机实测真库两者取到同一条 gist ✓。

- **v1.5.5（2026-10-07 复查修复）**：移除死代码 `source==='compact'` 早退（官方 `agent/created` 的 source 只有 startup/resume；压缩信号是 session 事件 `compaction/*`）；子代理守卫沿用官方 `header.origin/delegationDepth`（已核真实字段）。

- **触发**：`agent/status → idle`，去抖 `minIntervalHours`（默认 6）；另一路定时兜底 `ctx.interval`（`timerCheckMs`，默认 1h——timer 属混入服务，必须 `inject:['timer']` 才能访问 `ctx.interval`）。跳过也留痕（`sleep-skip`）；首次激活即跑一次（`activate`）。
- **蒸馏（v1.4 起在核心库 `akasha\sleep.mjs`）**：`akasha\logs\hooks.jsonl` 增量（水位线 `processedLines`）→ turns / tools / errors / denials 统计 + 失败备注 + 待办（`buildTodos`：审计警告 → review；工具失败 / 门控拦截 / agent 错误 → 孤案候选）；报告 `sleep-<date>.json`（**同日重复跑加时间戳后缀，不覆盖**）；有待办时追加 `akasha\logs\inbox.jsonl`。
- **条子一（每回合）**：`systemPrompt.context`（`akasha:sleep`，order 130）——每个新回合的 runtime context 自动带上「最近一次睡眠」一行（含待办数；渲染自核心库）。
- **条子二（新会话·唤醒条）**：`agent/created` → 经 `agent.inject()` 把「起床包」摘要递进 next-step inbox（**不唤醒、不打断**；仅当 无睡眠记录 / 有待办 / 审计警告 才发；子代理与 compact 不打扰；消息 `source.kind = "akasha-wake"`）。
- **条子三（每回合·库脉搏 + 回查）**：`akasha:pulse`（order 132）——六库当前计数 + 最近写入（**写→可见通道**：任何会话 / 脚本写入库后，活跃会话下一回合即见）；**v1.5 起**，窗口内（默认 30 分钟）有工具 / agent 失败时，追一行「回查提示」（错误钩子的注入级动作——只提示、不拦截；渲染幂等，同窗口重复渲染结果一致）。
- **降级（v1.4 切分）**：核心库不可用 → `sleep-error` 观测线 + 条子提示文案；不炸、不失活（插件不再内置蒸馏逻辑，拒绝双份实现）。
- 观测线：`sleep-armed` / `sleep-done` / `sleep-skip` / `sleep-error` / `wake-note` / `wake-note-error` / `wake-note-llm-error` / `sleep-report-error` / `sleep-state-error` / `sleep-inbox-error` 全部写进 `hooks.jsonl`（报告 / 状态 / inbox 三条由核心库发出）。
- 自测：`node selftest.mjs`（纯函数直测 `../../core/sleep.mjs`——含 v1.5 `renderRecallLine`；桩 ctx 端到端（含失败→回查行）+ 写失败线 + 无核心降级；临时目录，不碰真库水位线）。**套件集 = 5 套**（口径更正 · v1.10.16·F9：此前一处写「6 套」，实数 5 套；由 `family-sweep` 自动发现实跑）：`selftest.test.mjs` · `gate.test.mjs`（门档判据+注册面）· `stateful.test.mjs` · `preflight.test.mjs` · **`route.test.mjs`（2026-10-16 新增；batch8 起含 G 段「工具起不来」陷阱 + H 段 D1 五驱动 + H+/H++/H+++（键变更靶心 / stderr-滞后 / raw 分类格）+ F7 家目录零写入守卫——桩宿主路由契约：死事件不得注册、durable `turn/end` 只触发一次、60 s 跨会话节流、显示行 ≤80、`gate-window-miss` 去重与真 size、`review-lag` 状态变化观测线）**。

## 版本与重启

- v1.1.0 事故：访问 `ctx.setInterval` 未 `inject` → 属性访问本身抛错、**apply 整段失败且零日志**（诊断靠 `plugin_manager` 的返回或 `*-armed` 观测线）。v1.1.2 修复 + 入口改 `lib/index.js`。
- **替换已装包的 JS 无法进程内热更**（toggle / remove+reinstall 都无效）——v1.1.2 / v1.1.1 / v1.2.0 / v1.3.0 / v1.3.1 / v1.4.0 / **v1.5.0** 均需**重启**载入。
- v1.3.0：库脉搏（写→可见通道）；v1.3.1：写路径静默失败补观测线；v1.4.0：逻辑归库（`akasha\sleep.mjs`）+ 手动触发；**v1.5.0：回查提示（失败窗口 → 脉搏条追一行）**。
- **v1.10.22-h1（2026-10-17 batch18 · 处置 batch17 复核 `VERIFY-S9` §6 的「找漏四条」；改动仅 `route.test.mjs` + 本 README + `package.json` 版本号 —— `lib/` **一字未动**、未安装、未重启）**：
  - **F3 · `轮=4` 裸子串 ⇒ 边界锚定**：判据 `includes('轮=4')` → `includes('轮=4 ')`（锚在渲染式的分隔空格：`'轮=' + turn + ' 压缩='`，`lib/index.js:917`）⇒ `轮=40…49` 不再冒充 `轮=4`；并补 **`轮=40` 反格**（`轮=40 ` 必须命中、`轮=4 ` 必须**不**命中）。
    - 齿：把判据改回裸子串 ⇒ **只红 `轮=40` 那格**（`route.test.mjs:164`）；产品侧「turn/end 不再写 `obs.turn`」⇒ 正格 `:158` 红（正侧也有独立齿）。
  - **F4 · `raw` 的跨平台严格度不一致 ⇒ 按平台钉死**：2b 那条（工具目录在、脚本文件不在）此前**任何平台**都接受 `1 | 'ENOENT'`，而 1) 那条早已 `win32 ? raw===1 : …` —— 同一个类两套标准。现两处共用模块级 `rawIsToolMissing(raw, platform)`；`'ENOENT'` 只在 spawn 级出现、本机（win32）**运行时不可达** ⇒ 同 H+++ 对 `'-'`/`'SIG:x'` 的处置：平台可注入，**直测** `win32 + 'ENOENT'` 格。
    - 齿：删掉平台分支（判据退回宽松式）⇒ **只红那格**（`:544`）；两条运行时断言看不见该变异（本机 raw 本来就是 1）⇒ 如实登记为「POSIX 侧降级断言」，不是钉死。
  - **F5 · `6h00m` 整独立成一格**：此前只有 5h59m / 6h01m，整点只由 6h01m **代表**。构造 `cm6h00 = Date.now() - SIX_H` ⇒ 产品渲染时**再取一次** `Date.now()`，`elapsed = SIX_H + δ`（δ ≥ 0，毫秒粒度下也可能 0）⇒ `elapsed < SIX_H` **恒假** ⇒ 恒带日期、**不抖动**（原文「毫秒级不可稳定构造」的豁免不成立）。
    - 齿：阈值**放宽 30 s**（`6*3600_000 + 30_000`，一条很现实的"容差"改动）⇒ **只红 6h00m 格**（`:257`）；5h59m / 6h01m 不变（thr5 仍红 `:245`；把 6h00m 格摘掉后 thr7 仍红 6h01m `:259`）。
    - ⚠ 顺序登记：新增格排在 6h01m **之前** ⇒ thr7 变异的**首个**红点由 6h01m 前移到 6h00m（两格对 thr7 都红，先后只由断言顺序决定）。
  - **6.2 · 测试侧两份 6h 常量 ⇒ 合并成一份**（`SIX_H` 提到 `refStamp` 前，refStamp 与 C2b 格偏移共用）。**判断：能安全合并** —— ① 格级探针是**外部**脚本（直接 import 产品件、自造偏移），不读本常量；② 套件的齿来自 `RE_FRESH` / `RE_DATED` 两条语义锚定的正则，**不来自常量** ⇒ 常量改错时格点跟着常量一起移、移完那格落在**另一侧**边界必红（实测 5h ⇒ `:257` 红、7h ⇒ `:245` 红，不是静默绿）；反之留两份的代价是**误导性红点**（只改 refStamp 时红在 6h01m 格、文案却指向"参考实现反算"，不指向真因＝常量漂移）。
  - **变异盘**：`runs/audit-1016-batch18/seg-sleep/landing/logs/b18-plates.json`（10 格；派生副本在 `landing/derived/`，每格**只打一处**变异，记 rc / 红点行 / 断言原文）。**回归**：`node --check` ×9 · 包内 5 套 rc0 · `akasha/test.mjs` 276-0（沙箱副本带 `dist/akasha-oss` 兄弟仓）· `sleep-state.json` 四字段跑前=跑后 · `<TEMP_DIR>` 九类前缀 0→0。
- **v1.10.21-h1（2026-10-17 batch17 · **只补测试齿**：拆严格正则 + 6h 边界两格；`lib/` **一字未动**、未安装、未重启）**：`route.test.mjs` 的格式正则原把日期写成**可选**（`(?:\d{2}-\d{2} )?`）⇒ 它自己**不带齿**（"恒带日期"也能过），真正钉住「新鲜态不许带日期」的只剩 refStamp 等式，红点文案还看不出意图（VERIFY-S8 §7 O-1）。现**拆两条严格正则**：`RE_FRESH`（新鲜 ⇒ 括号内**无**日期）/ `RE_DATED`（跨日 ⇒ **有**日期），并各配一条「另一式必不匹配」的反向齿。
  - **补 6h 阈值边界两格**（VERIFY-S8 §7 O-2；此前 C2 只测 26h）：`5h59m` ⇒ **无**日期、`6h01m` ⇒ **有**日期。方向以源码实际比较符为准 —— `stampOf` 是 `Date.now() - ms < 6 * 3600_000 ? HH:MM : MM-DD HH:MM` ⇒ **≥6h 带日期**（**6h00m 整归带日期一侧**）。
  - **变异验齿**（`runs/audit-1016-batch17/seg-sleep/landing/logs/b17-plates.json`）：阈值改 **5h** ⇒ **只有** `5h59m` 格转红；改 **7h** ⇒ **只有** `6h01m` 格转红；「恒带日期」变异 ⇒ 新鲜格（含新反向齿）红。
  - **回归**：6 格 `code·raw·hasLag` 与 C2 段（A/B/C）逐格不变；包内 5 套 + `node --check` ×8 + `akasha/test.mjs` 276-0 全绿。
- **v1.10.20-h1（2026-10-17 batch16 · O1-b「脉搏时点补日期」；只动显示面，**未安装、未重启**）**：`检于 HH:MM` 无日期 —— 进程长期静默（无 turn/end、无写入）时旧结果会**跨日**，读者把「检于 09:12」当成今天（今天 06:50 与明天 06:50 逐字相同）。修法照 `runs/audit-1016-batch15/seg-sleep/verify/VERIFY-S7.md` §7 的 `stampOf` 补丁：**>6h 的时点补日期** ⇒ `检于 MM-DD HH:MM`；6h 内仍只给 `检于 HH:MM`（短行不多占宽）。**判定（`code`/`raw`/是否显示）与 60s 节流一字未动**——`checkedAt` 仍只进显示面。
  - **两态**（`runs/audit-1016-batch16/seg-sleep/landing/logs/o1b-two-state.json`）：6 格（lag-3 / lag-notool / ok / exit1-empty / exit3 / lag-long）的 `code·raw·hasLag` —— 修前（`1.10.19-h1` 发布件）＝修后**逐格相同**；再把 `checkedAt` 挪一天，三字段仍逐格相同。
  - **时点仍看得见**：`lag-long` 满 **80** 字、尾 `…`，时点仍在**前缀括号内**（行尾会被 clip 先吃掉）；跨日时前缀由 14 → 31 字 ⇒ 该格可显示明细 55 → **49 字**（新鲜态不变，仍是 55；属登记代价，不修）。
  - **断言同批放宽 + 加齿**（`route.test.mjs`）：格式正则 `检于 \d{2}:\d{2}` → `检于 (?:\d{2}-\d{2} )?\d{2}:\d{2}`；原「显示时点＝检查时点」改为**参考实现反算**（测试侧独立实现同一规则）；新增 **C2 段**要求跨日**必须带日期**。负控三条实测：① `checkedAt` 再挪一天 ⇒ 期望串不同（断言必红）；② 旧形态（只有 `HH:MM`）不匹配；③ 修前发布件在跨日格上严格日期正则 = **false**。
  - 已知边界（如实）：6h 内的时点不带日期 —— 该窗口内「今天 HH:MM」不会与「昨天同 HH:MM」同形（要混淆须错位 ≥18h），故不补日期。
- **v1.10.19（2026-10-17 batch15）**：① 测试件残留兜底两件——`gate.test.mjs` 的 `gate-reg-*`（`mkFix`）纳入 `cleanupDirs` + `exit` 钩子（原只走 happy path，失败/早退即留，化石 3 个：10-15）；`selftest.test.mjs` 退出时补一次「非空则留」的 `rmdir`（`<TEMP_DIR>\akasha-sleep-selftest` 空容器此前常驻）。② 脉搏「⚠ 审核面滞后」行**附检查时点**`（检于 HH:MM）`——判定（`code`/`raw`/是否显示）与 60s 节流一律不动，只让"这结论是什么时候的"可见（消 VERIFY-A4 §5-O1 的显示面时序分歧：旧结果在 turn/end 驱动的窗口里与实跑 `exit 0` 分歧）。
- ⚠️ 注意：`ctx.on('tools/result')` 与 `ctx.on('agent/error')` 的监听是 v1.5 新增——宿主 Event 名以 `cordis_inspect_query`（host Event 目录）为准，两个事件均为 emit 语义（失败不打断宿主）。

## 打包 / 安装

```powershell
cd <LOCAL_PATH>
npm pack
# 然后：plugin_manager install_bundle <tgz 绝对路径>（首次安装会 HMR 热生效；替换需重启）
```


## 源与许可（Source & License）

- 源仓库：https://github.com/Ersith/akasha-book
- 本版本固定提交（pinned commit）：`5a55099586cfae4e7511ba433eaf202455d81c30`
- 许可证：MIT（见仓库根 LICENSE）
