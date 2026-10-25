// 自我投影 loader/cache（P2）：源快照在同 canon 写锁内冻结；缓存可丢弃、可重建。
import { readFileSync, statSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withFileLock, parseJsonl } from './lib.mjs';
import { buildSelfProjection } from './self-projection.mjs';
import { buildMixedSelfProjection } from './self-mixed-canon.mjs';
import { validateProjectionBudget, projectionBudgetIdentityParts } from './cache-budget-validation.mjs';

export const SOURCE_SCHEMA = 'self-source/v1';
export const CACHE_SCHEMA = 'self-cache/v1';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function stampOf(stat) {
  // 优先 mtime/ctime/size；inode 只作末位兜底，不能单独代表内容新旧。
  return [stat.mtimeMs, stat.ctimeMs, stat.size, stat.ino];
}

function stampNewer(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] > right[i]) return true;
    if (left[i] < right[i]) return false;
  }
  return false;
}

function sameFile(left, right) {
  try {
    if (resolve(left) === resolve(right)) return true;
    if (existsSync(left) && existsSync(right)) {
      const a = statSync(left); const b = statSync(right);
      return a.dev === b.dev && a.ino === b.ino;
    }
    return realpathSync(left) === realpathSync(right);
  } catch { return false; }
}

function currentGeneration(canonFile) {
  try { return `sha256:${sha(readFileSync(canonFile))}`; } catch { return null; }
}

function projectionIdentity(projection, source) {
  return sha(JSON.stringify([
    projection.schemaVersion, projection.policyVersion, projection.subjectId,
    projection.stableHash, projection.cardHash, projection.status,
    source.generation, source.sourceStamp,
    ...projectionBudgetIdentityParts(projection),
  ]));
}

/**
 * 在 canon 写锁内抓完整字节、generation 和解析结果；调用方拿到的是冻结副本。
 * 解析/编码错误不会被吞：errors 同时进入 sourceErrors，projection 会 failed。
 */
export function readSelfSource({ canonFile, subjectId = 'default', captureTime = new Date().toISOString() } = {}) {
  if (typeof canonFile !== 'string' || !canonFile) throw new TypeError('canonFile 必填');
  if (typeof subjectId !== 'string' || !subjectId) throw new TypeError('subjectId 必填');
  if (!existsSync(canonFile)) {
    return deepFreeze({
      schemaVersion: SOURCE_SCHEMA, canonFile, subjectId, captureTime,
      generation: null, sourceStamp: null, bytes: 0, records: [],
      errors: [{ line: 0, error: `canon 文件不存在：${canonFile}` }],
    });
  }
  // 与 appendRecord / revise / retire 使用同一个锁文件（canon 文件自身 .lock）。
  return withFileLock(canonFile, () => {
    const before = statSync(canonFile);
    const bytes = readFileSync(canonFile);
    const after = statSync(canonFile);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('canon 在读取期间变化（锁内仍不一致），拒绝冻结');
    }
    const generation = `sha256:${sha(bytes)}`;
    const sourceStamp = stampOf(after);
    let text;
    try {
      text = UTF8.decode(bytes);
    } catch {
      return deepFreeze({
        schemaVersion: SOURCE_SCHEMA, canonFile, subjectId, captureTime,
        generation, sourceStamp, ino: after.ino, bytes: after.size,
        records: [], errors: [{ line: 0, error: 'canon 不是合法 UTF-8' }],
      });
    }
    const parsed = parseJsonl(text);
    return deepFreeze({
      schemaVersion: SOURCE_SCHEMA,
      canonFile,
      subjectId,
      captureTime,
      generation,
      sourceStamp,
      ino: after.ino,
      bytes: after.size,
      records: parsed.records,
      errors: parsed.errors,
    });
  }, { timeoutMs: 10000 });
}

export function projectSelf({ canonFile, subjectId = 'default', inputMode = 'self', ...options } = {}) {
  if (!['self', 'mixed-canon'].includes(inputMode)) throw new TypeError("inputMode 必须是 'self' 或 'mixed-canon'");
  if (options.sourceErrors !== undefined && !Array.isArray(options.sourceErrors)) {
    throw new TypeError('sourceErrors 必须是数组');
  }
  const readAt = options.readAt ?? new Date().toISOString();
  const source = readSelfSource({ canonFile, subjectId, captureTime: readAt });
  const inherited = options.sourceErrors ?? [];
  const parsedErrors = source.errors.map((e) => `canon 第 ${e.line} 行：${e.error}`);
  const build = inputMode === 'mixed-canon' ? buildMixedSelfProjection : buildSelfProjection;
  const projection = build(source.records, {
    ...options,
    subjectId,
    sourceErrors: [...inherited, ...parsedErrors],
  });
  return { source, projection };
}

