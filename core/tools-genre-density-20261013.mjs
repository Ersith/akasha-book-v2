// akasha/tools/genre-density-20261013.mjs —— I-17「试行」一次性观测：本批新条目的写侧体裁密度读数
// （技术校验按计划留待批次 2；本脚本只是**一次性的试行留痕**：A 类控符号、B 类可符号但建议分段）
import { loadStore, currentRecords } from './lib.mjs';

const IDS = [
  'canon-akasha-batch1-i01i02-20261013',
  'canon-trap-fixture-today-timebomb-20261013',
  'canon-checker-quiet-must-not-swallow-20261013',
  'canon-akasha-batch1-i03i04-20261013',
  'canon-protocol-fourway-triage-20261013',
  'canon-writepath-checklist-20261013',
  'canon-akasha-usage',
];
const cur = currentRecords(loadStore('canon').records);
const count = (s, re) => (String(s).match(re) || []).length;
for (const prefix of IDS) {
  const r = cur.find((x) => String(x.id) === prefix || String(x.id).startsWith(prefix + '-r'));
  if (!r) { console.log('（缺）' + prefix); continue; }
  const claim = String(r.claim ?? '');
  const paras = claim.split(/\n+/).filter(Boolean).length;
  const symbols = count(claim, /[⇒✓]/g);
  const done = count(claim, /好。/g);
  const cls = r.id.startsWith('canon-akasha-usage') ? 'A（注入面）' : 'B（按需检索）';
  const flag = cls.startsWith('A') && (symbols > 2 * Math.max(1, paras)) ? ' ⚠ A 类符号超限' : '';
  console.log(`${r.id}  [${cls}]  段 ${paras} · ⇒/✓ ${symbols} · 「好。」 ${done}${flag}`);
}
