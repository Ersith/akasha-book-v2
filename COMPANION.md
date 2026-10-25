# CompanionPort（配套端口）v1 — 只读契约

> 2026-10-19 立。设计稿：`docs/akasha/companion-successors-20261019.md`。
> 目的：阿卡夏核只依赖端口，不依赖 Hindsight / OpenViking 品牌；未来换自建 Ledger / Persona 时，六库 / MCP / CLI 不动。

## 1. 边界（v1）

- **只读**：`identity / capabilities / skipTags / health` 为静态能力；`recall / read` 在 adapter 未接前返回 `degraded`，**不抛死会话、不假装有数据**。
- **不写**：写入 / 远端同步 / 向量检索全部不在 v1（等上游异步抽取口径定死再开）。
- **不并库**：配套数据不进 `akasha/data/*.jsonl`，阿卡夏也不写配套存储。
- **零依赖**：仅 Node stdlib；不联网。

## 2. 配置

`AKASHA_COMPANIONS` 指向 JSON，或 `AKASHA_DIR/companions.json`：

```json
{
  "companions": {
    "repo":    { "driver": "hindsight" },
    "persona": { "driver": "openviking" }
  }
}
```

`driver: "none"` 或缺失 ⇒ `mode: "absent"`。当前 v1 虽能读配置，但 adapter 未接，配置了 driver 也只会得到 `mode: "degraded"`。

## 3. 接口

| 方法 | 返回 |
|---|---|
| `identity()` | `{ kind: 'repo'\|'persona', driver, mode: 'live'\|'degraded'\|'absent', version: 'v1' }` |
| `capabilities()` | `{ read, write, recall, inject, reason }`（v1 全 false） |
| `skipTags()` | 注入标签数组（默认含 `<hindsight_knowledge` / `<openviking-context` / `<ledger_knowledge` / `<persona_context`） |
| `health()` | `{ ok, mode, detail }` |
| `recall()` | `{ hits: [], via: 'degraded', degraded: true, reason }` |
| `read()` | `{ record: null, depth: 'pointer', degraded: true, reason }` |

`skipTagsFor(ports)` 返回默认标签 ∪ 各端口标签——**默认标签始终在**，避免切主期漏跳异层注入块。阿卡夏会话索引的 `SCAFFOLD_RE` 已改成从这里取标签（不再写死品牌）。

## 3.1 Adapter 注入（宿主提供，核心零依赖）

`resolvePorts({ file, hooks })`：`hooks[driver] = { search(query, opts), read(id, opts), health() }`。
- 注入 `search` ⇒ `mode: live`、`capabilities.recall=true`，`recall()` 直接透传 adapter 结果（不在此层改写/合并）。
- 注入 `read` ⇒ `capabilities.read=true`。
- 注入 `health` ⇒ `health()` 透传；**返回 Promise 时 v1 记 `{ok:null, mode:'degraded'}`**（不 await，doctor 报 WARN）；异常记为 `{ok:false, mode:'degraded'}`。
- 未注入 ⇒ 保持 `degraded`（v1 默认）。**核心不 import 任何外部 SDK**；宿主（DSH 插件）负责把 MCP 工具包成 hooks。

宿主侧薄适配在 `adapters.mjs`：`hindsightHooks(callTool)` 把 MCP 工具包成 `{search, read, health}`。**OpenViking 暂不接**——其 MCP 工具返回「Found N item(s)…」格式化文本，不是结构化 hits；v1 避免把文本当 hits 静默空，等 REST 或文本解析器。核心仍零依赖。

### 3.3 OpenViking REST（已真实冒烟）

`openvikingHttpHooks({ baseUrl, token })`：`POST /api/v1/search/search`（mode=list）+ `GET /api/v1/content/read?uri=`。
响应 `{status:'ok',result:{memories:[{uri,abstract,score}]}}` ⇒ hits `{id:uri,title:末段,text:abstract,raw}`；无 memories ⇒ degraded+raw。
实测：`http://127.0.0.1:<PORT>`，query「阿卡夏 记忆」→ 2 条真实 hits（identity.md 等），health 200。

### 3.2 Hindsight REST（已真实冒烟）

`hindsightHttpHooks({ baseUrl, bankId, token })`：直接走本机 daemon 的
`GET /v1/default/banks/{bank}/knowledge-base/search?q=&limit=` 与 `/pages/{id}`。
非 2xx/网络失败 ⇒ `{hits:[], degraded:true, reason}`；不重试、不缓存。

CLI：活树 `node tools/companion-recall.mjs "查询词" [--driver hindsight|openviking] [--limit 3] [--bank …] [--json]`；OSS 仓为 `node core/tools-companion-recall.mjs`（默认 `HINDSIGHT_API_URL`/`HINDSIGHT_API_PORT` + `HINDSIGHT_BANK_ID`）。

2026-10-19 实测：`http://127.0.0.1:<PORT>` + bank `coding-agent::Harness`，
query `CompanionPort 适配层` → 3 条真实 hits（`kp-…`），health HTTP 200。
配置口径：bank 未显式给时**自动发现**（GET `/v1/default/banks`，唯一 bank 直接用；多个时要求 `HINDSIGHT_BANK_ID`）；token 取 `HINDSIGHT_API_TOKEN`。

## 4. 切主条件（写死）

1. 连续观察期内端口主路径失败率 ≤ 现配套；
2. 注入 token 均值不升高；
3. 阿卡夏回归全绿（`test.mjs` / `check` / `family-sweep`）；
4. 旧标签继续 skip 一期，切主后至少一个版本再移除。

## 5. 后续（不在 v1）

- `adapters/hindsight.mjs` / `openviking.mjs`：只读 recall/read 的薄封装；
- `health` 接 `doctor` / `kit`（当前 doctor 有独立检查项）；
- 写入语义：等「已接收 / 已持久 / 已可检索」三态与 `expected_revision` 定义完成后再开。