export function cachePathFor(canonFile) {
  if (typeof canonFile !== 'string' || !canonFile) throw new TypeError('canonFile 必填');
  if (!/\.jsonl$/i.test(canonFile)) throw new TypeError('cachePathFor 只支持 .jsonl 源');
  const cacheFile = canonFile.replace(/\.jsonl$/i, '.self-cache.json');
  if (cacheFile === canonFile) throw new TypeError('cache 路径不能与源相同');
  return cacheFile;
}

function readCacheRaw(cacheFile) {
  if (!existsSync(cacheFile)) return { status: 'missing' };
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'corrupt', reason: 'shape' };
    if (parsed.schemaVersion !== CACHE_SCHEMA) return { status: 'corrupt', reason: 'schema' };
    if (!Number.isInteger(parsed.cacheVersion) || parsed.cacheVersion < 1) return { status: 'corrupt', reason: 'cacheVersion' };
    if (typeof parsed.generation !== 'string' || !parsed.generation) return { status: 'corrupt', reason: 'generation' };
    if (typeof parsed.subjectId !== 'string' || !parsed.subjectId) return { status: 'corrupt', reason: 'subjectId' };
    if (typeof parsed.policyVersion !== 'string' || !parsed.policyVersion) return { status: 'corrupt', reason: 'policyVersion' };
    if (typeof parsed.projectionIdentity !== 'string' || !parsed.projectionIdentity) return { status: 'corrupt', reason: 'projectionIdentity' };
    return { status: 'ok', value: parsed };
  } catch (error) {
    return { status: 'corrupt', reason: error.message };
  }
}

function projectionShapeError(projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return 'projection';
  if (!Array.isArray(projection.selectedStableIds) || !Array.isArray(projection.selectedCardIds)) return 'projection.selectedIds';
  for (const field of ['schemaVersion', 'subjectId', 'policyVersion', 'stableText', 'stableHash', 'cardText', 'cardHash', 'status']) {
    if (typeof projection[field] !== 'string') return `projection.${field}`;
  }
  if (!Array.isArray(projection.entries) || !Array.isArray(projection.sourceRootIds)) return 'projection.collections';
  for (const entry of projection.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'projection.entries.member';
    if (typeof entry.id !== 'string' || !entry.id) return 'projection.entries.id';
    if (typeof entry.kind !== 'string' || typeof entry.semanticKey !== 'string' || typeof entry.claim !== 'string') return 'projection.entries.fields';
  }
  if (!projection.selectedStableIds.every((id) => typeof id === 'string') || !projection.selectedCardIds.every((id) => typeof id === 'string')) return 'projection.selectedIds.fields';
  if (!projection.sourceRevisions || typeof projection.sourceRevisions !== 'object' || Array.isArray(projection.sourceRevisions)) return 'projection.sourceRevisions';
  if (!projection.views || typeof projection.views !== 'object' || Array.isArray(projection.views)) return 'projection.views';
  if (!['selfText', 'selfLine', 'addressText'].every((field) => typeof projection.views[field] === 'string')) return 'projection.views.fields';
  const byId = new Map(projection.entries.map((entry) => [entry.id, entry]));
  const selected = projection.selectedStableIds.map((id) => byId.get(id)).filter(Boolean);
  if (selected.length !== projection.selectedStableIds.length) return 'projection.selectedIds';
  const lineOf = (entry) => `${entry.kind === 'identity' ? '身份' : entry.kind === 'address' ? '称呼' : entry.kind === 'boundary' ? '边界' : entry.kind === 'principle' ? '原则' : '承诺'}：${entry.claim}`;
  const expectedAddress = selected.filter((entry) => entry.kind === 'address').map((entry) => entry.claim).join(String.fromCharCode(10));
  const expectedSelf = selected.filter((entry) => entry.kind !== 'address').map((entry) => lineOf(entry)).join(String.fromCharCode(10));
  const expectedLine = selected.filter((entry) => entry.kind === 'identity' || entry.kind === 'address').map((entry) => entry.claim).join('；');
  if (projection.views.addressText !== expectedAddress) return 'projection.views.addressText';
  if (projection.views.selfText !== expectedSelf) return 'projection.views.selfText';
  if (projection.views.selfLine !== expectedLine) return 'projection.views.selfLine';
  return validateProjectionBudget(projection);
}

function currentSourceInfo(canonFile) {
  try {
    const bytes = readFileSync(canonFile);
    const stat = statSync(canonFile);
    return { generation: `sha256:${sha(bytes)}`, stamp: stampOf(stat) };
  } catch { return null; }
}

