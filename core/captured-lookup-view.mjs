// A bounded private input capture, not a cross-file transaction or ABA guarantee.
// No default data paths, production writes, environment changes or traffic routing.
import { createHash } from 'node:crypto';
import { lstat, realpath, open, mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, isAbsolute, parse, relative, resolve, sep } from 'node:path';

const STORES = Object.freeze(['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier']);
const CEILINGS = Object.freeze({ maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024,
  maxLineBytes: 128 * 1024, maxRecords: 20000, maxConcurrent: 2, chunkBytes: 64 * 1024 });
const states = new WeakMap();
let leases = 0; // Includes sealed views until successful disposal; process-local only.

function fail(code, message, detail = {}) {
  return Object.assign(new Error(message), { code, ...detail });
}
const asError = (error, name) => ({ code: error.code || 'CAPTURE_IO', ...(name ? { name } : {}), message: String(error.message) });
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = (s) => `${s.dev}:${s.ino}:${s.birthtimeNs}`;
const signature = (s) => `${identity(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function absolute(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value)) {
    throw fail('CAPTURE_ARGUMENT', `${label} must be an explicit absolute path`);
  }
  return resolve(value);
}

function limitsOf(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('CAPTURE_ARGUMENT', 'limits must be an object');
  const out = { ...CEILINGS };
  for (const [name, value] of Object.entries(input)) {
    if (!Object.hasOwn(CEILINGS, name) || !Number.isSafeInteger(value) || value < 1 || value > CEILINGS[name]) {
      throw fail('CAPTURE_ARGUMENT', `invalid or above-ceiling limit: ${name}`);
    }
    out[name] = value;
  }
  return out;
}

// Check every existing component, including junction/alias resolution. An absent
// evidence path is allowed, but a linked existing ancestor is never followed.
async function inspect(path, { directory = false, allowMissing = false } = {}) {
  const base = parse(path).root;
  const parts = relative(base, path).split(sep).filter(Boolean);
  let current = base;
  let stat;
  for (let i = -1; i < parts.length; i += 1) {
    if (i >= 0) current = join(current, parts[i]);
    try { stat = await lstat(current, { bigint: true }); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !samePath(await realpath(current), resolve(current))) {
      throw fail('CAPTURE_PATH', 'linked or redirected path refused');
    }
    if (i < parts.length - 1 && !stat.isDirectory()) throw fail('CAPTURE_PATH', 'path ancestor is not a directory');
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw fail('CAPTURE_SOURCE_TYPE', directory ? 'expected a directory' : 'expected a regular file');
  return stat;
}

async function ownedDirectory(state) {
  const parent = await inspect(state.root, { directory: true });
  if (identity(parent) !== state.rootIdentity) throw fail('CAPTURE_OWNERSHIP', 'capture parent was replaced');
  const own = await inspect(state.dir, { directory: true });
  if (identity(own) !== state.dirIdentity) throw fail('CAPTURE_OWNERSHIP', 'capture directory was replaced');
}

function jsonlValidator(name, limits, totals) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let pending = [];
  let pendingBytes = 0;
  let records = 0;
  let line = 0;
  function piece(bytes) {
    pendingBytes += bytes.length;
    if (pendingBytes > limits.maxLineBytes) throw fail('CAPTURE_LIMIT', `${name}: line byte limit exceeded`);
    if (bytes.length) pending.push(bytes);
  }
  function finishLine() {
    line += 1;
    let text;
    try { text = decoder.decode(Buffer.concat(pending, pendingBytes)); }
    catch { throw fail('CAPTURE_UTF8', `${name}: invalid UTF8 at line ${line}`); }
    pending = []; pendingBytes = 0;
    if (!text.trim()) return;
    let record;
    try { record = JSON.parse(text); }
    catch { throw fail('CAPTURE_JSONL', `${name}: incomplete or invalid JSON at line ${line}`); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw fail('CAPTURE_RECORD', `${name}: line ${line} must be a JSON object`);
    records += 1; totals.records += 1;
    if (totals.records > limits.maxRecords) throw fail('CAPTURE_LIMIT', 'aggregate record limit exceeded');
  }
  return {
    add(bytes) {
      let start = 0;
      for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
        piece(bytes.subarray(start, end)); finishLine(); start = end + 1;
      }
      // Own this slice: the caller reuses its read buffer on the next read.
      if (start < bytes.length) piece(Buffer.from(bytes.subarray(start)));
    },
    finish() { if (pendingBytes) finishLine(); return records; },
  };
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (!bytesWritten) throw fail('CAPTURE_IO', 'zero-byte write');
    offset += bytesWritten;
  }
}

async function scan(handle, name, limits, totals, output = null) {
  const hash = createHash('sha256');
  const validator = jsonlValidator(name, limits, totals);
  const buffer = Buffer.alloc(limits.chunkBytes);
  let bytes = 0;
  while (true) {
    const read = await handle.read(buffer, 0, buffer.length, null);
    if (!read.bytesRead) break;
    const chunk = buffer.subarray(0, read.bytesRead);
    bytes += chunk.length; totals.bytes += chunk.length;
    if (bytes > limits.maxFileBytes || totals.bytes > limits.maxTotalBytes) throw fail('CAPTURE_LIMIT', `${name}: byte limit exceeded`);
    validator.add(chunk);
    hash.update(chunk);
    if (output) await writeAll(output, chunk);
  }
  return { bytes, sha256: hash.digest('hex'), records: validator.finish() };
}

async function checkSource(source) {
  const now = await inspect(source.path, { allowMissing: source.missing });
  if (source.missing ? now !== null : !now || signature(now) !== source.signature) {
    throw fail('CAPTURE_SOURCE_CHANGED', `${source.name}: source changed during capture`);
  }
}

function release(state) {
  if (!state.released) { leases -= 1; state.released = true; }
  state.disposed = true;
}

async function disposeState(state) {
  if (state.disposed) return { ok: true, errors: [], disposed: true };
  if (!state.dir) { release(state); return { ok: true, errors: [], disposed: true }; }
  try {
    await ownedDirectory(state);
    const allowed = new Set([...state.owned.values()].map((entry) => entry.name + '.jsonl'));
    const names = await readdir(state.dir);
    if (names.some((name) => !allowed.has(name))) throw fail('CAPTURE_OWNERSHIP', 'unowned directory entries prevent cleanup');
    // Preflight every file before removing anything. Never recurse into entries.
    for (const entry of state.owned.values()) {
      const stat = await inspect(entry.path, { allowMissing: true });
      if (stat && identity(stat) !== entry.identity) throw fail('CAPTURE_OWNERSHIP', `${entry.name}: copy was replaced`);
    }
    for (const entry of state.owned.values()) {
      await ownedDirectory(state);
      const stat = await inspect(entry.path, { allowMissing: true });
      if (!stat) continue;
      if (identity(stat) !== entry.identity) throw fail('CAPTURE_OWNERSHIP', `${entry.name}: copy was replaced`);
      await unlink(entry.path);
    }
    await ownedDirectory(state);
    await rmdir(state.dir);
    release(state);
    return { ok: true, errors: [], disposed: true };
  } catch (error) {
    // Unknown ownership is not permission to remove or release a retained view.
    return { ok: false, errors: [asError(error)], disposed: false };
  }
}

async function verifyState(state) {
  if (state.disposed) return { ok: false, errors: [{ code: 'CAPTURE_DISPOSED', message: 'view has been disposed' }] };
  try {
    await ownedDirectory(state);
    const names = await readdir(state.dir);
    if (names.length !== state.owned.size || names.some((name) => ![...state.owned.keys()].includes(name.slice(0, -6)) || !name.endsWith('.jsonl'))) {
      throw fail('CAPTURE_CONTENTS', 'capture directory entries changed');
    }
    const totals = { bytes: 0, records: 0 };
    for (const entry of state.owned.values()) {
      const before = await inspect(entry.path);
      if (identity(before) !== entry.identity) throw fail('CAPTURE_OWNERSHIP', `${entry.name}: copy was replaced`);
      const handle = await open(entry.path, 'r');
      try {
        const start = await handle.stat({ bigint: true });
        if (signature(start) !== signature(before)) throw fail('CAPTURE_OWNERSHIP', `${entry.name}: copy changed before opening`);
        const actual = await scan(handle, entry.name, state.limits, totals);
        const end = await handle.stat({ bigint: true });
        const pathEnd = await inspect(entry.path);
        if (signature(start) !== signature(end) || signature(end) !== signature(pathEnd)) throw fail('CAPTURE_DIGEST', `${entry.name}: copy changed during verification`);
        if (actual.bytes !== entry.metadata.bytes || actual.sha256 !== entry.metadata.sha256 || actual.records !== entry.metadata.records) {
          throw fail('CAPTURE_DIGEST', `${entry.name}: copied bytes or record count changed`);
        }
      } finally { await handle.close(); }
    }
    await ownedDirectory(state);
    return { ok: true, errors: [] };
  } catch (error) { return { ok: false, errors: [asError(error)] }; }
}

function serial(state, fn) {
  const run = state.queue.then(fn);
  state.queue = run.catch(() => {});
  return run;
}

/** True only for a live view issued by this module; not a consumption reservation. */
export function isCapturedLookupView(view) {
  const state = states.get(view);
  return !!state && !state.disposed;
}

function assertNotInUse(state) {
  if (state.inUse) throw fail('CAPTURE_IN_USE', 'captured view is being consumed');
}

function integrityFailure(status, failed = false, cause) {
  return fail('CAPTURED_VIEW_INTEGRITY', 'captured view integrity failed', {
    details: status.errors, ...(failed ? { cause } : {}),
  });
}

/**
 * Reserve synchronously, then verify -> await consumer -> verify under one lease.
 * Same-view consume/verify/dispose calls reject rather than queue behind the
 * callback itself. Previously queued operations finish first. This coordinates
 * this module's lifecycle only, not external writers or filesystem ABA changes.
 */
export async function withCapturedLookupView(view, consumer) {
  const state = states.get(view);
  if (!state || state.disposed) throw new TypeError('captured view: owned, live view required');
  if (typeof consumer !== 'function') throw new TypeError('captured view: consumer function required');
  assertNotInUse(state);
  state.inUse = true;
  try {
    return await serial(state, async () => {
      const before = await verifyState(state);
      if (!before.ok) throw integrityFailure(before);
      let result, cause, failed = false;
      try { result = await consumer(view); }
      catch (error) { failed = true; cause = error; }
      const after = await verifyState(state);
      if (!after.ok) throw integrityFailure(after, failed, cause);
      if (failed) throw cause;
      return result;
    });
  } finally { state.inUse = false; }
}

/**
 * All paths are explicit. Limits only reduce the process ceilings; maxRecords is
 * aggregate across six stores and evidence. Valid final JSON without LF is allowed.
 * Sources are checked before/after capture; this is not an atomic source snapshot.
 * Cleanup uses identity checks + nonrecursive deletion, not an adversarial ABA lock.
 */
export async function captureLookupView({ files, evidenceFile, tempRoot, limits } = {}) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw fail('CAPTURE_ARGUMENT', 'files must explicitly name all six stores');
  const sources = STORES.map((name) => ({ name, path: absolute(files[name], name), optional: false }));
  sources.push({ name: 'evidence', path: absolute(evidenceFile, 'evidenceFile'), optional: true });
  const root = absolute(tempRoot, 'tempRoot');
  const bound = limitsOf(limits);
  if (leases >= bound.maxConcurrent) throw fail('CAPTURE_BUSY', 'process-local active-view limit reached');
  leases += 1;
  const state = { root, dir: null, owned: new Map(), limits: bound, released: false, disposed: false, inUse: false, queue: Promise.resolve() };
  try {
    state.rootIdentity = identity(await inspect(root, { directory: true }));
    // Capture all initial source identities before copying the first file.
    for (const source of sources) {
      const stat = await inspect(source.path, { allowMissing: source.optional });
      source.missing = stat === null;
      source.signature = stat ? signature(stat) : null;
      if (stat && stat.size > BigInt(bound.maxFileBytes)) throw fail('CAPTURE_LIMIT', `${source.name}: byte limit exceeded`);
    }
    state.dir = await mkdtemp(join(root, 'akasha-view-'));
    state.dirIdentity = identity(await inspect(state.dir, { directory: true }));
    await ownedDirectory(state);
    const totals = { bytes: 0, records: 0 };
    const manifestFiles = [];
    for (const source of sources) {
      await ownedDirectory(state);
      await checkSource(source);
      const path = join(state.dir, source.name + '.jsonl');
      const output = await open(path, 'wx', 0o600);
      let metadata;
      try {
        const entry = { name: source.name, path, identity: identity(await output.stat({ bigint: true })) };
        state.owned.set(source.name, entry);
        if (source.missing) metadata = { bytes: 0, sha256: sha(Buffer.alloc(0)), records: 0 };
        else {
          const input = await open(source.path, 'r');
          try {
            if (signature(await input.stat({ bigint: true })) !== source.signature) throw fail('CAPTURE_SOURCE_CHANGED', `${source.name}: source changed before reading`);
            metadata = await scan(input, source.name, bound, totals, output);
            if (signature(await input.stat({ bigint: true })) !== source.signature) throw fail('CAPTURE_SOURCE_CHANGED', `${source.name}: source changed while reading`);
          } finally { await input.close(); }
        }
        entry.metadata = metadata;
        await output.sync();
      } finally { await output.close(); }
      await checkSource(source);
      manifestFiles.push({ name: source.name, ...metadata, sourceMissing: source.missing });
    }
    for (const source of sources) await checkSource(source);
    const body = { schemaVersion: 'akasha-captured-lookup-view/v1', scope: 'captured-inputs', atomicSourceSnapshot: false,
      files: manifestFiles, totalBytes: totals.bytes, totalRecords: totals.records };
    const manifest = freeze({ ...body, hash: sha(JSON.stringify(body)) });
    const view = Object.freeze({
      files: Object.freeze(Object.fromEntries(STORES.map((name) => [name, state.owned.get(name).path]))),
      evidenceFile: state.owned.get('evidence').path,
      manifest,
      // Direct operations remain serialized outside a consumer lease; inside it
      // they reject immediately, including when called by the consumer itself.
      verify: async () => { assertNotInUse(state); return serial(state, () => verifyState(state)); },
      dispose: async () => { assertNotInUse(state); return serial(state, () => disposeState(state)); },
    });
    const checked = await verifyState(state);
    if (!checked.ok) throw fail('CAPTURE_VERIFY', 'captured copy verification failed', { errors: checked.errors });
    states.set(view, state);
    return view;
  } catch (error) {
    const cleanup = await disposeState(state);
    error.cleanup = cleanup;
    if (!cleanup.ok) error.dispose = () => serial(state, () => disposeState(state));
    throw error;
  }
}
