// Dedicated, opt-in M3 disk accounting. No production paths or global lock helpers.
// Cooperating processes share one owned root. A stale lock or ambiguous receipt is
// retained, never stolen/replayed by age. This is not a filesystem transaction.
import fs from 'node:fs';
import { resolve, isAbsolute, dirname, join, normalize } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const SCHEMA = 'akasha-m3-resource-budget/v1';
const OWNER = `${process.pid}:${randomUUID()}`;
const LOGS = Object.freeze(['observations', 'attempts', 'terminals']);
const HARD = Object.freeze({ maxTotalBytes: 64 * 1024 * 1024, maxLogBytes: 32 * 1024 * 1024,
  maxLineBytes: 128 * 1024, maxLeaseBytes: 16 * 1024 * 1024, maxLeases: 4,
  maxOperations: 128, maxStateBytes: 64 * 1024, lockTimeoutMs: 1000 });
const BRANDS = new WeakSet();
const WAIT = new Int32Array(new SharedArrayBuffer(4));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const digest = (b) => createHash('sha256').update(b).digest('hex');
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const fail = (code, message, unknown = false) => Object.assign(new Error(message), { code, unknown });
const refusal = (reason) => ({ ok: false, status: 'refused', reason });
const errorCode = (e) => String(e?.code || 'M3_IO').slice(0, 80);
const ident = (s) => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const samePath = (a, b) => process.platform === 'win32' ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const boundedId = (s) => typeof s === 'string' && s.length > 0 && Buffer.byteLength(s) <= 128;