function cacheValueValid(value, source) {
  if (projectionShapeError(value.projection)) return false;
  const projection = value.projection;
  if (projection.subjectId !== value.subjectId || projection.policyVersion !== value.policyVersion) return false;
  if (projection.schemaVersion !== value.projection.schemaVersion) return false;
  const expectedIdentity = projectionIdentity(projection, { generation: value.generation, sourceStamp: value.sourceStamp });
  if (value.projectionIdentity !== expectedIdentity) return false;
  if (projection.stableHash !== sha(`${projection.schemaVersion}|${projection.policyVersion}|${projection.stableText}`)) return false;
  if (projection.cardHash !== sha(`${projection.schemaVersion}|${projection.policyVersion}|${projection.cardText}`)) return false;
  if (value.stableHash !== projection.stableHash || value.cardHash !== projection.cardHash) return false;
  return true;
}

/**
 * 原子写缓存。缓存不是权威：旧 generation / 旧源时间戳不得覆盖新值。
 * 返回值：written | skipped-newer | skipped-same。
 */
export function writeProjectionCache({ cacheFile, source, projection, capturedAt = Date.now() } = {}) {
  const explicitCapturedAt = arguments[0]?.capturedAt !== undefined;
  if (!cacheFile || !source || !projection) throw new TypeError('cacheFile/source/projection 必填');
  if (sameFile(cacheFile, source.canonFile)) throw new TypeError('cacheFile 不能是 canon 源本身');
  mkdirSync(dirname(cacheFile), { recursive: true });
  return withFileLock(cacheFile, () => {
    // 锁内重新核验当前源：等待 cache.lock 期间源可能已更换。
    const current = currentSourceInfo(source.canonFile);
    const isCurrent = !!(current && current.generation === source.generation);
    if (!isCurrent && current && stampNewer(source.sourceStamp, current.stamp)) {
      return { status: 'skipped-stale-source' };
    }
    const existing = readCacheRaw(cacheFile);
    const identity = projectionIdentity(projection, source);
    if (existing.status === 'ok' && cacheValueValid(existing.value, source)) {
      const old = existing.value;
      if (!isCurrent && source.sourceStamp && old.sourceStamp && stampNewer(old.sourceStamp, source.sourceStamp)) {
        return { status: 'skipped-newer' };
      }
      if (old.projectionIdentity === identity) return { status: 'skipped-same' };
      if (!source.sourceStamp && Number(old.capturedAt) > Number(capturedAt)) return { status: 'skipped-newer' };
    }
    const payload = {
      schemaVersion: CACHE_SCHEMA,
      cacheVersion: 1,
      capturedAt: Number(capturedAt),
      canonFile: source.canonFile,
      generation: source.generation,
      sourceStamp: source.sourceStamp,
      sourceBytes: source.bytes,
      subjectId: projection.subjectId,
      policyVersion: projection.policyVersion,
      stableHash: projection.stableHash,
      cardHash: projection.cardHash,
      projectionIdentity: identity,
      projection,
    };
    const tmp = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, cacheFile);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw error;
    }
    return { status: 'written' };
  }, { timeoutMs: 10000 });
}

export function readProjectionCache({ cacheFile, generation, subjectId, policyVersion } = {}) {
  if (!cacheFile || !generation || !subjectId || !policyVersion) throw new TypeError('cacheFile/generation/subjectId/policyVersion 必填');
  const raw = readCacheRaw(cacheFile);
  if (raw.status !== 'ok') return raw;
  const value = raw.value;
  if (value.generation !== generation) return { status: 'stale', reason: 'generation' };
  if (value.subjectId !== subjectId) return { status: 'stale', reason: 'subject' };
  if (value.policyVersion !== policyVersion) return { status: 'stale', reason: 'policy' };
  const shapeError = projectionShapeError(value.projection);
  if (shapeError) return { status: 'corrupt', reason: shapeError };
  const projection = value.projection;
  if (projectionBudgetIdentityParts(projection).length && value.projectionIdentity !== projectionIdentity(projection, { generation: value.generation, sourceStamp: value.sourceStamp })) {
    return { status: 'corrupt', reason: 'identity' };
  }
  if (projection.subjectId !== value.subjectId || projection.policyVersion !== value.policyVersion
      || projection.schemaVersion !== value.projection.schemaVersion) {
    return { status: 'corrupt', reason: 'identity' };
  }
  if (projection.stableHash !== sha(`${projection.schemaVersion}|${projection.policyVersion}|${projection.stableText}`)
      || projection.cardHash !== sha(`${projection.schemaVersion}|${projection.policyVersion}|${projection.cardText}`)) {
    return { status: 'corrupt', reason: 'hash' };
  }
  if (value.stableHash !== projection.stableHash || value.cardHash !== projection.cardHash) {
    return { status: 'corrupt', reason: 'cache-hash' };
  }
  return { status: 'fresh', projection: deepFreeze(projection), cache: value };
}

export function clearProjectionCache(cacheFile) {
  if (existsSync(cacheFile)) unlinkSync(cacheFile);
}
