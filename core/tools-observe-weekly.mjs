// observe-weekly.mjs —— 观察期周报：固定基线 vs 最近 7 天，自动出报告文件（供定时任务调用）。
// 基线窗口 = C1/C3 上线前（2026-10-06..2026-10-10）；观察窗口 = 最近 7 天（含今天）。
// 用法：node tools/observe-weekly.mjs [--json]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = '<AKASHA_DIR>\\tools';
const NODE = process.execPath;
const OUTDIR = '<LOCAL_PATH>\\docs\\observe';
// 基线 = C1/C3 上线**之前**（上线日 2026-10-10）；观察 = 从上线日当天起（不与基线重叠）。
// 2026-10-11 修：早期版本把观察窗口算成「今天往前 7 天」，与基线重叠 ⇒ 差值恒为 0（假对照）。
const BASE = '2026-10-06:2026-10-09';
const OBS_FLOOR = '2026-10-10';

const d = new Date();
const iso = (x) => x.toISOString().slice(0, 10);
const obsEnd = iso(d);
const obsStartRaw = iso(new Date(d.getTime() - 6 * 864e5));
const obsStart = obsStartRaw < OBS_FLOOR ? OBS_FLOOR : obsStartRaw;
const OBS = obsStart + ':' + obsEnd;
const obsDays = Math.round((new Date(obsEnd + 'T00:00:00Z') - new Date(obsStart + 'T00:00:00Z')) / 864e5) + 1;

mkdirSync(OUTDIR, { recursive: true });
let out = '';
try {
  out = execFileSync(NODE, [join(HERE, 'observe.mjs'), '--base', BASE, '--obs', OBS, '--json'], { encoding: 'utf8' });
} catch (e) {
  out = 'observe.mjs 执行失败：' + (e && e.message ? e.message : String(e)) + '\n' + String(e && e.stdout ? e.stdout : '');
}
const header = [
  '=== 阿卡夏观察期周报 ===',
  '  生成时间 : ' + new Date().toISOString(),
  '  基线窗口 : ' + BASE + '（C1/C3 上线前）',
  '  观察窗口 : ' + OBS + '（最近 7 天）',
  '  口径文档 : dist/akasha-oss/docs/observation-metrics.md（先注册判据，再读数据）',
  ''
].join('\n');
const file = join(OUTDIR, 'observe-' + obsEnd + '.txt');
writeFileSync(file, header + out + '\n', 'utf8');
console.log('周报已生成：' + file);
console.log('  基线 ' + BASE + '  vs  观察 ' + OBS);
console.log(out.split('\n').filter((l) => l.trim()).slice(0, 6).map((l) => '  ' + l).join('\n'));
