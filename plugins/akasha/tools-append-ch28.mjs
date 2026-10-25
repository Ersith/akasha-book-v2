// akasha/tools/append-ch28.mjs —— 追加 CHECKS R28（MCP 桥重建 + 核心 mcp.mjs 加固）到 OSS 仓
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const F = '<LOCAL_PATH>\\dist\\akasha-oss\\CHECKS.md';
const MARK = '## R28 ·';
let t = readFileSync(F, 'utf8');
if (t.includes(MARK)) { console.log('  = R28 已存在，跳过'); process.exit(0); }
const section = `

## R28 · MCP 桥自研重建 + 核心 mcp.mjs 加固（2026-10-10）

- **来源**：DSH-Store 预检拒收（\`SUBMISSION_PATCH_PROTECTED\`：第三方 Bundle Patch 不得以 \`name: @deepseek-ai/...\` 引用官方包；而官方 \`@deepseek-ai/dsh-mcp-client\` 未导出"注册 MCP 服务器"的服务）。用户指令：「mcp 也搞下」。
- **机制**：\`plugins/mcp-akasha\` 重写为**自带 stdio 客户端**的注册桥（\`index.js\`，零依赖、不 import 任何官方包）：spawn MCP 服务器 → JSON-RPC（\`initialize\` → \`notifications/initialized\` → \`tools/list\`）→ \`ctx.tools.register(def)\` 注册为 \`mcp__<server>__<tool>\`；名规范化与官方同类规则（非法字符→\`_\`；被改写或超长（>64）→ 截断 + 12 位 sha256）；定义五键形状 \`name/description/parameters/output{schema,render}/execute\`（照契约自写，未抄官方代码）；\`execute\` 返回 \`{content, structuredContent?}\`，\`isError\` → throw。Patch 只引用自有包名（\`@akasha-book/mcp\`），版本 1.1.0。
- **加固（本轮人读 + 实测发现，全部为真 bug）**：① 桥侧 \`stdin/stdout/stderr\` 未挂 \`error\` ⇒ 子进程死后写 stdin 的**异步 EPIPE** 会打死宿主（E3 实测复现）→ 三条流挂 error + \`writable\` 预检；② 注册循环中途抛错会**残留部分注册**且日志说谎 → 加回滚 + 精确日志；③ 软失败路径**不杀子进程**（泄漏）→ 补 \`cleanup()\`；④ \`execute\` 忽略 \`exec.signal\` → 补取消语义；⑤ **核心 \`core/mcp.mjs\`** 的两处同族缺陷：\`handle(msg)\` 无形状校验（\`null\`/数字/字符串等合法 JSON ⇒ 解构抛 TypeError ⇒ **服务器整台死**）、\`process.stdout\` 无 \`error\` 处理（客户端先退 ⇒ **EPIPE 崩**）→ 加形状校验（回 \`-32600\`）、\`handle\` 外层兜底（回 \`-32603\`）、非法 JSON 回 \`-32700\`、stdout/stderr/stdin error → 安静退出。
- **验证（我方独立）**：插件自测全绿（端到端：真实 MCP 服务器注册 **18 工具** + 真调 \`akasha_check\` 返回 \`{ok:true,errors:[]}\`；畸形六形状 6/6 回错误且**服务器存活**；EPIPE 实测 exit=0 无崩溃栈；注册回滚、取消信号、硬/软失败路径）；核心套件 **137/137**（OSS）/ **138/138**（活树）；**E3 全矩阵 5 插件 × 3 版 DSH（0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-alpha.2）= 15/15 通过**；官方 \`build-dsh-plugin\` 审计 **100/100**（静态 80 + 运行时 20）；DSH-Store 预检 **passed**（扫描面完整；1 条 \`warning/shell/child-process\` 属预期，桥本就 spawn 本地进程）。
- **文档**：新增 \`docs/upstream-contracts.md\`（对 DSH 的五个耦合点 C1–C5 + 升级时的固定检查动作 + 边界）。
- **遗留**：本机 profile 装的仍是旧构建（sleep 1.5.1 动态加载版 / mcp 1.0.0 官方客户端版）——**需重打包 + 安装 + 重启**后才会切到新设计（由用户操作）。
`;
appendFileSync(F, section, 'utf8');
console.log('  ✓ 已追加 CHECKS R28');
