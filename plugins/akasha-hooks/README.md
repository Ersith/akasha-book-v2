# @akasha-book/hooks

阿卡夏之书钩子 —— 把宿主的事件流落成 append-only 记录，为「结果计数器 / 失败回查 / 空闲脉冲 / 输出审计」供料。


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

> **版本（单一真值）**：以本包 `package.json` 的 `version` 为准（2026-10-13 审计 P3 同族：此处曾写死 v1.2 而实际已到 1.2.4-h2）。当前装载版本用 `plugin_manager list_bundles` 查。

- **v1.2.6-h1（2026-10-14，外部审查修复批 B）**：**`expandHome` 定义前置于使用**（TDZ 修复）——此前它排在 `ENV_AKASHA` 之后，外部按契约设**非空 `AKASHA_DIR`** 时模块导入即 ReferenceError ⇒ hooks 整个装不上（复跑：`loaded`、exit 0 ✓）。
- **v1.2.5-h1（2026-10-13，举一反三批）**：**修两处「工具/子命令表漏项 ⇒ 召回静默漏计」**（与 gate 的 SHELL_TOOLS 同族）——
  ① `SHELL_TOOLS` 补 **`ops_bash`**：dsh-ops 落地后它是最常用 shell 入口，**gate 早就补了、hooks 漏了**（两处不同步）；
  ② `CLI_RECALL` 从 9 条只读子命令扩到**全部只读面**（`check/stats/audit/metrics/frontier due|list/session lookup|context|tree|node|loopwatch|stats/sleep --plan/evidence`）——
  此前查询走别的只读子命令时召回不计数，直接稀释 recall-miss 指标的分母。反向钉住：`revise`/`add`/`retire` 等写入子命令**不算**召回（自测 +9 条哨兵）。
- **v1.2.4-h2 / h1（2026-10-11/12）**：A/B 开关（`abOff`）与工作窗口相关修订；观测线同前。

- **v1.2（2026-10-07 复查修复）**：输出审计按 `attemptId` **连续累积**——官方 revision 逐帧递增（`nextRevision()` 每 emit 一次），修复前按 revision 重置 ⇒ 每 chunk 清空、审计恒空（output-audit/usage **0 条**实证）；id 跨帧切分现已可还原。自检夹具同步改为宿主真值（逐帧递增 revision + 跨帧切分）。

- 记录文件：`<AKASHA_DIR>/logs\hooks.jsonl`（JSONL，一行一事件）
- 监听（全部为 contained 的 emit 事件，失败不打断宿主）：
  - `session/event` → `turn/end`：回合结束（`kind:"turn-end"`）
  - `tools/result` → 每次工具结果（`kind:"tool"`，含 `ok` 与失败 `message`；`logToolResults:false` 可只记失败）
  - `agent/error` → step / turn 出错（`kind:"agent-error"`）
  - `agent/status` → running→idle（`kind:"idle"`，去抖 + 计数器快照）
  - `agent/assistant-stream`（**v1.1 新增**）→ 输出审计：按 attemptId+revision 累积 assistant 文本流，committed 结束时跑核心库 `auditText`——
    - 引用**不存在**的库 id → `kind:"output-audit"` 线（编造引用嫌疑；emit 语义只能审计、不能拦截）；
    - 引用**真实存在**的库 id → `kind:"usage"` 线（条目级使用计数 v0，供 `akasha.mjs metrics` 汇总）。
  - ⚠️ `auditOutput:false` 可关闭输出审计（默认开）。
- 激活即写一行 `kind:"activated"`——可用它验证插件已加载。
- 纪律：只追加、不改行；本插件不注入上下文、不拦截任何调用（v1.1 仍为「记录层」）。
- 自测：`node selftest.mjs`（桩 ctx + 临时假库：usage / output-audit 线、abandoned 不落线、revision 重置、无核心降级；不碰真库）。

## 打包 / 安装

```powershell
cd <LOCAL_PATH>
npm pack
# 然后：plugin_manager install_bundle <tgz 绝对路径>（首次安装会 HMR 热生效；替换需重启）
```


## 源与许可（Source & License）

- 源仓库：https://github.com/Ersith/akasha-book-v2
- 本版本固定提交（pinned commit）：`5a55099586cfae4e7511ba433eaf202455d81c30`
- 许可证：MIT（见仓库根 LICENSE）
