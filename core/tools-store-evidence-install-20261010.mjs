// akasha/tools/store-evidence-install-20261010.mjs —— 把 E3 证据装进仓 + README 状态升级（幂等）
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const SRC = '<LOCAL_PATH>\\_scratch\\store-e3';
const PLUGINS = ['akasha-gate', 'akasha-hooks', 'akasha-session', 'akasha-sleep', 'mcp-akasha'];

const OLD_ROW = '| 一次性 Profile 安装·启动·卸载（E3） | **尚未（unverified）** | 本表如实标注：E3 证据**未执行**，属**下一道门**；不把未执行写成 passed |';
const NEW_ROW = '| 一次性 Profile 安装·启动·卸载（E3） | **verified** | 2026-10-10 一次性 DSH_HOME 实跑：install → cold start（HTTP 就绪）→ stop → uninstall → `--dump-config` 逐字回到基线；dsh 0.2.0-rc.2；证据见同目录 `EVIDENCE.json` |';
const OLD_GATE = '**下一道门（next gate）**：① 用一次性 Profile（临时 `DSH_HOME`）跑通安装 → 启动 → 卸载并留证据；\n② 在 0.2.1-alpha.x 上按同一套用例复测，把 `unknown` 改为精确结论（`compatible` 或 `incompatible`）。';
const NEW_GATE = '**下一道门（next gate）**：① 在 0.2.1-alpha.x 上按同一套用例复测（一次性 DSH_HOME），把 `unknown` 改为精确结论（`compatible` 或 `incompatible`）；\n② 提交 DSH STORE 上架申请（monorepo 子路径：`tree/main/plugins/<name>`）并跟进机器人预检。';

let n = 0;
for (const p of PLUGINS) {
  const evSrc = join(SRC, `${p}.evidence.json`);
  const evDst = join(OSS, 'plugins', p, 'EVIDENCE.json');
  if (existsSync(evSrc)) { copyFileSync(evSrc, evDst); }
  const f = join(OSS, 'plugins', p, 'README.md');
  let t = readFileSync(f, 'utf8');
  const before = t;
  t = t.replace(OLD_ROW, NEW_ROW).replace(OLD_GATE, NEW_GATE);
  if (t !== before) { writeFileSync(f, t, 'utf8'); n++; }
  console.log(`  ${p}: EVIDENCE.json ${existsSync(evDst) ? '✓' : '✗'} · README ${t !== before ? '已升级' : '（无变化/已升级过）'}`);
}
console.log('  README 更新 ' + n + ' 份');
