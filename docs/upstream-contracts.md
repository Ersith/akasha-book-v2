# 上游契约（Upstream contracts）：我们对 DSH 的耦合点与检查动作

> 目的：把「我们对宿主实现的隐式依赖」写成**明文契约**，每处都配一个**可执行的检查**。
> 背景：2026-10-10 sleep 插件为了满足 DSH-Store 的静态扫描，把「动态加载宿主 `dsh-llm` 取 `createUserMessage`」改为**本地构造**——
> 代价是失去"自动跟随上游实现"，因此把该耦合移进**测试**并在此登记。
> 相关：`CHECKS.md`（发布记录）、`docs/` 其余文档。

## 契约清单

| # | 耦合点 | 我们依赖的形状 | 检查（怎么发现上游变了） | 现状 |
|---|---|---|---|---|
| C1 | **用户消息形状**（sleep 唤醒条注入） | `createUserMessage(input)` = `deepFreeze(structuredClone({ ...input, role:'user', id: <uuid 字符串> }))`；字段集合 = `content / id / role / source` | `plugins/akasha-sleep/selftest.test.mjs` 的**契约测试**：本机能找到宿主包时（`AKASHA_DSH_MODULES`，默认 `<DSH_INSTALL>`），逐字段比对我们的构造与宿主 `createUserMessage` 的输出（键集合 / role / id 类型 / content / source / 冻结语义）。**键集合不一致即红。** | 对齐 DSH `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`（三版 E3 全过） |
| C2 | **工具定义形状**（mcp 桥注册） | `ctx.tools.register({ name, description, parameters, output:{schema, render}, execute, projectContent })`；公开名 `mcp__<server>__<tool>`（非法字符→`_`；改写或 >64 → 截断 + 12 位 sha256） | `plugins/mcp-akasha/selftest.test.mjs`：桩 ctx 断言六项形状 + 公开名规则；**端到端**用真实 MCP 服务器注册并真调一次 | 对齐同上三版 |
| C3 | **插件装载契约** | `export const inject = [...]`、`apply(ctx, config)`（可为 async）、`ctx.tools.register` 返回 disposer、`ctx.effect`/`ctx.on('dispose')` 清理 | 每个插件的 `selftest.test.mjs` 用桩 ctx 跑 `apply()`；E3（一次性 Profile 装-启-卸）验证真装载 | 同上 |
| C4 | **Profile 启动语义** | profile 由 shipped 模板创建（`--from-default-profile <模板>`）；`--dump-config` 可读组合；`plugin add/remove` 走官方 CLI | E3 跑器 `akasha/tools/store-e3-20261010.mjs`（三版 DSH 各跑一遍装-启-卸-组成还原） | 同上 |
| C5 | **观测线格式**（hooks.jsonl） | 逐行 JSON，`kind` 字段区分事件；我们只**追加**、不修改 | 各插件 selftest 断言自己的 `kind` 落线；`node akasha.mjs check` / `metrics` 读同一份日志 | 同上 |

## 升级 DSH 时的固定动作（checklist）

1. 装新版 DSH 到**临时目录**（不要动真实 profile）：`npm i --prefix <tmp> @deepseek-ai/dsh@<ver>`；
2. 跑 **E3 矩阵**：`node akasha/tools/store-e3-20261010.mjs --cli <tmp>/node_modules/@deepseek-ai/dsh/lib/bin.js`（五插件 × 装-启-卸）；
3. 跑 **全部插件自测**（含 C1/C2 契约测试）：`node plugins/<名>/selftest.test.mjs` ×5；契约测试若红 → 先改本地构造/定义形状，再谈上架；
4. 更新 `dsh.compatibility.dshReleases`：新版本声明 `compatible`/`incompatible`/`unknown`（**没测过就写 unknown，不猜**）；
5. 重启真实 profile 后，验一条**真实路径**（如唤醒条是否落 `wake-note` 线、`mcp__akasha__*` 是否可用），并把结论回写本表与 `CHECKS.md`。

## 明确不承诺的事（边界）

- 我们不承诺"上游改了也不会坏"——只承诺**上游一改，检查会红**（C1/C2 都是可执行的）；
- 不承诺对所有 DSH 版本兼容：只对 `dsh.compatibility.dshReleases` 里**实测过**的版本负责；
- 契约测试依赖宿主**内部文件路径**（`@deepseek-ai/dsh-llm/lib/index.js` 等）——这些是**测试专用**的读取，运行时代码不依赖它们；路径若变，测试会自动降级为 SKIP 并打印提示（不会假绿：SKIP 与 PASS 在输出里可区分）。
