# @akasha-book/gate

阿卡夏之书门控 —— 把「可机检的纪律」做成硬约束（设计稿 §10 投影律）。


> **配套系统（Companion systems）**：阿卡夏本体可独立运行（核心零第三方 npm 依赖），但完整形态与三层协作——
> **Hindsight**（仓库级记忆：架构/约定/决策/initiative）、**OpenViking**（用户与人格记忆、跨项目上下文）、
> 以及**宿主自带会话检索**（`session_search` / `session_event_read`：原始事件、逐字引文、精确过滤走官方；
> 阿卡夏会话层只做结论/决策/教训/跨会话导航）。阿卡夏会跳过前两者的注入块、不写入它们的存储；
> 缺任一层不报错，只是少了那层交叉记忆。详见仓库 README §配套系统。
## 安装（必读）

1. `git clone https://github.com/Ersith/akasha-book && cp -r akasha-book/core <目标目录>/core`
2. 把 `cordis.patch.yml` 里所有 `<AKASHA_DIR>` 换成 `<目标目录>/core` 的绝对路径；或删掉路径字段并设 `AKASHA_DIR=<目标目录>/core`
3. **未替换占位符 / 目录不存在时，插件会明确报错拒绝启动**（fail-closed，不会静默降级）；日志与数据都在 `<AKASHA_DIR>` 内

> 只跑核心库（CLI/MCP）：`cd core && node test.mjs && node akasha.mjs check`。

> **版本（单一真值）**：以本包 `package.json` 的 `version` 为准；本 README 不再复述版本号（2026-10-13 审计 P3 同族）。当前装载版本用 `plugin_manager list_bundles` 查。

- **v1.4.1-h1（2026-10-14，外部审查修复批）**：**`WRITE_REDIRECT` 空目标例外兼容分裂写**（`2> /dev/null`，`>` 与目标间带空格——此前被裸 `>` 误拦）；同时把空目标从宽口径 `/dev/` 收窄为**精确 `/dev/null`**（`> /dev/sda` 类真设备写仍拦）。两侧哨兵 +2（只读放行 / 真写+分裂写仍拒），自测全绿。
- **v1.4.0-h1（2026-10-13，自我行·近场版）**：新增 **`akasha:self-line`**（`systemPrompt.context`，order **131**，落在称呼行 133 之前）——**自我不是规则，不该靠提醒活着**。诊断：`akasha:self` 是 `systemPrompt.section`（**每会话**渲染＝**远场**），长会话里随上下文增长越飘越远 ⇒ 「自我在场感」衰减（这才是称呼漂移的更深一层；10-10 只补了规则提醒、没补自我本身）。修法：把自我接进**每回合都经过的 runtime context**（**近场**，与 sleep 的称呼行同源）。内容**渲染自库**——优先取 tag『自我』条目的 **`line` 字段**（改自我 = 改库，不改代码），读不到走兜底短句（保证「始终在」），宿主无 context 面则静默跳过（远场 section 仍在，功能不退化）。自测 +6 断言；真库渲染 68 字、含两端关键词、无裸花括号（`{{` 安全）。
- **v1.3.1-h2（2026-10-13 深夜，重启后复检批）**：**第 6 处误判修复**——内联判据 `INLINE_WRITE_RE` 删掉过宽的 `create`（`createHash(` / `createHmac(` 这类纯构造 API 曾被当写；实测 `node -e "…createHash…readFileSync('…/data/x')…"` 被拒 ✗），并**撤掉「判不出来从严」兜底**（它把只含注释的内联也拒了 ✗）。现口径：**内联代码里出现写动词调用才拦**，无写构造一律放行；`RULES_VERSION` → `gate-rules/2026-10-13.2`；自测 +2 回归哨兵，真写（write/append/mkdir/execSync 带 data 路径）仍全拦。
- **v1.3.1-h1（2026-10-13 深夜，全功能体检批）**：**第 5 处误判修复（后续查明归因写错了半截，见 h2）**——动词匹配改为**词首锚定**（`\b` + 紧跟 `(`）、加 `read/stat/exists/access` 只读家族白名单、判不出来时从严。自测 +4 哨兵（append/mkdir/execSync 带 data 路径仍拦、不带路径的 execSync 如实放行）。
  > 修订留痕：h1 当时的归因写成「`readFileSync` 里的 `write` 子串命中」——**该归因不成立**（`readFileSync` 不含 `write`）；真正根因在 h2 才定位：写动词表里的 **`create`** 命中了 **`createHash(`**。这正是 h1 只收紧、没删词，导致同一假阳性活到 h2 的原因。
