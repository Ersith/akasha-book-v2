// 检测器自检 · 正式版（2026-10-11 立；用户裁定「确保你的检测脚本没bug，不然就等于没检测」）
//
// 为什么必须有它：**只验"真实库零违规"证明不了检查在工作**（可能它根本没生效）✗
//   所以每条检查都要**两侧自证**：① 违规输入**必须报**（能红）② 合法输入**不许报**（不误伤）。
//   注意设计：断言"必须报"这件事**本身就防空跑** —— 若检查失效，这里会**红** ✓（这正是 §七.7② 的落地）
//
// 跑法：`node tools/checker-selftest.mjs`（也可被 test.mjs 引用）
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as lib from './lib.mjs';

export function runCheckerSelftest({ quiet = false } = {}) {
  let pass = 0, fail = 0;
  const log = (...a) => { if (!quiet) console.log(...a); };
  const t = (name, fn, want) => {
    let got; try { got = fn(); } catch (e) { got = 'THREW:' + String(e.message).slice(0, 60); }
    const ok = want === 'throw' ? String(got).startsWith('THREW') : got === want;
    ok ? pass++ : fail++;
    log('  ' + (ok ? '✓' : '✗') + ' ' + name.padEnd(46) + ' 实得=' + JSON.stringify(got).slice(0, 56));
  };
  const codes = (loaded, f) => lib.checkPromotions(loaded, f).map((e) => e.code);
  const D = mkdtempSync(join(tmpdir(), 'akasha-chk-'));   // 2026-10-14：改 os.tmpdir()——原硬编码本机 _scratch（开源同步后不可移植/被清洗击穿）
  const W = (name, arr) => { const p = join(D, name); writeFileSync(p, arr.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8'); return p; };
  const CANON_OK = { id: 'canon-real', claim: 'x', source: { type: '复现', ref: 'r' }, last_reviewed: '2026-10-11' };

  log('══ cite-dangling（引用完整性）══');
  t('引用不存在的 id ⇒ 必须报', () => codes({}, W('s1', [{ kind: 'node', id: 'node-a', gist: 'A', based_on: ['canon-nope'] }])).includes('cite-dangling'), true);
  t('引用存在的段 id ⇒ 不报', () => codes({}, W('s2', [{ kind: 'conclusion', id: 'seg-x', gist: '叶' }, { kind: 'node', id: 'node-b', gist: 'B', based_on: ['seg-x'] }])).includes('cite-dangling'), false);
  t('引用存在的六库 id ⇒ 不报', () => codes({ canon: [CANON_OK] }, W('s3', [{ kind: 'node', id: 'node-c', gist: 'C', refs: ['canon-real'] }])).includes('cite-dangling'), false);
  t('refs 为对象 {id} ⇒ 同样能查', () => codes({}, W('s4', [{ kind: 'node', id: 'node-d', gist: 'D', refs: { id: 'canon-nope' } }])).includes('cite-dangling'), true);

  log('══ #32 合成禁互引 ══');
  t('摘要引摘要 ⇒ summary-cites-summary', () => codes({}, W('s5', [{ kind: 'node', id: 'node-x', gist: 'A' }, { kind: 'node', id: 'node-y', gist: 'B', based_on: ['node-x'] }])).includes('summary-cites-summary'), true);
  t('children 结构 ⇒ 不报', () => codes({}, W('s5b', [{ kind: 'node', id: 'node-p', level: 2, children: ['node-q'] }, { kind: 'node', id: 'node-q', level: 1, children: [] }])).includes('summary-cites-summary'), false);
  t('promoted_from → 摘要 ⇒ promotion-source-not-leaf', () => codes({ canon: [{ id: 'canon-t', claim: 'x', promoted_from: { id: 'node-x' } }] }, W('s6', [{ kind: 'node', id: 'node-x', gist: 'A' }])).includes('promotion-source-not-leaf'), true);
  t('promoted_from → 叶段 ⇒ 不报 not-leaf', () => codes({ canon: [{ id: 'canon-t', claim: 'x', promoted_from: { id: 'seg-x' } }] }, W('s6b', [{ kind: 'conclusion', id: 'seg-x', gist: '叶' }])).includes('promotion-source-not-leaf'), false);

  log('══ 升格三向 + 基线 ══');
  t('bad-jsonl（坏行）', () => { const p = join(D, 's7'); writeFileSync(p, '{ 坏\n', 'utf8'); return codes({}, p).includes('bad-jsonl'); }, true);
  t('promotion-dangling（标记指向不存在）', () => codes({}, W('s8', [{ kind: 'promotion', id: 'pm-1', promoted_to: { store: 'canon', id: 'canon-ghost' }, seg: 'seg-1' }])).includes('promotion-dangling'), true);
  t('promotion-source-missing（源不存在）', () => codes({ canon: [{ id: 'canon-u', claim: 'x', promoted_from: { id: 'seg-nope' } }] }, W('s9', [])).includes('promotion-source-missing'), true);
  t('promotion-unmarked（有源无标记）', () => codes({ canon: [{ id: 'canon-v', claim: 'x', promoted_from: { id: 'seg-x' } }] }, W('s10', [{ kind: 'conclusion', id: 'seg-x', gist: '叶' }])).includes('promotion-unmarked'), true);
  t('promotion-session-missing（有升格但无 session 文件）', () => codes({ canon: [{ id: 'canon-w', claim: 'x', promoted_from: { id: 'seg-x' } }] }, join(D, 'nope.jsonl')).includes('promotion-session-missing'), true);

  log('══ validateRecord（写入侧校验）══');
  t('canon 缺 claim ⇒ 拒', () => lib.validateRecord('canon', { id: 'x', source: { type: '复现', ref: 'r' }, last_reviewed: '2026-10-11' }).length > 0, true);
  t('canon 合法 ⇒ 通过', () => lib.validateRecord('canon', { ...CANON_OK }).length, 0);
  t('orphan 缺 would_refute ⇒ 拒', () => lib.validateRecord('orphan', { id: 'o', summary: 's', observed: 'o', hypothesis: 'h', would_confirm: 'c', severity: '低', created: '2026-10-11' }).length > 0, true);
  t('valence 越界 ⇒ 拒', () => lib.validateRecord('pricing', { id: 'p', behavior: 'b', valence: 9, severity_default: 3 }).length > 0, true);

  try { rmSync(D, { recursive: true, force: true }); } catch {}
  log('\n  检测器自检：' + pass + ' 通过 / ' + fail + ' 失败');
  return { pass, fail };
}

// 直接跑时作为 CLI
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const r = runCheckerSelftest();
  process.exit(r.fail ? 1 : 0);
}
