、# 仓库内容清单（交付面）

本仓同时是「可运行核心」和「我们自己的活库」。为了 clone 的人一眼分清，这里列出**什么算交付面、什么不算**。

## 在交付面内

- `core/` — 零依赖核心：`lib.mjs`（六库/检索/修订/定价）、`akasha.mjs`（CLI）、`mcp.mjs`（stdio MCP）、`session.mjs`、`sleep.mjs`、`init-example.mjs`、`json-redaction.mjs`、`companion.mjs`、`adapters.mjs`、`contract.mjs`（模块层契约），以及运维/校验类工具（check / audit / doctor / review / redaction / sync / verify 等）。
- `plugins/` — 5 个 DSH 插件：`akasha-gate`、`akasha-hooks`、`akasha-session`、`akasha-sleep`、`mcp-akasha`。
- `data/` — **中性示例**（`init-example.mjs` 生成；默认运行库，不含个人记忆）。
- `data-snapshot/` — **脱敏真库快照**（测试基线；`test.mjs` 自动优先用它；可选，不参与运行）。
- `docs/`、`PROTOCOL.md`、`SCHEMA.md`、`CHECKS.md`、`MEMORY-TEST.md`、`paper/`、`research/`。
- `.github/workflows/ci.yml` — 最小 CI：核心套件 + `check` + 5 个插件 selftest。

## 不在交付面 / 不保证

- `core/tools-harvest-*` — 我们自己的演进口述工作笔记（历史归档，**接口不保证**，下一步会迁出主树）。
- 运行期产物：`logs/`、`reports/`、`sleep-state.json`、`data/session.jsonl`、会话档案等。
- `data-snapshot/` 只作测试基线/演示；不要把公开快照当运行库。
- 任何个人路径、端口、凭据、账号信息。

## 验证方式

```bash
node core/test.mjs
node core/akasha.mjs check
for d in plugins/*/; do
  [ -f "$d/selftest.test.mjs" ] && (cd "$d" && node selftest.test.mjs)
done
```

CI 会在每次 push / PR 上跑同一组命令（`.github/workflows/ci.yml`）。

## 已知限制

- 会话层 / 睡眠的完整功能需要 DSH 宿主与会话档案；无宿主时只跑夹具。
- 公开 `data/` 是中性示例；`data-snapshot/` 是脱敏真库快照（仅测试基线）。
- 发布验证绑定（commit / 版本 / 测试结果 / 已知限制）见 `RELEASE.md`。
