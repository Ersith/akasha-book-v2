// akasha/tools/store-readme-20261010.mjs —— 给五个插件 README 追加「DSH STORE 口径」段（幂等）
// 内容：固定源 SHA + 状态区分（verified/partial/unverified/blocked）+ 下一道门 + 权限与非目标与边界。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const SHA = 'd311ad54d1dc2cd2697c7b9eeac57eaa6466fc04'; // 2026-10-10：manifest + 测试批的冻结 Commit
const MARK = '<!-- store-status -->';

const common = (name, extra) => `

${MARK}
## 兼容与状态（DSH STORE 口径 · 2026-10-10）

**固定源（immutable source）**：本版本的源码冻结于 Commit \`${SHA}\`（对应 \`plugins/${name}/package.json\` 的 version）。
兼容声明见 manifest 的 \`dsh.compatibility.dshReleases\`：**0.2.0-rc.2 = compatible**（本机实测运行），
\`0.2.1-alpha.1\` / \`0.2.1-alpha.2\` 尚未实测 ⇒ 按契约如实写 \`unknown\`（不猜、不吹）。

| 证据层 | 状态 | 依据 |
|---|---|---|
| 静态契约（manifest / Bundle Patch / 许可证 / 入口 ID） | **verified** | 官方 \`build-dsh-plugin\` 审计：静态分见本包审计输出；入口 ID 为插件自有，不 disable/replace 任何 \`@deepseek-ai/*\` |
| 单元与边界测试（\`npm test\`） | **verified** | \`node selftest.test.mjs\` 全绿；覆盖 malformed 输入、并发/节流、replay 一致性（见该文件断言） |
| 一次性 Profile 安装·启动·卸载（E3） | **尚未（unverified）** | 本表如实标注：E3 证据**未执行**，属**下一道门**；不把未执行写成 passed |
| 真实 Profile 运行 | **verified（本机）** | 桌面端 0.2.0-rc.2 实跑；**他人机器 unverified**（未做外部验收） |
| 独立安全审计 / 公开分发（E5） | **unverified** | 未做独立审计；分发前应重评 |

**下一道门（next gate）**：① 用一次性 Profile（临时 \`DSH_HOME\`）跑通安装 → 启动 → 卸载并留证据；
② 在 0.2.1-alpha.x 上按同一套用例复测，把 \`unknown\` 改为精确结论（\`compatible\` 或 \`incompatible\`）。
若任一版本复测失败，该版本标注为 \`blocked\`（不兼容）并保持其余版本声明不动。

**权限 / 非目标 / 边界（permissions · non-goals · boundaries）**
- ${extra}
- **统一非目标（non-goals）**：不修改 DSH 核心与官方包；不替换、禁用或遮蔽任何官方组件；不写真实 Profile（测试一律用系统临时目录）；
  不在日志/输出里暴露凭据、完整用户文件或注入上下文。
- **测试隔离**：所有自测只使用 \`os.tmpdir()\` 下的临时目录；不读写真实库（\`~/.akasha\`）与真实会话档案。
`;

const blocks = {
  'akasha-gate': '读取：无（不读库文件）；写入：仅追加门控日志行（\n  `logs/hooks.jsonl` 的 `gate-armed` / 降级切换线）。核心职责是**拦**（拒绝未经校验写入数据目录的工具调用），\n  自身不写数据文件。系统提示注入段（`akasha:protocol` / `akasha:self`）为**渲染时读库**，读失败回退兜底、不抛。',
  'akasha-hooks': '读取：宿主事件（回合/工具/流式帧）与库内引用计数所需的最小数据；写入：**append-only** 追加 `logs/hooks.jsonl`（只增不改；不删行、不改历史行）。',
  'akasha-session': '读取：会话档案目录（默认 `~/.dsh/sessions`，可配置）；写入：只向 `data/session.jsonl` / `session-meta.json`（本插件自有索引）追加段记录；\n  索引在 **worker 线程**内跑（`lib/index-worker.mjs`），带单飞与最小间隔节流；**不修改会话档案原文**。',
  'akasha-sleep': '读取：`logs/hooks.jsonl`（蒸馏输入）；写入：**仅在触发时**写睡眠报告、`logs/inbox.jsonl`（候选待办）与水位线 `sleep-state.json`；\n  失败路径**不推进水位线**（回滚语义，见测试断言）；注入失败只降级显示，不抛。',
  'mcp-akasha': '读取：无（本包只含 Bundle Patch，不含运行代码）；写入：无。运行期由官方 `@deepseek-ai/dsh-mcp-client` 以 stdio 启动\n  `node <AKASHA_DIR>/mcp.mjs`（外部进程：读库 + 经校验写入），`args` 以数组给定，不做 shell 字符串拼接。',
};

let changed = 0;
for (const [name, extra] of Object.entries(blocks)) {
  const f = join(OSS, 'plugins', name, 'README.md');
  if (!existsSync(f)) { console.log('  ✗ 缺 README: ' + name); continue; }
  const t = readFileSync(f, 'utf8');
  if (t.includes(MARK)) { console.log('  = 已有状态段，跳过: ' + name); continue; }
  writeFileSync(f, t.replace(/\s*$/, '') + common(name, extra), 'utf8');
  console.log('  ✓ 追加状态段: ' + name);
  changed++;
}
console.log('  共修改 ' + changed + ' 份 README');