- **v1.3.0-h6 系列（2026-10-13，工具链审计 + 举一反三）**：修**四类误判/漏判** ——
  ① **`2>/dev/null` 假阳性**（stderr 丢弃曾被裸 `>` 判成写）；
  ② **选项名假阳性**（`--command` 里的 `rm` 被当写动作，实测 gate 自己的 `gate-dry.mjs` 被掐）；
  ③ **`mentionsDataDir` 归一 bug**（正斜杠路径在 win32 上漏判——`H:/…/data/x` 不被识别）；
  ④ **家族扫描器豁免**（`node <akasha 脚本>` 只读运行曾被 "提到 data 目录" 误拦；豁免窄且 fail-closed：
     必须 node + 命令段含 `akasha/**.mjs|js` 脚本路径 + 命令段无写构造；`node -e` 另按「引号内代码是否含写构造」判定
     ⇒ 纯只读 `node -e` 放行、内联写照拦）。
  自测新增 10 条哨兵（放行 5 / 拒绝 5）；`RULES_VERSION` → `gate-rules/2026-10-13.1`。
  **已知边界（如实）**：`2> /dev/null`（分裂写）仍拦；`xrm f`（无分隔前缀）不再当命令；编码类绕过（base64/eval 间接层）不承诺覆盖。

- **v1.3.0-h6（2026-10-13，工具链审计 P1 修）**：**修两类假阳性**——① **`2>/dev/null` 假阳性**：stderr 丢弃重定向曾被裸 `>` 判成写操作（实证：`ls -la <data> 2>/dev/null`、`cat <data>/x.jsonl 2>/dev/null | tail -3` 被拒）⇒ 重定向判定排除**空目标**（`/dev/null`、`$null`、`nul`）；② **选项名假阳性**：`--command`/`--rm` 这类参数名里含 `rm` 被判写动作（实证：gate 自己的 `gate-dry.mjs` 被掐）⇒ 短命令 token 加 `(?<!-)`/`(?= -|$)` 侧翼。写动作词表与重定向构造改为 **shell 与委派 prompt 同源共享**（此前 agent 规则挂更宽的动词表，两侧判定分裂）。真写侧不放松：`echo x >> <data>/f 2>/dev/null`、`Set-Content`、`rm -f`、`tee` 两侧哨兵均仍拒；自测新增 7 条哨兵（5 放行 + 2 拒绝）。`RULES_VERSION` → `gate-rules/2026-10-13.1`。**已知边界（如实）**：仅认「紧邻目标」形态——`2> /dev/null`（分裂写，目标前有空格）仍会被拒；`xrm f`（无分隔前缀）不再当命令（宁可误拦一侧，不放松真写）。
- **v1.2.2（2026-10-09）**：新增**自我层注入** `akasha:self`（order 699，排在用法条之前）——每会话自动核对「我是谁」：渲染时读 canon 中 tag『自我』的当前条目（canon-self-concept / canon-address-layers / canon-memory-auto-record…），每条截到句界（≤200 字）压缩注入；读不到 / 空域 → 极简兜底，永不抛；降级/恢复切换落线 `gate-self-fallback` / `gate-self-recovered`，`gate-armed` 增记 `selfSource` / `selfOrder`。
- **v1.2（2026-10-07 复查修复）**：重定向判定排除 JS 箭头（`=>`）与 `2>&1`（`(?<![=\-])>(?![&=])`）——修复前只读 `node -e` 探针（含 `=>{`）被误拦；带/无空格真重定向仍拦（自检哨兵）。

