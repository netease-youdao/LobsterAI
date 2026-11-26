const { Socket } = require('net');
const { Worker, isMainThread, workerData } = require('worker_threads');

// An IPC disconnect handler on the encoder's main thread cannot run during synchronous
// SQLite/encoding work. A separate thread observes the parent's OS-owned pipe instead.
const stop = () => process.kill(process.pid, 'SIGKILL');
if (isMainThread) {
  const ready = new Int32Array(new SharedArrayBuffer(4));
  const guard = new Worker(__filename, { execArgv: [], workerData: { ready: ready.buffer } });
  guard.on('error', stop);
  guard.on('exit', stop);
  // This preload runs only inside the child. Do not let encoding start before the guard.
  Atomics.wait(ready, 0, 0, 5000);
  if (Atomics.load(ready, 0) !== 1) stop();
} else {
  try {
    const pipe = new Socket({ fd: 4, readable: true, writable: false });
    pipe.on('error', stop); pipe.on('end', stop); pipe.on('close', stop); pipe.resume();
    const ready = new Int32Array(workerData.ready);
    Atomics.store(ready, 0, 1); Atomics.notify(ready, 0);
  } catch { stop(); }
}
