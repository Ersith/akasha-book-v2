import test from 'node:test';
import assert from 'node:assert/strict';
import { gateMirrorSituations } from './mirror-gate.mjs';

test('situation gate recalls the fable for a matching situation', () => {
  const lying = gateMirrorSituations('我为了省事编造理由，消耗别人对我的信任');
  assert.ok(lying.some((hit) => hit.id === 'mirror-langlaile-r4'), JSON.stringify(lying.map((hit) => hit.id)));
  const complacent = gateMirrorSituations('我领先之后开始懈怠，觉得不会被追上');
  assert.ok(complacent.some((hit) => hit.id === 'mirror-guitu-r3'), JSON.stringify(complacent.map((hit) => hit.id)));
});

test('topic-only mention of mirror does not pass the situation gate', () => {
  assert.deepEqual(gateMirrorSituations('镜子应该是基线还是范式'), []);
  assert.deepEqual(gateMirrorSituations('狼来了'), []);
  assert.deepEqual(gateMirrorSituations('我今天已经完成画稿'), []);
  assert.deepEqual(gateMirrorSituations('我 已经 完成画稿'), []);
  assert.deepEqual(gateMirrorSituations('已经'), []);
  assert.equal(gateMirrorSituations('升级后插件整段消失，宿主无错误文件、无报错、零日志').some((hit) => hit.id === 'mirror-silent-deactivate-r3'), false);
});
