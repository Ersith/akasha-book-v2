// M3 · explicit canary stop switch. Fail closed on an unusable stop file.
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const TRUE = new Set(['1', 'true', 'stop', 'paused']);

/** Stop is read per process; a stop affects only new CLI invocations. */
export function resolveCanaryStop(env = process.env, { lstat = lstatSync } = {}) {
  const flag = env.AKASHA_M3_STOP;
  if (flag !== undefined && TRUE.has(String(flag).trim().toLowerCase())) {
    return { stopped: true, source: 'env', reason: 'AKASHA_M3_STOP' };
  }
  const file = env.AKASHA_M3_STOP_FILE;
  if (file !== undefined && String(file).trim() !== '') {
    const path = String(file);
    if (!isAbsolute(path)) return { stopped: true, source: 'file', reason: 'stop-file-must-be-absolute' };
    try {
      lstat(path);
      return { stopped: true, source: 'file', reason: 'stop-file-present' };
    } catch (error) {
      // Only confirmed nonexistence turns the switch off; every other metadata
      // error is fail-closed and never reads or opens the stop file.
      if (error?.code === 'ENOENT') return { stopped: false };
      return { stopped: true, source: 'file', reason: 'stop-file-error:' + String(error?.code || 'UNKNOWN') };
    }
  }
  return { stopped: false };
}
