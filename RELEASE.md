# 发布验证绑定

每个 release 必须能回答：**这个 tag 对应哪个 commit、装了哪套插件、在什么环境、跑了什么测试、已知限制是什么。**
本文件是发布记录；tag 一旦发布不再移动（需要补丁就发新 tag）。

## v0.1.3（2026-10-19）

| 项 | 值 |
|---|---|
| tag | `v0.1.3` |
| commit | `38ba22b`（P0 记忆安全底座；其后 `2ac70ea` 修 health 夹具，将并入下一版） |
| npm 插件 | `@akasha-book/gate@1.4.4` · `hooks@1.2.10` · `session@0.3.7` · `sleep@1.10.32` · `mcp@1.1.6` |
| 环境 | Windows 11 · Node 24.19.0 |
| core 测试 | `node core/test.mjs` → **294 passed / 0 failed / 1 skipped**（session 话题簇：OSS 不带 session.jsonl） |
| 库校验 | `node core/akasha.mjs check` → OK（活树快照：canon 930 / mirror 49 / orphan 152 / pricing 10 / lexicon 10 / frontier 180） |
| 插件自检 | 5/5 通过（gate / hooks / session / sleep / mcp） |
| 发布检查 | 活树 `oss-release-check` → **23/23 PASS**（含 5/5 变异自证） |
| 已知限制 | 会话层/睡眠完整功能需 DSH 宿主与会话档案；公开 `data/` 是脱敏快照；`tools-harvest-*` 接口不保证 |

安装见 [`docs/INSTALL.md`](docs/INSTALL.md)；内容边界见 [`CONTENTS.md`](CONTENTS.md)。



## v0.1.4（2026-10-19）

| 项 | 值 |
|---|---|
| tag | `v0.1.4` |
| commit | `6af5a49`（P0 审查返工：锁接管竞态闸 / 长龄兜底按 at / 原字节 b64 / hard 前隔离 / session 追加前隔离 / CI 时区） |
| npm 插件 | 与 v0.1.3 相同（gate 1.4.4 / hooks 1.2.10 / session 0.3.7 / sleep 1.10.32 / mcp 1.1.6） |
| core 测试 | `node core/test.mjs` → **295 passed / 0 failed / 0 skipped** |
| 插件自检 | 5/5 通过 |
| 并发锁压力 | 6 轮 × 10 进程争抢陈锁：**0 重叠**（临时目录，临界区 8ms） |
| CI | GitHub Actions `.github/workflows/ci.yml` → **success**（Linux / Node 24 / TZ=Asia/Shanghai） |
| 已知限制 | 同 v0.1.3；另有 P2 已知项（Atomics.wait 阻塞事件循环、隔离件清理策略等）留待后续 |



## v0.1.5（2026-10-19）

| 项 | 值 |
|---|---|
| tag | `v0.1.5` |
| commit | `90af2fb`（第二轮复审返工：session 追加路径全部持锁 / quarantine 增长时放弃截断 / 活锁不再按 at 抢 / 释放走闸 / EPERM 重试 / gate TTL 5s） |
| npm 插件 | 与 v0.1.3 相同（gate 1.4.4 / hooks 1.2.10 / session 0.3.7 / sleep 1.10.32 / mcp 1.1.6） |
| core 测试 | `node core/test.mjs` → **295 passed / 0 failed / 0 skipped**（自动用 `data-snapshot/`） |
| 数据面 | `core/data/` 中性示例；`core/data-snapshot/` 脱敏测试基线 |
| CI | GitHub Actions → **success** |
| 已知限制 | 跨主机锁语义未支持（同机优先）；P2 已知项（心跳/长临界区、隔离件清理策略）留待后续 |



## v0.1.6（2026-10-19）

| 项 | 值 |
|---|---|
| tag | `v0.1.6` |
| commit | `af990b8`（MCP 日常读默认 summary + 两跳协议；lookup 默认 6000 cap；session/brief/cross 预算回执） |
| 行为变化 | **仅 MCP**：`akasha_lookup/brief/cross/session_lookup` 不传 depth 时默认 `summary`（reflect 自动 full）；CLI 与直调 lib 默认不变 |
| core 测试 | `node core/test.mjs` → **295 passed / 0 failed / 0 skipped** |
| CI | GitHub Actions → **success** |
| 已知限制 | 运行中的 MCP 子进程需重启宿主才加载新默认；budget 为字符/既有 token 口径混用（字段已标注） |



## v0.1.7（2026-10-19）

| 项 | 值 |
|---|---|
| tag | `v0.1.7` |
| commit | `0d3aea0`（CompanionPort v1 只读契约；skipTags 配置化；doctor 配套检查；MCP 默认 summary 契约同步） |
| core 测试 | `node core/test.mjs` → **299 passed / 0 failed / 0 skipped** |
| 插件自检 | 5/5 通过（mcp 夹具白名单补 `companion.mjs`） |
| 发布检查 | `oss-release-check` → **23/23 PASS** |
| CI | GitHub Actions → **success** |
| 已知限制 | 端口为只读契约：driver 配置只到 degraded，adapter 未接；运行中的 MCP 子进程需重启才加载新默认 |

## 发布流程（此后每版照抄）

1. 冻结改动，跑 `node core/test.mjs` + `node core/akasha.mjs check` + 五个插件 selftest + 活树 `oss-release-check`。
2. 更新本文件：新增一节，记录 tag / commit / npm 版本 / 环境 / 测试结果 / 已知限制。
3. 打 tag、发布 Release，正文引用本节。
4. 发布后对 clone 做一次 30 秒验证：`node core/test.mjs` → `node core/akasha.mjs check` → 一个 `lookup`。
