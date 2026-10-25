// One index per child process. The host owns FIFO, coalescing, and failure backoff.
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require_ = createRequire(import.meta.url);
let started = false;
process.on('disconnect', () => process.exit(0));
process.on('message', msg => {
  if (started || msg?.type !== 'index' || !msg.job?.session) return;
  started = true;
  const job = msg.job;
  const start = Date.now();
  let stats;
  try {
    stats = require_(join(job.akashaDir, 'session.mjs')).indexSession({
      file: job.file, session: job.session, storeFile: job.storeFile,
      metaFile: job.metaFile, full: !!job.full,
    });
  } catch (error) { stats = { error: String(error?.message ?? error).slice(0,300) }; }
  process.send({ ...stats, type: 'result', id: msg.id, session: job.session, trigger: job.trigger, ms: Date.now()-start }, () => process.disconnect());
});
process.send({ type: 'ready', pid: process.pid, node: process.version });
