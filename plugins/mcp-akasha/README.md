# @akasha-book/mcp —— 阿卡夏之书 MCP 注册桥

把**阿卡夏之书**（外置记忆层）的工具以 `mcp__akasha__*` 暴露给模型的 DSH 宿主插件。


> **配套系统（Companion systems）**：阿卡夏本体可独立运行（核心零第三方 npm 依赖），但完整形态与三层协作——
> **Hindsight**（仓库级记忆：架构/约定/决策/initiative）、**OpenViking**（用户与人格记忆、跨项目上下文）、
> 以及**宿主自带会话检索**（`session_search` / `session_event_read`：原始事件、逐字引文、精确过滤走官方；
> 阿卡夏会话层只做结论/决策/教训/跨会话导航）。阿卡夏会跳过前两者的注入块、不写入它们的存储；
> 缺任一层不报错，只是少了那层交叉记忆。详见仓库 README §配套系统。
## 安装（必读）

1. `git clone https://github.com/Ersith/akasha-book-v2 && cp -r akasha-book/core <目标目录>/core`
2. 把 `cordis.patch.yml` 的 `<AKASHA_DIR>` 换成 `<目标目录>/core`；`command` 用 PATH 里的 `node`（或改成本机 node 绝对路径）
3. `failOnStartupError: true`：占位符未替换 / 目录不存在 / mcp.mjs 缺失时会**明确报错**，不再静默消失

## 它做什么

宿主启动时，本插件：

1. 以 **stdio** 拉起 MCP 服务器（默认 `node <AKASHA_DIR>/mcp.mjs`）；
2. 走 JSON-RPC 握手（`initialize` → `notifications/initialized`）；
3. `tools/list` 取回工具清单，逐个注册到宿主 ToolRuntime，公开名为 **`mcp__akasha__<工具名>`**（与官方桥同名规则：非法字符→`_`；名被改写或超长（>64）→ 截断 + 12 位 sha256 后缀）；
4. `tools/call` 时把参数透传给服务器，并按其契约返回 `{ content, structuredContent? }`；服务器报 `isError` → 抛错（让运行时记为失败）。

**自带客户端、零依赖**：本包**不引用任何 `@deepseek-ai/*` 官方包**，也不修改/遮蔽官方组件——这样做是为了满足 DSH-Store 的硬边界（第三方 Bundle Patch 不得以 `name: @deepseek-ai/...` 引用官方包）。

## 配置（`cordis.patch.yml`）

```yaml
- insert:
    - id: mcp-akasha
      name: '@akasha-book/mcp'
      config:
        serverName: akasha            # 公开名前缀 → mcp__akasha__*
        transport: stdio              # 仅支持 stdio
        command: 'node'               # 可执行文件（或用绝对路径的 node）
        args: ['<AKASHA_DIR>/mcp.mjs'] # ← 改成你自己的 core/mcp.mjs 绝对路径
        toolCallTimeoutMs: 600000     # 单次工具调用超时（默认 60000）
        startupTimeoutMs: 20000       # 启动握手超时
        failOnStartupError: false     # false = 连不上就降级为「无工具」，不拖垮宿主
```

## 权限 / 非目标 / 边界（permissions · non-goals · boundaries）

- **权限**：仅 `spawn` 一个本地子进程（node + `mcp.mjs`），经 stdio 与其通信；不打开网络端口、不读凭据、不写宿主 Profile；工具读写的数据面完全由 MCP 服务器（`core/mcp.mjs`）自己负责。
- **非目标**：不做 streamable-http 传输；不做图片内容投影（非文本块在**渲染**里降级为 `[type]` 占位符，值仍原样返回、不丢数据）；v1 不做自动重连（`failOnStartupError` 决定抛或降级）。
- **边界**：本插件只负责「连接 + 注册」，**不代替** MCP 服务器本身；服务器崩了工具即失效（日志可见），重启宿主可恢复。

## 测试

```bash
node selftest.test.mjs
```

覆盖：Bundle Patch 契约（自有入口 ID、不以 `name` 引用官方命名空间、只 `insert`）、公开名规范化（含超长哈希后缀）、文本提取与非文本降级、**端到端**（临时 core 副本 + 真实 MCP 服务器：注册工具、校验前缀与定义形状、**真调 `akasha_check` 并断言返回**）、malformed JSON-RPC 不导致非零退出。

<!-- store-status -->
## 兼容与状态（DSH STORE 口径 · 2026-10-10）

**固定源（immutable source）**：本版本源码冻结于仓库固定 Commit（见 Issue 中登记的 commit；对应 `plugins/mcp-akasha/package.json` 的 version）。
兼容声明见 manifest 的 `dsh.compatibility.dshReleases`：`0.2.0-rc.2` / `0.2.1-alpha.1` / `0.2.1-alpha.2` 均 **compatible**（三版 × 一次性 Profile 装-启-卸实跑）。

| 证据层 | 状态 | 依据 |
|---|---|---|
| 静态契约（manifest / Bundle Patch / 许可证 / 入口 ID） | **verified** | 官方 `build-dsh-plugin` 审计；入口 `mcp-akasha` 为插件自有 ID，Patch 只 `insert` 自有包 |
| 单元与边界测试（`npm test`） | **verified** | 含端到端：真实 MCP 服务器 + 18 工具注册 + `akasha_check` 实调 |
| 一次性 Profile 安装·启动·卸载（E3） | **verified** | 三版 DSH 各跑通；证据见同目录 `EVIDENCE.json` |
| 真实 Profile 运行 | **verified（本机）** | 桌面端 0.2.0-rc.2 实跑；他人机器 **unverified** |
| 独立安全审计 / 公开分发（E5） | **unverified** | 未做独立审计 |

**下一道门（next gate）**：① 在 DSH 上测 streamable-http 传输（若需要）；② 若上游暴露公开的注入/工具服务接缝，评估改回"借官方服务"以省掉自研客户端；③ 补图片内容投影。


## 源与许可（Source & License）

- 源仓库：https://github.com/Ersith/akasha-book-v2
- 本版本固定提交（pinned commit）：`5a55099586cfae4e7511ba433eaf202455d81c30`
- 许可证：MIT（见仓库根 LICENSE）
