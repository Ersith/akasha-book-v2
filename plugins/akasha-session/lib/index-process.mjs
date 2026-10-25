// Each index owns an OS process: fatal V8 allocation failures cannot abort the host.
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class IndexProcess extends EventEmitter {
  constructor(entry, { timeoutMs = 120000 } = {}) {
    super();
    this.entry = entry;
    this.timeoutMs = timeoutMs;
    this.queue = [];
    this.active = null;
    this.quitting = false;
    this.closed = false;
    this.processed = 0;
  }

  postMessage(msg) {
    if (msg?.type === 'quit') { this.quitting = true; this.drain(); return; }
    if (msg?.type !== 'index' || !msg.job?.session) return;
    if (this.closed || this.quitting) throw new Error('index process queue is closed');
    const previous = this.queue.findIndex(x => x.job.session === msg.job.session);
    if (previous >= 0) {
      const old = this.queue.splice(previous, 1)[0];
      this.result(old, { superseded: true });
    }
    this.queue.push(msg);
    this.emit('message', { type: 'queued', id: msg.id, session: msg.job.session, depth: this.queue.length, running: !!this.active });
    queueMicrotask(() => this.drain());
  }

  result(task, fields) {
    this.emit('message', { ...fields, type: 'result', id: task.id, session: task.job.session, trigger: task.job.trigger, depth: this.queue.length });
  }

  drain() {
    if (this.closed || this.active) return;
    const task = this.queue.shift();
    if (!task) {
      if (this.quitting) {
        this.closed = true;
        this.emit('message', { type: 'bye', processed: this.processed });
      }
      return;
    }
    const run = { task, child: null, result: false, timer: null, start: Date.now(), failure: null };
    this.active = run;
    const finish = (code, signal) => {
      if (this.active !== run) return;
      clearTimeout(run.timer);
      if (!run.result) this.result(task, { error: run.failure || `index process exit code=${code} signal=${signal ?? ''}`, ms: Date.now() - run.start });
      this.active = null;
      this.emit('message', { type: 'process-exit', pid: run.child?.pid, code, signal });
      this.drain();
    };
    try {
      const env = { ...process.env };
      // Electron host uses its own executable as Node; never mutate the host environment.
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      const child = fork(this.entry, [], {
        execPath: process.execPath, execArgv: ['--max-old-space-size=1536'],
        env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      run.child = child;
      child.on('message', msg => {
        if (this.active !== run || !msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') {
          this.emit('message', { type: 'ready', pid: child.pid, node: msg.node, isolation: 'process' });
          child.send(task, error => {
            if (error && this.active === run) { run.failure = `index IPC: ${error.message}`.slice(0,300); child.kill(); }
          });
        } else if (msg.type === 'result' && msg.id === task.id && !run.result) {
          run.result = true;
          if (!msg.error) this.processed++;
          this.result(task, { ...msg, pid: child.pid });
        }
      });
      child.on('error', error => { run.failure = `index spawn/IPC: ${error.message}`.slice(0,300); });
      // close follows both exit and stdio cleanup, including spawn failures.
      child.once('close', finish);
      run.timer = setTimeout(() => {
        run.failure = `index process timeout after ${this.timeoutMs}ms`;
        child.kill();
      }, this.timeoutMs);
      run.timer.unref?.();
    } catch (error) {
      run.failure = `index spawn: ${error.message}`.slice(0,300);
      finish(null, null);
    }
  }

  terminate() {
    this.closed = true;
    this.quitting = true;
    for (const task of this.queue.splice(0)) this.result(task, { error: 'index queue disposed' });
    if (this.active) {
      this.active.failure = 'index process disposed';
      this.active.child?.kill();
    }
  }
}
