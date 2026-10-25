import test from 'node:test';
import assert from 'node:assert/strict';
import { recordToView } from './record-view.mjs';
import { evaluate, recordDigest } from './forgetting.mjs';

test('recordToView maps legacy self to protected C1 and canonical text digest', () => {
  const record = {
    id: 'canon-self-demo', claim: '我是大肥鱼。',
    tags: ['自我'], event_time: '2026-10-24', review: null,
  };
  const view = recordToView(record, { store: 'canon', contextRef: 'ctx:self' });
  assert.equal(view.contentClass, 'C1');
  assert.equal(view.protection, true);
  assert.equal(view.eventDay, '2026-10-24');
  assert.equal(view.digest, recordDigest({ store: 'canon', id: record.id, versionId: record.id, content: { text: '我是大肥鱼。' } }));
  assert.equal(evaluate(view, {}, { today: '2026-10-24' }).retention, 1);
});

test('unknown canon requires explicit C2/C3; instant time stays an instant; C1 spoof is rejected', () => {
  const record = { id: 'canon-demo', claim: '一条事实', logged_at: '2026-10-20T10:00:00Z' };
  assert.throws(() => recordToView(record, { store: 'canon' }), /contentClass/);
  assert.throws(() => recordToView(record, { store: 'canon', contentClass: 'C1' }), /C1/);
  const view = recordToView(record, { store: 'canon', contentClass: 'C2', contextRef: 'ctx:x' });
  assert.equal(view.contentClass, 'C2');
  assert.equal(view.eventTime, '2026-10-20T10:00:00Z');
  assert.equal(view.eventDay, undefined);
  assert.equal(view.protection, false);
});

test('mirror uses the full tuple and session hashes gist plus why', () => {
  const mirror = {
    id: 'mirror-demo', role: 'solution', situation: 's', behavior: 'b', outcome: 'o',
    social_reaction: 'r', emotion: 'e',
  };
  const mirrorView = recordToView(mirror, { store: 'mirror', contextRef: 'ctx:m' });
  assert.equal(mirrorView.contentClass, 'C2');
  assert.deepEqual(mirrorView.content, { situation: 's', behavior: 'b', outcome: 'o', social_reaction: 'r', emotion: 'e' });

  const session = { id: 'session-demo', gist: 'g', why: 'w', temporary: true };
  const sessionView = recordToView(session, { store: 'session', contextRef: 'ctx:s' });
  assert.equal(sessionView.contentClass, 'C3');
  assert.deepEqual(sessionView.content, { gist: 'g', why: 'w' });
  assert.notEqual(
    sessionView.digest,
    recordToView({ ...session, why: 'w2' }, { store: 'session', contextRef: 'ctx:s' }).digest,
  );
});

test('invalid times and unsupported stores are rejected', () => {
  assert.throws(() => recordToView({ id: 'canon-bad', claim: 'x', event_time: '2026-10-24garbage' }, { store: 'canon', contentClass: 'C2' }), /记录时间/);
  assert.throws(() => recordToView({ id: 'canon-bad2', claim: 'x', event_time: '2026-10-20T10:00:00.123456Z' }, { store: 'canon', contentClass: 'C2' }), /记录时间/);
  assert.throws(() => recordToView({ id: 'canon-bad3', claim: 'x', event_time: '2026-02-30T12:00:00Z' }, { store: 'canon', contentClass: 'C2' }), /记录时间/);
  assert.throws(() => recordToView({ id: 'canon-bad4', claim: 'x', event_time: '2026-10-20T24:00:00Z' }, { store: 'canon', contentClass: 'C2' }), /记录时间/);
  const ok = recordToView({ id: 'canon-ok', claim: 'x', event_time: '2026-10-20T10:00:00.123Z' }, { store: 'canon', contentClass: 'C2' });
  assert.equal(ok.eventTime, '2026-10-20T10:00:00.123Z');
  assert.throws(() => recordToView({ id: 'pricing-x', claim: 'x' }, { store: 'pricing', contentClass: 'C2' }), /store/);
  assert.throws(() => recordToView({ id: 'canon-empty' }, { store: 'canon', contentClass: 'C2' }), /正文/);
});
