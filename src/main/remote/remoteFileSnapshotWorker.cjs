const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { parentPort } = require('worker_threads');
const LIMIT = 200 * 1024 * 1024;
const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const fail = reason => { throw new Error(reason); };
function check(cancel) { if (Atomics.load(new Int32Array(cancel), 0)) fail('FILE_ACCESS_DENIED'); }
function accountUsage(directory, cancel) {
  let used = 0, count = 0;
  for (const scope of fs.readdirSync(path.dirname(directory), { withFileTypes: true })) {
    check(cancel); if (!scope.isDirectory()) fail('FILE_SOURCE_CHANGED');
    for (const file of fs.readdirSync(path.join(path.dirname(directory), scope.name), { withFileTypes: true })) {
      check(cancel); if (!file.isFile() || ++count > 4096) fail('FILE_TRANSFER_BUSY');
      used += fs.statSync(path.join(path.dirname(directory), scope.name, file.name)).size;
    }
  }
  return used;
}
function admit(directory, additional, cancel) {
  const accountBytes = accountUsage(directory, cancel);
  if (accountBytes + additional > LIMIT) fail('FINAL_SNAPSHOT_UNAVAILABLE');
  const root = path.dirname(path.dirname(directory));
  let globalBytes = 0, count = 0;
  for (const account of fs.readdirSync(root, { withFileTypes: true })) {
    check(cancel); if (!account.isDirectory() || ++count > 16384) fail('FILE_TRANSFER_BUSY');
    for (const scope of fs.readdirSync(path.join(root, account.name), { withFileTypes: true })) {
      check(cancel); if (!scope.isDirectory() || ++count > 16384) fail('FILE_TRANSFER_BUSY');
      for (const file of fs.readdirSync(path.join(root, account.name, scope.name), { withFileTypes: true })) {
        check(cancel); if (!file.isFile() || ++count > 16384) fail('FILE_TRANSFER_BUSY');
        globalBytes += fs.lstatSync(path.join(root, account.name, scope.name, file.name)).size;
      }
    }
  }
  if (globalBytes + additional > 1024 * 1024 * 1024) fail('FINAL_SNAPSHOT_UNAVAILABLE');
  const disk = fs.statfsSync(root);
  if (disk.bavail * disk.bsize - additional < 512 * 1024 * 1024) fail('FINAL_SNAPSHOT_UNAVAILABLE');
  return globalBytes;
}
function hash(file, cancel, expected) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd), digest = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    if (!before.isFile() || before.size > 50 * 1024 * 1024 || (expected && identity(before) !== expected)) fail('FILE_SOURCE_CHANGED');
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null))) { check(cancel); digest.update(buffer.subarray(0, read)); }
    if (identity(before) !== identity(fs.fstatSync(fd)) || identity(before) !== identity(fs.lstatSync(file))) fail('FILE_SOURCE_CHANGED');
    check(cancel); return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}
function outputPath(args) {
  if (args.target === undefined) return path.join(args.directory, randomUUID());
  if (path.dirname(args.target) !== args.directory || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(path.basename(args.target))) fail('FILE_SOURCE_CHANGED');
  return args.target;
}
function capture(args, cancel) {
  check(cancel);
  if (!path.isAbsolute(args.source) || fs.lstatSync(args.source).isSymbolicLink()) fail('FILE_SOURCE_CHANGED');
  const canonical = fs.realpathSync.native(args.source);
  const before = fs.statSync(canonical);
  if (!before.isFile() || before.size < 1 || before.size > Math.min(args.maximumBytes, 50 * 1024 * 1024)) fail('FILE_TOO_LARGE');
  fs.mkdirSync(args.directory, { recursive: true, mode: 0o700 });
  admit(args.directory, before.size, cancel);
  const target = outputPath(args);
  try {
    const input = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const output = fs.openSync(target, 'wx', 0o600);
    try {
      if (identity(fs.fstatSync(input)) !== identity(before)) fail('FILE_SOURCE_CHANGED');
      const buffer = Buffer.alloc(64 * 1024); let read; let total = 0;
      while ((read = fs.readSync(input, buffer, 0, buffer.length, null))) {
        check(cancel); total += read; if (total > before.size) fail('FILE_SOURCE_CHANGED');
        let written = 0; while (written < read) written += fs.writeSync(output, buffer, written, read - written);
      }
      if (total !== before.size) fail('FILE_SOURCE_CHANGED');
      fs.fsyncSync(output);
    } finally { fs.closeSync(input); fs.closeSync(output); }
    const sha256 = hash(target, cancel);
    if (sha256 !== hash(canonical, cancel, identity(before)) || fs.realpathSync.native(args.source) !== canonical) fail('FILE_SOURCE_CHANGED');
    check(cancel);
    return { path: target, sizeBytes: String(before.size), sha256, identity: identity(before), cacheIdentity: identity(fs.statSync(target)) };
  } catch (error) { fs.rmSync(target, { force: true }); throw error; }
}
parentPort.on('message', ({ id, kind, args, cancel }) => {
  try {
    check(cancel); let value;
    if (kind === 'capture') value = capture(args, cancel);
    else if (kind === 'verify') {
      value = hash(args.snapshot.path, cancel, args.snapshot.cacheIdentity);
      if (args.snapshot.sha256 && value !== args.snapshot.sha256) fail('FILE_SOURCE_CHANGED');
      if (args.source && value !== hash(args.source, cancel, args.snapshot.identity)) fail('FILE_SOURCE_CHANGED');
    } else if (kind === 'input') {
      const bytes = Buffer.from(args.base64, 'base64');
      if (bytes.length < 1 || bytes.length > 10 * 1024 * 1024) fail('FILE_TOO_LARGE');
      fs.mkdirSync(args.directory, { recursive: true, mode: 0o700 });
      admit(args.directory, bytes.length, cancel);
      value = outputPath(args);
      const fd = fs.openSync(value, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (Atomics.load(new Int32Array(cancel), 0)) { fs.rmSync(value, { force: true }); fail('FILE_ACCESS_DENIED'); }
    } else fail('FILE_TRANSFER_BUSY');
    parentPort.postMessage({ id, value });
  } catch (error) { parentPort.postMessage({ id, error: error.message || 'FILE_SOURCE_CHANGED',
    transient: ['FILE_TRANSFER_BUSY', 'FILE_ACCESS_DENIED', 'FINAL_SNAPSHOT_UNAVAILABLE'].includes(error.message)
      || ['EIO', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOSPC', 'ETIMEDOUT'].includes(error.code) }); }
});
