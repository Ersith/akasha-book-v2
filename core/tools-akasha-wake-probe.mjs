// One-shot probe: evaluate the akasha wake-note decision with live library data.
const a = await import('file:///<AKASHA_DIR>/lib.mjs');
const s = await import('file:///<LOCAL_PATH>/dsh-akasha-sleep/lib/index.js');

const k = a.kit();
const verdict = {
  noteworthy: s.isWakeNoteworthy(k),
  hasSleep: Boolean(k.sleep),
  inboxItems: k.inbox?.totalItems ?? null,
  reviewOk: k.review?.ok ?? null,
  findings: k.review?.findings ?? null
};
console.log(JSON.stringify(verdict, null, 2));
if (verdict.noteworthy) {
  console.log('--- wake note text ---');
  console.log(s.buildWakeNote(k));
}