function limitsOf(input = {}) {
  if (!plain(input)) throw fail('M3_CONFIG', 'limits must be a plain object');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(HARD, key) || !('value' in Object.getOwnPropertyDescriptor(input, key))) throw fail('M3_CONFIG', `unknown or accessor limit: ${key}`);
  }
  const limits = { ...HARD, ...input };
  for (const [key, ceiling] of Object.entries(HARD)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > ceiling) throw fail('M3_CONFIG', `invalid limit: ${key}`);
  }
  if (limits.maxTotalBytes < 2 * limits.maxStateBytes + 4096) throw fail('M3_CONFIG', 'total budget cannot hold control reserve');
  return limits;
}
function secureStat(path, kind, missing = false) {
  let st;
  try { st = fs.lstatSync(path, { bigint: true }); } catch (e) { if (missing && e.code === 'ENOENT') return null; throw e; }
  if (st.isSymbolicLink() || (kind === 'dir' ? !st.isDirectory() : !st.isFile()) || !samePath(fs.realpathSync(path), resolve(path))) throw fail('M3_OWNERSHIP', `unsafe ${kind}: ${path}`, true);
  if (kind === 'file' && st.nlink !== 1n) throw fail('M3_OWNERSHIP', 'hard-linked managed file', true);
  return st;
}
function explicitRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw fail('M3_ARGUMENT', 'explicit absolute budget root required');
  root = resolve(root);
  let p = root;
  for (;;) { secureStat(p, 'dir'); const up = dirname(p); if (up === p) break; p = up; }
  return root;
}
function assertIdentity(path, kind, expected) {
  const st = secureStat(path, kind);
  if (ident(st) !== expected) throw fail('M3_OWNERSHIP', 'managed path identity changed', true);
  return st;
}
function writeAll(fd, buffer) {
  let written = 0;
  while (written < buffer.length) {
    const n = fs.writeSync(fd, buffer, written, buffer.length - written, null);
    if (!Number.isInteger(n) || n <= 0) throw fail('EIO', 'write made no progress', true);
    written += n;
  }
}
function ownedUnlink(path, expected) {
  const st = secureStat(path, 'file', true);
  if (st && ident(st) === expected) fs.unlinkSync(path);
  else if (st) throw fail('M3_OWNERSHIP', 'refusing to unlink replaced control file', true);
}
function withLock(root, rootIdentity, timeout, fn) {
  assertIdentity(root, 'dir', rootIdentity);
  const path = join(root, 'budget.lock');
  const token = randomUUID();
  const start = performance.now();
  let fd; let identity;
  for (;;) {
    try { fd = fs.openSync(path, 'wx', 0o600); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (performance.now() - start >= timeout) throw fail('M3_LOCK_BUSY', 'budget lock retained; no automatic stale recovery');
      Atomics.wait(WAIT, 0, 0, Math.min(10, timeout));
      assertIdentity(root, 'dir', rootIdentity);
    }
  }
  try {
    identity = ident(fs.fstatSync(fd, { bigint: true }));
    writeAll(fd, Buffer.from(JSON.stringify({ token, owner: OWNER, pid: process.pid })));
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } finally { if (identity) ownedUnlink(path, identity); }
    throw e;
  }
  fs.closeSync(fd);
  let result; let failure;
  try { assertIdentity(root, 'dir', rootIdentity); result = fn(); } catch (e) { failure = e; }
  try {
    assertIdentity(root, 'dir', rootIdentity);
    const st = assertIdentity(path, 'file', identity);
    if (st.size > 4096n || JSON.parse(fs.readFileSync(path, 'utf8')).token !== token) throw fail('M3_LOCK_RELEASE', 'lock ownership changed', true);
    fs.unlinkSync(path);
  } catch (e) {
    throw Object.assign(fail('M3_LOCK_RELEASE', 'budget outcome unknown: own lock could not be released', true), { cause: e, previousError: failure?.code });
  }
  if (failure) throw failure;
  return result;
}
function stateBytes(state) {
  const out = Buffer.from(JSON.stringify(state));
  if (out.length > state.limits.maxStateBytes) throw fail('M3_STATE_CAPACITY', 'bounded state capacity exceeded');
  return out;
}
function saveState(root, state) {
  const bytes = stateBytes(state);
  const stage = join(root, 'state.next');
  let fd; let identity;
  try {
    fd = fs.openSync(stage, 'wx', 0o600);
    identity = ident(fs.fstatSync(fd, { bigint: true }));
    writeAll(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    // Fixed stage bounds control disk use. Never replace or remove an old stage.
    fs.renameSync(stage, join(root, 'state.json'));
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (identity) { try { ownedUnlink(stage, identity); } catch {} }
    throw e;
  }
}
function validateState(s) {
  if (!plain(s) || s.schema !== SCHEMA || !Array.isArray(s.leases) || !Array.isArray(s.operations) || !integer(s.revision)) throw fail('M3_STATE', 'invalid budget state', true);
  const limits = limitsOf(s.limits);
  if (JSON.stringify(limits) !== JSON.stringify(s.limits) || digest(JSON.stringify(limits)) !== s.configHash) throw fail('M3_STATE', 'invalid persisted config', true);
  for (const key of ['rootIdentity', 'logsIdentity', 'capturesIdentity']) if (typeof s[key] !== 'string' || !/^\d+:\d+:\d+$/.test(s[key])) throw fail('M3_STATE', 'invalid directory identity', true);
  if (s.leases.length > limits.maxLeases || s.operations.length > limits.maxOperations) throw fail('M3_STATE', 'state counts exceed limits', true);
  const tokens = new Set(); const ids = new Set();
  for (const l of s.leases) {
    if (!plain(l) || !UUID.test(l.token) || tokens.has(l.token) || !boundedId(l.owner) || !integer(l.bytes) || !l.bytes || l.bytes > limits.maxLeaseBytes || typeof l.dirIdentity !== 'string' || !/^\d+:\d+:\d+$/.test(l.dirIdentity) || (l.id !== null && !boundedId(l.id))) throw fail('M3_STATE', 'invalid capture receipt', true);
    tokens.add(l.token);
  }
  for (const o of s.operations) {
    if (!plain(o) || !boundedId(o.id) || ids.has(o.id) || !LOGS.includes(o.log) || !HASH.test(o.payloadHash) || !HASH.test(o.lineHash) || !integer(o.before) || !integer(o.bytes) || !o.bytes || o.bytes > limits.maxLineBytes || o.before + o.bytes > limits.maxLogBytes || !['intent', 'committed'].includes(o.status) || typeof o.fileIdentity !== 'string' || !/^\d+:\d+:\d+$/.test(o.fileIdentity)) throw fail('M3_STATE', 'invalid log receipt', true);
    ids.add(o.id);
  }
  stateBytes(s);
  return s;
}
function loadState(root) {
  const path = join(root, 'state.json');
  const st = secureStat(path, 'file');
  if (st.size > BigInt(HARD.maxStateBytes)) throw fail('M3_STATE', 'state is oversized', true);
  let s;
  try { s = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { if (e instanceof SyntaxError) throw fail('M3_STATE', 'state cannot be parsed', true); throw e; }
  validateState(s);
  assertIdentity(root, 'dir', s.rootIdentity);
  assertIdentity(join(root, 'logs'), 'dir', s.logsIdentity);
  assertIdentity(join(root, 'captures'), 'dir', s.capturesIdentity);
  return s;
}
function boundedEntries(path, max = 64) {
  // opendir bounds even an externally polluted directory without a huge readdir array.
  const dir = fs.opendirSync(path); const entries = [];
  try { let item; while ((item = dir.readSync())) { if (entries.length >= max) throw fail('M3_OWNERSHIP', 'managed directory entry bound exceeded', true); entries.push(item.name); } }
  finally { dir.closeSync(); }
  return entries;
}
function emptyDirectory(path) {
  const dir = fs.opendirSync(path);
  try { return dir.readSync() === null; } finally { dir.closeSync(); }
}
function directoryBytes(path, depth = 0, counter = { count: 0 }) {
  let total = 0;
  for (const name of boundedEntries(path)) {
    if (++counter.count > 64) throw fail('M3_OWNERSHIP', 'capture entry bound exceeded', true);
    const p = join(path, name); const st = fs.lstatSync(p, { bigint: true });
    if (st.isDirectory()) {
      if (depth >= 1) throw fail('M3_OWNERSHIP', 'unexpected capture directory depth', true);
      secureStat(p, 'dir'); total += directoryBytes(p, depth + 1, counter);
    } else { secureStat(p, 'file'); total += Number(st.size); }
    if (!Number.isSafeInteger(total)) throw fail('M3_OWNERSHIP', 'capture byte count overflow', true);
  }
  return total;
}
function inspect(root, s) {
  for (const entry of boundedEntries(root, 8)) if (!['state.json', 'budget.lock', 'logs', 'captures'].includes(entry)) throw fail('M3_OWNERSHIP', 'unrecognized budget control entry', true);
  for (const entry of boundedEntries(join(root, 'logs'), 3)) if (!LOGS.some((log) => entry === `${log}.jsonl`)) throw fail('M3_OWNERSHIP', 'unrecognized managed log', true);
  const logs = {}; let logActualBytes = 0; let logChargedBytes = 0;
  for (const log of LOGS) {
    const st = secureStat(join(root, 'logs', `${log}.jsonl`), 'file', true);
    const bytes = Number(st?.size || 0n); let charged = bytes;
    for (const o of s.operations.filter((op) => op.log === log)) {
      if (!st || ident(st) !== o.fileIdentity || (o.status === 'committed' && bytes < o.before + o.bytes)) throw fail('M3_LOG_STATE', 'managed log missing, replaced, or truncated', true);
      charged = Math.max(charged, o.before + o.bytes);
    }
    logs[log] = { actualBytes: bytes, chargedBytes: charged };
    logActualBytes += bytes; logChargedBytes += charged;
  }
  const known = new Set(s.leases.map((l) => l.token));
  for (const entry of boundedEntries(join(root, 'captures'), HARD.maxLeases + 1)) if (!known.has(entry)) throw fail('M3_OWNERSHIP', 'unregistered capture retained; manual investigation required', true);
  let tempActualBytes = 0; let tempChargedBytes = 0;
  const leases = s.leases.map((l) => {
    const path = join(root, 'captures', l.token); let actualBytes = 0; let diagnostic = null;
    const st = secureStat(path, 'dir', true);
    if (!st) diagnostic = 'capture-missing-reservation-retained';
    else { if (ident(st) !== l.dirIdentity) throw fail('M3_OWNERSHIP', 'capture directory replaced', true); actualBytes = directoryBytes(path); }
    tempActualBytes += actualBytes; tempChargedBytes += Math.max(l.bytes, actualBytes);
    return { token: l.token, reservedBytes: l.bytes, actualBytes, ownerMatches: l.owner === OWNER, diagnostic };
  });
  const controlBytes = 2 * s.limits.maxStateBytes + 4096;
  return { usedBytes: controlBytes + logChargedBytes + tempChargedBytes, controlBytes, logActualBytes, logChargedBytes,
    tempActualBytes, tempChargedBytes, logs, leases, operationCount: s.operations.length,
    pendingOperations: s.operations.filter((o) => o.status === 'intent').map((o) => o.id) };
}
function canonical(value, maxBytes) {
  let size = 0; let nodes = 0; const chunks = []; const active = new Set();
  const push = (s) => { size += Buffer.byteLength(s); if (size > maxBytes) throw fail('M3_LINE', 'line too large'); chunks.push(s); };
  function visit(v, depth) {
    if (++nodes > 4096 || depth > 32) throw fail('M3_RECORD', 'record complexity limit');
    if (v === null || typeof v === 'boolean') { push(String(v)); return; }
    if (typeof v === 'number' && Number.isFinite(v)) { push(JSON.stringify(v)); return; }
    if (typeof v === 'string') { if (Buffer.byteLength(v) > maxBytes) throw fail('M3_LINE', 'line too large'); push(JSON.stringify(v)); return; }
    if (!(plain(v) || Array.isArray(v)) || active.has(v)) throw fail('M3_RECORD', 'plain finite JSON record required');
    active.add(v);
    if (Array.isArray(v) && v.length > 4096) throw fail('M3_RECORD', 'array length limit');
    const keys = [];
    for (const key in v) {
      if (!Object.hasOwn(v, key)) continue;
      if (keys.length >= 4096) throw fail('M3_RECORD', 'object key limit');
      if (Buffer.byteLength(key) > maxBytes) throw fail('M3_LINE', 'key too large');
      keys.push(key);
    }
    if (Object.getOwnPropertySymbols(v).length) throw fail('M3_RECORD', 'symbol keys are not JSON');
    if (Array.isArray(v)) {
      if (keys.length !== v.length) throw fail('M3_RECORD', 'dense JSON arrays required');
      push('['); for (let i = 0; i < v.length; i++) { if (i) push(','); const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d || !('value' in d)) throw fail('M3_RECORD', 'record accessors forbidden'); visit(d.value, depth + 1); } push(']');
    } else {
      push('{'); let first = true;
      for (const key of keys.sort()) { const d = Object.getOwnPropertyDescriptor(v, key); if (!('value' in d)) throw fail('M3_RECORD', 'record accessors forbidden'); if (!first) push(','); first = false; push(JSON.stringify(key)); push(':'); visit(d.value, depth + 1); }
      push('}');
    }
    active.delete(v);
  }
  if (!plain(value)) throw fail('M3_RECORD', 'record must be a plain object');
  visit(value, 0); return chunks.join('');
}
function resultFor(o, replayed = false) { return { ok: true, status: 'committed', operationId: o.id, log: o.log, payloadHash: o.payloadHash, bytes: o.bytes, replayed }; }
function unknownFor(o, e) { return { ok: false, status: 'unknown', reason: 'append-outcome-unknown', operationId: o.id, log: o.log, payloadHash: o.payloadHash, errorCode: errorCode(e) }; }
function reconcile(root, s, o) {
  let fd;
  try {
    const path = join(root, 'logs', `${o.log}.jsonl`);
    const st = assertIdentity(path, 'file', o.fileIdentity);
    if (Number(st.size) < o.before + o.bytes) return unknownFor(o, fail('M3_PARTIAL', 'complete receipt not present'));
    fd = fs.openSync(path, 'r+');
    if (ident(fs.fstatSync(fd, { bigint: true })) !== o.fileIdentity) throw fail('M3_OWNERSHIP', 'log changed during reconcile', true);
    const data = Buffer.alloc(o.bytes); let read = 0;
    while (read < data.length) { const n = fs.readSync(fd, data, read, data.length - read, o.before + read); if (!n) break; read += n; }
    if (read !== data.length || digest(data) !== o.lineHash) return unknownFor(o, fail('M3_PARTIAL', 'receipt bytes do not match'));
    // A prior fsync error remains unknown until a later fsync succeeds.
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if (o.status !== 'committed') { o.status = 'committed'; s.revision++; saveState(root, s); }
    return resultFor(o, true);
  } catch (e) { return unknownFor(o, e); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

export function isM3ResourceBudget(value) { return BRANDS.has(value); }

export function openBudget({ root, limits } = {}) {
  root = explicitRoot(root);
  const rootIdentity = ident(secureStat(root, 'dir'));
  const supplied = limits === undefined ? null : limitsOf(limits);
  let initial;
  withLock(root, rootIdentity, supplied?.lockTimeoutMs || HARD.lockTimeoutMs, () => {
    if (!secureStat(join(root, 'state.json'), 'file', true)) {
      if (boundedEntries(root, 8).some((entry) => entry !== 'budget.lock')) throw fail('M3_ROOT_NOT_OWNED', 'new budget root must be empty');
      const effective = supplied || limitsOf();
      fs.mkdirSync(join(root, 'logs')); fs.mkdirSync(join(root, 'captures'));
      initial = { schema: SCHEMA, rootIdentity, logsIdentity: ident(secureStat(join(root, 'logs'), 'dir')),
        capturesIdentity: ident(secureStat(join(root, 'captures'), 'dir')), limits: effective, configHash: digest(JSON.stringify(effective)), revision: 0, leases: [], operations: [] };
      saveState(root, initial);
    } else initial = loadState(root);
    if (supplied && JSON.stringify(supplied) !== JSON.stringify(initial.limits)) throw fail('M3_CONFIG', 'persisted limits differ from caller limits');
    inspect(root, initial);
  });
  const configHash = initial.configHash;
  const effective = Object.freeze({ ...initial.limits });
  const removedByThisManager = new Set();
  function transaction(fn) {
    return withLock(root, rootIdentity, effective.lockTimeoutMs, () => {
      const s = loadState(root);
      if (s.configHash !== configHash) throw fail('M3_CONFIG', 'budget config changed');
      return fn(s);
    });
  }
  function release(token, recover) {
    if (typeof token !== 'string' || !UUID.test(token)) return { ...refusal('invalid-token'), token };
    const result = transaction((s) => {
      const l = s.leases.find((entry) => entry.token === token);
      const path = join(root, 'captures', token);
      if (!l) {
        // Only our prior successful rmdir is evidence. A random missing token is
        // never a release receipt. Keep proof until the transaction unlocks too.
        if (!removedByThisManager.has(token)) return { ...refusal('unknown-token'), token };
        if (secureStat(path, 'dir', true)) return { ...refusal('capture-ownership'), token };
        return { ok: true, released: true, token };
      }
      if (!recover && l.owner !== OWNER) return { ...refusal('owner-mismatch'), token };
      if (!removedByThisManager.has(token) && removedByThisManager.size >= effective.maxOperations) return { ...refusal('release-proof-limit'), token };
      try {
        const st = secureStat(path, 'dir', true);
        if (!st) { if (!removedByThisManager.has(token)) return { ...refusal('capture-ownership'), token }; }
        else {
          if (ident(st) !== l.dirIdentity) return { ...refusal('capture-ownership'), token };
          if (!emptyDirectory(path)) return { ...refusal('capture-not-empty'), token };
          fs.rmdirSync(path); removedByThisManager.add(token);
        }
      } catch (e) { return { ...refusal('capture-ownership'), token, error: errorCode(e) }; }
      s.leases = s.leases.filter((entry) => entry.token !== token); s.revision++;
      saveState(root, s);
      return { ok: true, released: true, token };
    });
    if (result.ok) removedByThisManager.delete(token);
    return result;
  }
  const manager = Object.freeze({
    root, limits: effective,
    inspectBudget() { return transaction((s) => inspect(root, s)); },
    reserveCapture({ id = null, bytes } = {}) {
      if ((id !== null && !boundedId(id)) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > effective.maxLeaseBytes) return refusal('invalid-reservation');
      return transaction((s) => {
        const usage = inspect(root, s);
        if (id !== null && s.leases.some((l) => l.id === id)) return refusal('capture-id-conflict');
        if (s.leases.length >= effective.maxLeases) return refusal('lease-limit');
        if (usage.usedBytes + bytes > effective.maxTotalBytes) return refusal('total-budget-exceeded');
        const token = randomUUID(); const tempRoot = join(root, 'captures', token);
        fs.mkdirSync(tempRoot); const dirIdentity = ident(secureStat(tempRoot, 'dir'));
        s.leases.push({ token, id, owner: OWNER, bytes, dirIdentity }); s.revision++;
        try { saveState(root, s); }
        catch (e) { try { assertIdentity(tempRoot, 'dir', dirIdentity); if (emptyDirectory(tempRoot)) fs.rmdirSync(tempRoot); } catch {} throw e; }
        return { ok: true, token, tempRoot, reservedBytes: bytes };
      });
    },
    releaseCapture(token) { return release(token, false); },
    recoverEmptyCapture(token) { return release(token, true); },
    reconcileOperation(operationId) {
      if (!boundedId(operationId)) return refusal('invalid-operation-id');
      return transaction((s) => {
        const o = s.operations.find((entry) => entry.id === operationId);
        return o ? reconcile(root, s, o) : refusal('unknown-operation');
      });
    },
    appendManagedLog({ operationId, log, record } = {}) {
      if (!boundedId(operationId)) return refusal('invalid-operation-id');
      if (!LOGS.includes(log)) return refusal('unmanaged-log');
      let payload; let line; let payloadHash;
      try {
        payload = canonical(record, effective.maxLineBytes); payloadHash = digest(payload);
        line = Buffer.from(`{"operationId":${JSON.stringify(operationId)},"payloadHash":"${payloadHash}","record":${payload}}\n`);
        if (line.length > effective.maxLineBytes) return refusal('line-too-large');
      } catch (e) { return refusal(e.code === 'M3_LINE' ? 'line-too-large' : 'invalid-record'); }
      return transaction((s) => {
        const existing = s.operations.find((entry) => entry.id === operationId);
        if (existing) return existing.payloadHash !== payloadHash || existing.log !== log ? refusal('operation-conflict') : reconcile(root, s, existing);
        const usage = inspect(root, s);
        if (s.operations.some((o) => o.log === log && o.status === 'intent')) return refusal('log-has-unknown-operation');
        if (s.operations.length >= effective.maxOperations) return refusal('operation-limit');
        if (usage.usedBytes + line.length > effective.maxTotalBytes) return refusal('total-budget-exceeded');
        if (usage.logs[log].actualBytes + line.length > effective.maxLogBytes) return refusal('log-budget-exceeded');
        const path = join(root, 'logs', `${log}.jsonl`);
        let fd; let o; let hasIntent = false;
        try {
          const beforeStat = secureStat(path, 'file', true);
          fd = fs.openSync(path, beforeStat ? 'a+' : 'ax+', 0o600);
          const st = fs.fstatSync(fd, { bigint: true });
          if (beforeStat && ident(st) !== ident(beforeStat)) throw fail('M3_OWNERSHIP', 'log changed before append', true);
          const before = Number(st.size);
          if (before !== usage.logs[log].actualBytes) throw fail('M3_LOG_STATE', 'log changed outside budget lock', true);
          if (before) { const tail = Buffer.alloc(1); if (fs.readSync(fd, tail, 0, 1, before - 1) !== 1 || tail[0] !== 10) return refusal('incomplete-tail'); }
          o = { id: operationId, log, payloadHash, lineHash: digest(line), bytes: line.length, before, fileIdentity: ident(st), status: 'intent' };
          s.operations.push(o); s.revision++;
          o.status = 'committed'; s.revision++; stateBytes(s); s.revision--; o.status = 'intent';
          saveState(root, s); hasIntent = true;
          writeAll(fd, line); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
          o.status = 'committed'; s.revision++; saveState(root, s);
          return resultFor(o);
        } catch (e) {
          if (hasIntent) return unknownFor(o, e);
          if (e.code === 'M3_STATE_CAPACITY') return refusal('state-capacity');
          throw e;
        } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
      });
    },
  });
  BRANDS.add(manager); return manager;
}
