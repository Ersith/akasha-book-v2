# 依赖标注

## 运行时

- **Node.js ≥ 18** 可跑六库 CLI / MCP / 睡眠（实测 v24.x）。**会话层**（`session.mjs` 读 zstd 档案）需要 **Node ≥22.15.0 或 ≥23.8.0**（`zlib.zstdDecompressSync`）。更旧的 Node 上会话命令会报版本错误，其余功能不受影响。核心库**零 npm 依赖**。

## 平台

- 核心库与 CLI：无平台依赖（Windows / macOS / Linux 均可运行）。
- `plugins/*`：**DeepSeek Harness（DSH）** 宿主插件（实测宿主 0.2.0-rc.2）。插件依赖宿主服务与事件面，矩阵如下：

| 插件 | 依赖的宿主能力 | 依赖的本包件 |
|---|---|---|
| `@akasha-book/gate` | `tools.guard` / `systemPrompt.section` / `system-prompt` 事件 | `core/lib.mjs` |
| `@akasha-book/hooks` | 事件面：`session/event` / `tools/result` / `agent/error` / `agent/status` / `agent/assistant-stream` | `core/lib.mjs`（输出审计） |
| `@akasha-book/sleep` | `systemPrompt.context` / `timer` 混入服务 / `agent/*` 事件 | `core/sleep.mjs` + `core/lib.mjs` |
| `@akasha-book/session` | `systemPrompt.context` / `timer` / `session/event` / `agent/assistant-stream` | `core/session.mjs` + `core/loop-detect.mjs` |
| `@akasha-book/mcp` | `ctx.tools.register`（插件自带极简 stdio 客户端，**不引用**官方 MCP bundle） | `core/mcp.mjs` |

- 唤醒条（sleep 插件）额外需要宿主应用模块目录（`appModulesDir` 配置项）；未配置时该功能自动跳过并留痕（`wake-note-llm-skip`），其余功能不受影响。

## 第三方 npm 依赖

- **无**。核心库与五个插件均零第三方运行时依赖（mcp 插件自带 stdio 客户端，不依赖任何官方 MCP bundle）。
