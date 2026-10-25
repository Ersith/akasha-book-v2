// M3 · data-view fingerprint for paired/canary comparability (read-only).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Hash files as a view; missing/IO errors are explicit and invalid unless allowed. */
export function snapshotDataView(files, { allowMissing = [] } = {}) {
  if (!files || typeof files !== 'object') throw new TypeError('files 必须是对象');
  const allowed = new Set(allowMissing);
  const entries = [];
  const missing = [];
  const errors = [];
  for (const name of Object.keys(files).sort()) {
    const path = files[name];
    try {
      const bytes = readFileSync(path);
      entries.push({ name, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch (error) {
      const code = error?.code || 'UNKNOWN';
      if (code === 'ENOENT' && allowed.has(name)) missing.push({ name, path: String(path) });
      else errors.push({ name, path: String(path), code, message: String(error?.message || error) });
    }
  }
  const hash = createHash('sha256')
    .update(JSON.stringify(entries)).update('|')
    .update(JSON.stringify(missing)).update('|')
    .update(JSON.stringify(errors.map((e) => ({ name: e.name, code: e.code }))))
    .digest('hex');
  return { hash, files: entries, missing, errors, valid: errors.length === 0 };
}
