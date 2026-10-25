// akasha/tools/audit-controls-20261009b.mjs —— 收窄版：只抓「强修复主张」缺证据
import { loadStore, currentRecords, STORES, show } from './lib.mjs';

const STRONG = /(已修复|修复完成|修好了|已解决|已生效|修复验证|已消除|问题已解|不再复现)/;
const EVID = /(实测|验证|回归|复跑|全绿|通过|哈希|sha|sha256|ls-remote|双跑|对拍|字节未变|字节未改|diff|校验|check|assertions|对照|反例|对照组)/i;

let strong = 0, withEvid = 0;
const noEvid = [];
for (const s of STORES) {
  for (const r of currentRecords(loadStore(s).records)) {
    const t = [r.claim, r.summary, r.situation, r.behavior, r.outcome, r.lesson, r.title].filter((x) => typeof x === 'string').join(' ');
    if (!STRONG.test(t)) continue;
    strong += 1;
    if (EVID.test(t)) withEvid += 1;
    else noEvid.push({ store: s, id: r.id, kw: (t.match(STRONG) || [])[0] });
  }
}
console.log('强修复主张命中 ' + strong + ' 条；含证据痕迹 ' + withEvid + '；缺证据痕迹 ' + noEvid.length);
for (const o of noEvid) console.log('  - [' + o.store + '] ' + o.id + ' («' + o.kw + '»)');