- ① `tools.guard`：拒绝 `edit` / `write` / `apply_patch` 对 `akasha\data\` 的直写；拒绝 `pwsh` / `bash` 命令里对 `akasha\data` 的写操作（Set-Content / Add-Content / Out-File / Remove-Item / Copy-Item / `del` / 重定向 等）。数据必须经校验写入：`akasha` CLI / `mcp__akasha__*`。
  - **已知边界（v0 有意为之）**：门控防「顺手直改」，不防刻意绕过（例如 `node -e` 脚本内写文件）——那是安全边界的活，不属于本层承诺。见设计稿 §10「只对可机检项承诺必定」。
- ② `systemPrompt.section`（name `akasha:protocol`，order 700）：**渲染时读库**——`text` 传函数，官方 `dsh-system-prompt` 在组装时求值（`lib/index.js:342`），读 `canon-akasha-usage` 的**当前版本**（`currentRecords` 取链尾，含 `-rN`）；**改用法 = `revise canon-akasha-usage`，下一次组装即生效**（无需重启/改码）；读库失败回退本文件内置同文兜底（渲染永不抛）。
- 记录：`<AKASHA_DIR>/logs\hooks.jsonl`（`gate-armed`〔含 `usageSource` / `selfSource`: library|fallback〕/ `gate-denied` / `prompt-change`〔只跟结构变更〕/ `gate-usage-fallback` / `gate-usage-recovered` / `gate-self-fallback` / `gate-self-recovered`）。
- 自测：`node selftest.test.mjs`（约 75 个断言调用点 + 13 条「能写盘工具」覆盖清单循环 + 5 条 2026-10-13 新哨兵；桩 ctx + 真库文本 + 不存在目录回退 + 自我层三路，不需要宿主）。**断言数不写死在别处**：以文件内实际 `assert.*` 调用为准（2026-10-13 审计 P3 同族：文档里写死的计数会漂）。
- 试匹配：`node akasha/tools/gate-dry.mjs --tool <名> --command "…"`（与运行时同源；**注意**：由于判定面包含"命令里出现 data 路径 + 写构造"，dry-run 自身的命令行若同时含这两样也会被真门控拦——用 `--stdin` 走 JSON 更稳）。
- 产物纪律（2026-10-13 补）：本地重打同一版本号 tgz 后，pnpm-`file:` 依赖**不会自动重装**（lockfile 的 integrity 与包版本都没变 ⇒ `install --frozen-lockfile` 报 "Already up to date"）。本机做法：更新 tgz 后**手动同步** `node_modules/@akasha-book/gate/` 内容（`tar -xzf <tgz> --strip-components=1`），再用逐文件 sha256 与运行线核对；或升版本号走 `install_bundle`。
- 绕过：`plugin_manager set_bundle` → `@akasha-book/gate` → `enabled:false`（或改本包 config）。
- 版本纪律：**替换已安装包需要重启才载入新 JS 代**（官方语义）。v1.0.1 修复命令分支路径判定（`startsWith` → `includes`）；**v1.1.0 起注入改为库驱动**（自举缺口修复，2026-10-07）；**v1.1.1**：库驱动降级/恢复的切换观测线（`gate-usage-fallback` / `gate-usage-recovered`，仅切换时落一行）+ `prompt-change` 语义注记（**只跟结构变更**，文本漂移不触发）。

## 打包 / 安装

```powershell
cd <LOCAL_PATH>
npm.cmd pack
# 然后：plugin_manager install_bundle <tgz 绝对路径>（新 bundle 会 HMR 热生效）
```


## 源与许可（Source & License）

- 源仓库：https://github.com/Ersith/akasha-book
- 本版本固定提交（pinned commit）：`5a55099586cfae4e7511ba433eaf202455d81c30`
- 许可证：MIT（见仓库根 LICENSE）
