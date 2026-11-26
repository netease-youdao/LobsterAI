import fs from 'fs';
import path from 'path';
import { parentPort, workerData } from 'worker_threads';

const directory = workerData.directory as string;
const MAX_BYTES = 64 * 1024;
const current = path.join(directory, 'security-journal.json');
const previous = path.join(directory, 'security-journal.previous.json');
function read(filename: string): string | null {
  try {
    const fd = fs.openSync(filename, 'r');
    try {
      if (fs.fstatSync(fd).size > MAX_BYTES) throw new Error('Journal exceeds size limit');
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function replace(filename: string, content: string): void {
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Journal exceeds size limit');
  const temporary = `${filename}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  if (process.platform !== 'win32') {
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
}
parentPort!.on('message', (request: { id: number; operation: 'read' | 'replace'; expected?: string | null; content?: string }) => {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (request.operation === 'read') {
      parentPort!.postMessage({ id: request.id, value: { current: read(current), previous: read(previous) } });
      return;
    }
    if (request.operation !== 'replace' || typeof request.content !== 'string') throw new Error('Invalid journal request');
    const before = read(current);
    // An unexpected writer/restore is never silently overwritten.
    if (before !== request.expected) throw new Error('Journal writer conflict');
    if (before !== null) replace(previous, before);
    replace(current, request.content);
    parentPort!.postMessage({ id: request.id, value: null });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : 'Journal I/O failure' });
  }
});
