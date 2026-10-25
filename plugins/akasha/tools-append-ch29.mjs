// append-ch29.mjs —— 追加 CHECKS R29（门控覆盖缺口 + 覆盖清单测试）
import { readFileSync, appendFileSync } from 'node:fs';
const F = '<LOCAL_PATH>\\dist\\akasha-oss\\CHECKS.md';
const MARK = '## R29 ·';
const t = readFileSync(F, 'utf8');
if (t.includes(MARK)) { console.log('  = R29 已存在'); process.exit(0); }
appendFileSync(F, `

## R29 · 门控覆盖缺口修复 + 「写盘工具覆盖清单」测试（2026-10-10，人读复查）

- **来源**：用户裁定「不要依赖脚本，逐项排查」→ 逐行读 \`plugins/akasha-gate/index.js\`（239 行）时发现：守卫只覆盖 \`WRITE_TOOLS={edit,write,apply_patch}\` 与 \`SHELL_TOOLS={pwsh,bash}\`，**漏了 \`dsh_wsl\`（WSL bash）与 codex 系（\`codex_exec\` / \`codex_thread_*\`，子进程可写盘）**——两条真实绕道。
- **修复**：\`SHELL_TOOLS\` 增 \`dsh_wsl\`；新增 \`AGENT_TOOLS\` 扫描委派型 prompt（数据目录 + 写动作 ⇒ 拒绝）；\`WRITE_IDIOM\` 补**中文写动词**（追加/写入/改写/覆盖/替换/清空/删除/修改/编辑）与 \`append|overwrite|modify\`；版本 **1.2.3**。
- **边界（写进代码注释）**：WSL 侧同一物理文件可能以 \`/mnt/<盘>/…\` 出现，而守卫只认配置形态的 \`dataDir\` ⇒ 挂载路径写法**拦不住**；这是"劝告层"的已知边界，不是安全承诺。
- **测试（防复发）**：selftest 新增**写盘工具覆盖清单**——11 条"写数据必被拒"用例覆盖 \`edit/write/apply_patch/pwsh/bash/dsh_wsl×2/codex_exec×2/codex_thread_start/codex_thread_resume\`，外加 3 条"只读必须放行"反向用例；**新增写盘工具时先加进清单，漏了就红**。
- **变异回归（证明测试不是装饰）**：用修复前的 \`index.js\`（\`git show <sha>^:plugins/akasha-gate/index.js\`）跑同一批用例 ⇒ \`dsh_wsl\` 与 \`codex_exec\` **当场未拦**（红），修复后全绿。
- **工具侧同步**：工作区扫描器 \`tools/risk-scan.mjs\` 增加 \`RISK-GUARD-COVER\` 规则（守卫文件必须提到 \`WRITER_TOOLS\` 清单里的每个工具），其自测用**修复前的 gate 文件**做回归——落实「手检发现而脚本没报 ⇒ 完善脚本」的常设纪律。
`, 'utf8');
console.log('  ✓ 已追加 CHECKS R29');
