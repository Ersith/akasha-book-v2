// akasha/tools/audit-controls-20261009.mjs —— 举一反三扫描：全库「修复/生效」类主张缺对照者
// 用法：node tools/audit-controls-20261009.mjs [--sample N]
import { loadStore, currentRecords, STORES } from './lib.mjs';

const TRIG = /(修复|已修|修正|解决|生效|已消除|已上线|已启用|验证通过|已复现|reproduced|fixed)/i;
const CTRL = /(对照|反例|对照组|control|对拍|前值|后值|before|after|回滚|字节未改|未复现|不成立|零残差|全等|双跑|两次)/i;
const args = process.argv.slice(2);
const sampleN = Number(args[args.indexOf('--sample') + 1]) || 25;

function textOf(r) {
  return [r.claim, r.summary, r.situation, r.behavior, r.outcome, r.lesson, r.title, r.note, r.behavior_text]
    .filter((x) => typeof x === 'string').join(' ');
}

let withCtrl = 0, noCtrl = 0, refutedCount = 0;
const offenders = [];
for (const s of STORES) {
  for (const r of currentRecords(loadStore(s).records)) {
    const t = textOf(r);
    if (!TRIG.test(t)) continue;
    if (CTRL.test(t)) withCtrl += 1;
    else { noCtrl += 1; offenders.push({ store: s, id: r.id, kw: (t.match(TRIG) || [])[0] }); }
    if (/refut|否定|被否/.test(t)) refutedCount += 1;
  }
}
console.log('扫描六库当前集：触发词命中 ' + (withCtrl + noCtrl) + ' 条');
console.log('  含对照痕迹: ' + withCtrl + '  缺对照痕迹: ' + noCtrl + '  （另有 refute/否定 语境 ' + refutedCount + '）');
console.log('缺对照样本（前 ' + sampleN + '）：');
for (const o of offenders.slice(0, sampleN)) console.log('  - [' + o.store + '] ' + o.id + '  («' + o.kw + '»)');
