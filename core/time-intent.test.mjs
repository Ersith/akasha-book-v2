import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTimeIntent, resolveTimeIntent } from './time-intent.mjs';

test('recency cues and conceptual queries are separated', () => {
  assert.equal(classifyTimeIntent('最近重启了吗').kind, 'recent');
  assert.equal(classifyTimeIntent('当前状态').kind, 'recent');
  assert.equal(classifyTimeIntent('最新审计').kind, 'recent');
  assert.equal(classifyTimeIntent('今天有什么进展').kind, 'recent');
  assert.equal(classifyTimeIntent('修好了吗').kind, 'recent');
  assert.equal(classifyTimeIntent('进展到哪了').kind, 'recent');
});

test('technical substrings do not become recency intent', () => {
  assert.equal(classifyTimeIntent('最近邻算法是什么').kind, 'none');
  assert.equal(classifyTimeIntent('软件应该安装到哪里').kind, 'none');
  assert.equal(classifyTimeIntent('截止频率是什么意思').kind, 'none');
  assert.equal(classifyTimeIntent('现在完成时怎么用').kind, 'none');
  assert.equal(classifyTimeIntent('剩余空间是多少').kind, 'none');
  assert.equal(classifyTimeIntent('当前实现是什么').kind, 'none');
  assert.equal(classifyTimeIntent('“最近”这个词是什么意思').kind, 'none');
  assert.equal(classifyTimeIntent('不要按最新程度排序，查找全部安装记录').kind, 'none');
  assert.equal(classifyTimeIntent('十个球拿走三个还剩几个').kind, 'none');
  assert.equal(classifyTimeIntent('记忆补丁').kind, 'none');
  assert.equal(classifyTimeIntent('经验索引').kind, 'none');
});

test('explicit intent overrides classifier', () => {
  assert.deepEqual(resolveTimeIntent('记忆补丁', 'recent'), { kind: 'recent', source: 'explicit', matched: [] });
  assert.deepEqual(resolveTimeIntent('最近', 'none'), { kind: 'none', source: 'explicit', matched: [] });
  assert.throws(() => resolveTimeIntent('x', 'bad'), /intent/);
});
