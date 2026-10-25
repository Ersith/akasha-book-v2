#!/usr/bin/env node
// Akasha 上下文包：稳定前缀 + 动态后缀，确定性哈希、来源元数据与预算。
// 借用 DeepInfer 的 prefix-cache / bounded-replay 原则，不依赖其运行时。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 'akasha-pack/v1';
const VOLATILE_LINE = /^\s*(?:\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|库脉搏|📊|·\s*近期|【自动续行】|当前时间)/m;
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const norm = (text) => String(text).replace(/\r\n?/g, '\n').trim();
const pathErr = (path, msg) => { throw new TypeError(`${path}: ${msg}`); };

function assertInt(value, path, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) pathErr(path, `必须是 >= ${min} 的整数`);
  return value;
}

export function estimateTokens(text) {
  // 只做可复现的启发式估算：CJK 约 1 字/token，ASCII 约 4 字符/token。
  // 不是 provider 计费口径，也不是硬上界。
  let cjk = 0;
  let ascii = 0;
  for (const ch of String(text)) {
    if (/[\u3400-\u9fff]/.test(ch)) cjk += 1;
    else ascii += 1;
  }
  return Math.ceil(cjk + ascii / 4);
}

export function findVolatile(text) {
  return norm(text).split('\n').filter((line) => VOLATILE_LINE.test(line)).slice(0, 5);
}

