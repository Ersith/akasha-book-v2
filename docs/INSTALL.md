# 安装与配置（Akasha 阿卡夏之书 · DSH 插件家族）

> 面向**第一次安装**的人。目标：装完就能用，且**以后升级不丢配置**。
> 本文里的坑都是我们自己在 2026-10-10 亲手踩过的（详见各条「为什么」）。

## 0. 三分钟版

```bash
# ① 选一个属于你的库目录（下文统称 <AKASHA_DIR>；推荐家目录下 .akasha）
#    把 core/ 与 mcp.mjs 等文件放进去（本仓 core/ 即库的代码面，data/ 是数据面）
export AKASHA_DIR="$HOME/.akasha"          # Windows(PowerShell): $env:AKASHA_DIR = "$HOME\.akasha"

# ② 装五个插件（本仓为源码分发：用 tgz / 本地目录安装。五包 package.json 仍是 private:true，
#    npm 轨道上的历史版本不代表本仓内容，请勿按「npm install」使用）
#    gate / hooks / sleep / session / mcp
node <AKASHA_DIR>/init-example.mjs  # 可选：造示例库确认通路（独立脚本；akasha.mjs 没有 init-example 子命令）

# ③ 重启 DSH（**插件变更是 restart-required**，不重启不生效）

# ④ 验收（见 §4）
```

## 1. 关键约定：一处配置，贯通全部路径

`gate` / `hooks` / `sleep` / `session` 四个插件按 **`config.akashaDir` → 环境变量 `AKASHA_DIR` → `~/.akasha`** 的顺序解析库根目录，
其余路径（`data/`、`logs/hooks.jsonl`、`sleep-state.json`、`inbox.jsonl`、`sessions/` 索引…）**跟着库根自动推导**。
**`mcp` 插件是例外：它不读 `AKASHA_DIR`**，必须用配置里的 `args` 指向 `<AKASHA_DIR>/mcp.mjs`（缺失时只记一行日志、不注册工具）。

- **推荐只设 `AKASHA_DIR`**（环境变量）。它不随插件升级被覆盖。
- 每条 patch 里也可以逐项写 `akashaDir` / `log` / `dataDir`，**但只写一处、其余留默认**——逐项写而漏一项，就是下面那条坑。

> **为什么**：我们本机曾把配置只写在「安装后的包内 patch」里，结果一次正常升级把它覆盖掉：门控立刻退回 `homedir()` 默认路径，
> 用法条/自我层静默降级为兜底文本、`sleep` 拿不到核心库——**功能没报错，只是悄悄换了库**。教训：
> **配置要放在升级不会碰的地方（环境变量 / 你的 profile 覆盖），不要只写在包内 patch。**

## 2. 各插件要什么

| 插件 | 作用 | 必要配置 | 备注 |
|---|---|---|---|
| `@akasha-book/gate` | 拦下对 `data/` 的直接文件/命令写操作；注入用法条 + 自我层 | `akashaDir`（或 `AKASHA_DIR`）；`dataDir` 默认跟随 | `dataDir` 用于守卫判定；**只读探针不会被拦** |
| `@akasha-book/hooks` | 宿主事件 → `logs/hooks.jsonl` 观测线（含脱敏） | `akashaDir`；`log` 默认跟随 | 缺 `akashaDir` 时**脱敏/输出审计静默退化** |
| `@akasha-book/sleep` | 空闲/定时蒸馏 → 报告 + inbox 待办；每回合摘要条 + 新会话唤醒条 | 无（默认跟随库根） | `wakeNote: false` 可关唤醒条 |
| `@akasha-book/session` | 会话层：自动增量索引 + 节奏条 + 弧线树 | 无（默认跟随库根） | `sessionsRoot` 指向 DSH 的会话目录 |
| `@akasha-book/mcp` | 把库的工具以 `mcp__akasha__*` 暴露给模型 | `args` 指向 `<AKASHA_DIR>/mcp.mjs` | `command` 默认 `node`；**没有 node 时自动回退到宿主自带 node** |

Bundle Patch 示例（把 `<AKASHA_DIR>` 换成你的绝对路径；**Windows 路径用单引号包住**）：

