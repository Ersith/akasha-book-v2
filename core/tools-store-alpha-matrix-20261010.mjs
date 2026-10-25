// akasha/tools/store-alpha-matrix-20261010.mjs —— 复测结果回写：两个 alpha 由 unknown → compatible（幂等）
// 依据：三版矩阵 E3 全过（0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-alpha.2 × 五插件；报告 _scratch/store-e3/e3-run-*.json）
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const RUNS_DIR = '<LOCAL_PATH>\\_scratch\\store-e3';
const PLUGINS = ['akasha-gate', 'akasha-hooks', 'akasha-session', 'akasha-sleep', 'mcp-akasha'];

const runs = readdirSync(RUNS_DIR).filter((f) => f.startsWith('e3-run-')).sort();
let manifestN = 0, evN = 0;
for (const p of PLUGINS) {
  // ① manifest：两个 alpha unknown → compatible
  const mf = join(OSS, 'plugins', p, 'package.json');
  let t = readFileSync(mf, 'utf8');
  const before = t;
  t = t.replace('"0.2.1-alpha.1": "unknown"', '"0.2.1-alpha.1": "compatible"').replace('"0.2.1-alpha.2": "unknown"', '"0.2.1-alpha.2": "compatible"');
  if (t !== before) { writeFileSync(mf, t, 'utf8'); manifestN++; }

  // ② EVIDENCE.json：注明三版矩阵
  const ev = join(OSS, 'plugins', p, 'EVIDENCE.json');
  if (existsSync(ev)) {
    const j = JSON.parse(readFileSync(ev, 'utf8'));
    const cite = `三版矩阵各跑通本插件的 E3（0.2.0-rc.2 / 0.2.1-alpha.1 / 0.2.1-alpha.2；报告 _scratch/store-e3/${runs.join(' , ')}；2026-10-10）`;
    if (!String(j.isolatedRuntime.evidence).includes('三版矩阵')) {
      j.isolatedRuntime.evidence = String(j.isolatedRuntime.evidence) + ' 【' + cite + '】';
      j.dumpConfig.evidence = String(j.dumpConfig.evidence) + ' 【' + cite + '】';
      writeFileSync(ev, JSON.stringify(j, null, 1), 'utf8');
      evN++;
    }
  }
}
console.log(`  manifest 更新 ${manifestN} 份 · EVIDENCE 更新 ${evN} 份`);
for (const p of PLUGINS) {
  const j = JSON.parse(readFileSync(join(OSS, 'plugins', p, 'package.json'), 'utf8'));
  console.log('  ' + p.padEnd(16) + JSON.stringify(j.dsh.compatibility.dshReleases));
}
