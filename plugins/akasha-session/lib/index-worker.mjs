// index-worker.mjs —— 小阿卡夏 v0.4 索引 worker（worker_threads 入口）。
// 协议（宿主 → worker）：{type:'index', id, job:{akashaDir,session,file,storeFile,metaFile,trigger,full}}
//                        {type:'quit'} / {type:'ping'}
// 协议（worker → 宿主）：{type:'ready'} / {type:'pong'} / {type:'result', id, session, trigger, ms, ...stats|error}
// 语义：FIFO 串行；同 session 排队去重（保留最新一条）；quit 时 drain 当前 job 后关闭。
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);
let core = null;
let coreDir = '';
function coreOf(akashaDir) {
  if (!core || coreDir !== akashaDir) {
    core = require_(join(akashaDir, 'session.mjs'));
    coreDir = akashaDir;
  }
  return core;
}

const queue = [];
const queuedBySession = new Set();
let running = false;
let quitting = false;
let processed = 0;

function enqueue(job) {
  if (queuedBySession.has(job.session)) {
    // 同会话已在排队：保留最新一份（旧 job 丢弃；水位/去重保证不漏段）
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].session === job.session) { queue.splice(i, 1); break; }
    queuedBySession.delete(job.session);
  }
  queue.push(job);
  queuedBySession.add(job.session);
  parentPort.postMessage({ type: 'queued', id: job.id, session: job.session, depth: queue.length, running });
  if (!running) drain();
}

function drain() {
  running = true;
  const job = queue.shift();
  if (!job) {
    running = false;
    if (quitting) { parentPort.postMessage({ type: 'bye', processed }); parentPort.close(); }
    return;
  }
  queuedBySession.delete(job.session);
  const t0 = Date.now();
  try {
    const stats = coreOf(job.akashaDir).indexSession({
      file: job.file, session: job.session,
      storeFile: job.storeFile, metaFile: job.metaFile, full: !!job.full,
    });
    processed += 1;
    parentPort.postMessage({ type: 'result', id: job.id, session: job.session, trigger: job.trigger, ms: Date.now() - t0, depth: queue.length, ...stats });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id: job.id, session: job.session, trigger: job.trigger, ms: Date.now() - t0, depth: queue.length, error: String(error?.message ?? error).slice(0, 300) });
  }
  setImmediate(drain);
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'index' && msg.job?.session) enqueue({ ...msg.job, id: msg.id });
  else if (msg.type === 'ping') parentPort.postMessage({ type: 'pong', depth: queue.length, running });
  else if (msg.type === 'quit') {
    quitting = true;
    if (!running && queue.length === 0) { parentPort.postMessage({ type: 'bye', processed }); parentPort.close(); }
  }
});

parentPort.postMessage({ type: 'ready', pid: process.pid, node: process.version });