function cmpSection(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  // 固定码点比较，避免 localeCompare 在组合字符/重音上相等导致反转改 hash。
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function normalizeSections(input, kind) {
  if (input === undefined) return [];
  if (input === null) pathErr(kind, '必须是数组，不能是 null');
  if (!Array.isArray(input)) pathErr(kind, '必须是数组');
  const seen = new Set();
  const rows = input.map((raw, i) => {
    const p = `${kind}[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) pathErr(p, '必须是 {id, order, text, ...} 对象');
    if (typeof raw.id !== 'string' || !raw.id.trim()) pathErr(`${p}.id`, '必须是非空字符串');
    if (!Number.isInteger(raw.order)) pathErr(`${p}.order`, '必须是整数');
    if (typeof raw.text !== 'string') pathErr(`${p}.text`, '必须是字符串');
    if (raw.required != null && typeof raw.required !== 'boolean') pathErr(`${p}.required`, '必须是 boolean');
    if (raw.volatile != null && typeof raw.volatile !== 'boolean') pathErr(`${p}.volatile`, '必须是 boolean');
    if (seen.has(raw.id)) pathErr(`${p}.id`, `重复 id：${raw.id}`);
    seen.add(raw.id);
    const text = norm(raw.text);
    if (raw.required === true && !text) pathErr(`${p}.text`, 'required section 不能为空');
    return {
      id: raw.id,
      order: raw.order,
      text,
      required: raw.required === true,
      volatile: raw.volatile === true,
      source: raw.source && typeof raw.source === 'object' ? raw.source : null,
    };
  }).filter((s) => s.text);
  return rows.sort(cmpSection);
}

function joinSections(sections) {
  return sections.map((s) => `## ${s.id}\n${s.text}`).join('\n\n');
}

export function buildContextPack(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) pathErr('root', '必须是对象');
  const {
    stable = [],
    dynamic = [],
    maxTokens = 2400,
    maxStableTokens = null,
    allowVolatileStable = false,
    asOf = null,
    sourceRevisions = {},
  } = input;
  if (typeof allowVolatileStable !== 'boolean') pathErr('allowVolatileStable', '必须是 boolean');
  if (asOf != null && typeof asOf !== 'string') pathErr('asOf', '必须是字符串或 null');
  if (sourceRevisions == null || typeof sourceRevisions !== 'object' || Array.isArray(sourceRevisions)) pathErr('sourceRevisions', '必须是对象');
  const totalCap = assertInt(maxTokens, 'maxTokens', { min: 0 });
  const stableCap = maxStableTokens == null ? totalCap : Math.min(totalCap, assertInt(maxStableTokens, 'maxStableTokens', { min: 0 }));

  const stableSections = normalizeSections(stable, 'stable');
  const dynamicSections = normalizeSections(dynamic, 'dynamic');
  const stableText = joinSections(stableSections);
  const volatile = stableSections.filter((s) => s.volatile).map((s) => s.id);
  const regexVolatile = findVolatile(stableText);
  if ((volatile.length || regexVolatile.length) && !allowVolatileStable) {
    pathErr('stable', `含易变 section/行：${[...volatile, ...regexVolatile].slice(0, 3).join(', ')}`);
  }
  const stableTokens = estimateTokens(stableText);
  if (stableTokens > stableCap) pathErr('stable', `超预算：${stableTokens} > ${stableCap}`);

  const remaining = Math.max(0, totalCap - stableTokens);
  const picked = [];
  const omitted = [];
  let used = 0;
  for (const s of dynamicSections) {
    const t = estimateTokens(`## ${s.id}\n${s.text}`) + 2;
    if (used + t > remaining) {
      if (s.required) pathErr(`dynamic.${s.id}`, `必需段超预算：已用 ${used}, 需要 ${t}, 剩余 ${remaining - used}`);
      omitted.push({ id: s.id, reason: 'budget' });
      continue;
    }
    picked.push(s);
    used += t;
  }
  const dynamicText = joinSections(picked);
  const stableContentHash = sha(stableText);
  const dynamicContentHash = sha(dynamicText);
  const revisions = JSON.stringify(Object.keys(sourceRevisions).sort().map((k) => [k, sourceRevisions[k]]));
  const stableCacheKey = sha(`${SCHEMA_VERSION}|${stableContentHash}|${revisions}`);
  const dynamicCacheKey = sha(`${SCHEMA_VERSION}|${dynamicContentHash}|${revisions}`);
  const warnings = [];
  if (regexVolatile.length) warnings.push(`stable 含易变行 ${regexVolatile.length} 条`);
  if (volatile.length) warnings.push(`stable 含显式 volatile section：${volatile.join(',')}`);
  return {
    schemaVersion: SCHEMA_VERSION,
    asOf,
    sourceRevisions,
    stable: {
      text: stableText,
      hash: stableContentHash,
      contentHash: stableContentHash,
      cacheKey: stableCacheKey,
      tokens: stableTokens,
      tokenEstimate: 'heuristic',
      sections: stableSections.map((s) => s.id),
      sectionMeta: stableSections.map((s) => ({ id: s.id, order: s.order, source: s.source })),
    },
    dynamic: {
      text: dynamicText,
      hash: dynamicContentHash,
      contentHash: dynamicContentHash,
      cacheKey: dynamicCacheKey,
      tokens: estimateTokens(dynamicText),
      tokenEstimate: 'heuristic',
      sections: picked.map((s) => s.id),
      omitted,
    },
    totalTokens: stableTokens + estimateTokens(dynamicText),
    maxTokens: totalCap,
    maxStableTokens: stableCap,
    packHash: sha(`${SCHEMA_VERSION}|${stableCacheKey}|${dynamicCacheKey}`),
    warnings,
  };
}

export function renderPack(pack) {
  if (!pack || pack.schemaVersion !== SCHEMA_VERSION) throw new Error('不是 Akasha context pack');
  return [pack.stable.text, pack.dynamic.text].filter(Boolean).join('\n\n');
}

// 用法：node context-pack.mjs --file pack-input.json [--json]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--file');
  if (i < 0) { console.error('用法：node context-pack.mjs --file pack-input.json [--json]'); process.exit(2); }
  const input = JSON.parse(readFileSync(args[i + 1], 'utf8'));
  const pack = buildContextPack(input);
  if (args.includes('--json')) console.log(JSON.stringify(pack, null, 2));
  else console.log(renderPack(pack));
}