```yaml
- insert:
    - id: mcp-akasha
      name: '@akasha-book/mcp'
      config:
        serverName: akasha
        command: 'node'
        args: ['<AKASHA_DIR>/mcp.mjs']
```

> **`~` 不会被自动展开**（Node 语义）。写 `~/.akasha` 这种值必须让插件展开，或在配置里写绝对路径。
> 我们的插件对**配置值**做了 `~` 展开，但**环境变量与默认值**请用绝对路径最稳。

> **占位符不替换会直接报错（2026-10-19 起）**：五个插件都在 `apply()` 入口检测 `<AKASHA_DIR>` / `<LOCAL_PATH>`
> 这类未替换的占位符，命中即抛错并点名出问题的字段。此前是静默降级——照抄示例的结果是 gate 失去写保护、
> mcp 拉不到 `mcp.mjs`（22 个工具全消失，`failOnStartupError:false` 让它连报错都没有）。
> 看到 `未替换的占位符` 字样就说明配置还没改完，改完重启即可。

## 5. 配套系统（Companion systems）

阿卡夏本体**可独立运行**（核心零第三方 npm 依赖）。完整记忆栈建议同时具备：

- **Hindsight**（仓库级记忆：架构 / 约定 / 决策 / initiative）——阿卡夏的会话索引与睡眠蒸馏会跳过它的注入块（`<hindsight_knowledge>`），两边互不写入对方存储；
- **OpenViking**（用户与人格记忆、跨项目上下文）——同上，跳过 `<openviking-context>`；
- **宿主自带会话检索**（`session_search` / `session_event_read`）——原始事件、逐字引文、精确过滤走官方工具；`mcp__akasha__akasha_session_lookup` 只负责结论 / 决策 / 教训 / 跨会话导航。

缺任一层不会报错：只是少了那层交叉记忆（或「回官方深查」的路由不可用）。
## 3. 常见坑（都发生过）

1. **配置写在包内 patch，升级即丢** → 用 `AKASHA_DIR` 或 profile 级覆盖。
2. **同名同版本、内容不同的包**：本地重新打包后安装会得到 `ambiguous-install`（工具拒绝执行，不会破坏现状）。
   → **改内容就升版本号**（或在本地包名上加后缀）。
3. **改了插件不生效**：桌面端是**启动型**，安装返回 `restart-required`，必须重启。
4. **`node` 不在 PATH**：mcp 桥会自动回退到宿主自带 node 并留日志；若仍失败，看宿主日志里的 `mcp-akasha(...)` 行。
5. **`data/` 被自己的脚本写坏**：门控会拒绝（这是设计），改走 `akasha.mjs` CLI 或 `mcp__akasha__*`；
   WSL/委派型工具同样受管，但 **WSL 用 `/mnt/...` 挂载路径写法时门控无法识别**（已知边界，见 `docs/upstream-contracts.md`）。
6. **门控/插件自己出错时**：一律**放行/静默**（门控自崩不能拖垮宿主），并尽量落一行观测线；查不到原因时先看 `logs/hooks.jsonl`。

## 4. 安装后验收（照做即可）

```bash
# ① 库本体（应打印 OK — 六库计数）
node <AKASHA_DIR>/akasha.mjs check

# ② MCP 桥（模型侧应能调用）
#    让模型调用一次 mcp__akasha__akasha_check；返回 {"ok":true,...} 即通

# ③ 观测线（重启后应出现这些 kind）
#    gate-armed / session-armed / sleep-armed；新会话还应出现 wake-note
Get-Content <AKASHA_DIR>/logs/hooks.jsonl -Tail 20

# ④ 注入来源（关键！应显示 library，而不是 fallback）
#    gate-armed 行里的 usageSource / selfSource 字段
```

- `usageSource: library` ⇒ 用法条/自我层**真的在读你的库**；`fallback` ⇒ 走的是内置兜底文本（**库没被读到**，通常是路径配错）。
- **WSL 边界（验收项之一）**：门控**认不出** WSL 用 `/mnt/<盘>/…` 挂载写法对 `data/` 的写入——它是"劝告层"，不是安全承诺；验收时要知道**它守不住什么**。
- `wake-note` 只在「无睡眠记录 / 有待办 / 审计有警告」时出现——它安静是正常的。
