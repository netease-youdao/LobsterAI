import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * OpenClaw runs a full SQLite integrity_check each time it opens a state or
 * agent database, and the check walks the b-trees with random 4 KiB reads. On
 * a cold page cache that costs seconds per large database (4.5s for a 560 MB
 * agent database), while the same check on cached pages takes about 0.5s.
 * Reading the files sequentially while the gateway loads its modules puts
 * them in the OS page cache, which the gateway process shares: its checks
 * still run in full, but no longer wait on random reads.
 */

/** Parallel readers; leaves libuv threadpool capacity for the main process. */
export const OPENCLAW_STATE_DB_PREWARM_CONCURRENCY = 2;

const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const STATE_DATABASE_FILE = 'openclaw.sqlite';
const AGENT_DATABASE_FILE = 'openclaw-agent.sqlite';
const WAL_SUFFIX = '-wal';

export interface OpenClawStateDbPrewarmFile {
  path: string;
  size: number;
}

export interface OpenClawStateDbPrewarmOptions {
  /** Upper bound on bytes read; a larger set would evict itself before the gateway reads it. */
  maxBytes?: number;
  concurrency?: number;
}

export interface OpenClawStateDbPrewarmResult {
  files: number;
  bytes: number;
  /** Files left cold because they exceeded the byte budget or could not be read. */
  skippedFiles: number;
  elapsedMs: number;
}

// State dirs with a pass running; gateway restarts during a pass reuse it.
const activePrewarms = new Map<string, Promise<OpenClawStateDbPrewarmResult>>();

export function getDefaultOpenClawStateDbPrewarmBudget(): number {
  return Math.floor(os.totalmem() / 8);
}

async function statDatabaseFile(filePath: string): Promise<OpenClawStateDbPrewarmFile | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size > 0 ? { path: filePath, size: stat.size } : null;
  } catch {
    return null;
  }
}

/**
 * The state database and each agent database at OpenClaw's default locations,
 * with their WAL files, largest first and within the byte budget.
 */
export async function listOpenClawStateDbPrewarmFiles(
  stateDir: string,
  maxBytes: number,
): Promise<{ files: OpenClawStateDbPrewarmFile[]; skippedFiles: number }> {
  const databases = [path.join(stateDir, 'state', STATE_DATABASE_FILE)];
  const agentsDir = path.join(stateDir, 'agents');
  try {
    for (const entry of await fs.promises.readdir(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        databases.push(path.join(agentsDir, entry.name, 'agent', AGENT_DATABASE_FILE));
      }
    }
  } catch {
    // No agents directory yet: only the state database can exist.
  }

  const candidates = (await Promise.all(
    databases.flatMap(database => [statDatabaseFile(database), statDatabaseFile(database + WAL_SUFFIX)]),
  )).filter((file): file is OpenClawStateDbPrewarmFile => file !== null);
  candidates.sort((left, right) => right.size - left.size);

  const files: OpenClawStateDbPrewarmFile[] = [];
  let budget = maxBytes;
  for (const candidate of candidates) {
    if (candidate.size <= budget) {
      files.push(candidate);
      budget -= candidate.size;
    }
  }
  return { files, skippedFiles: candidates.length - files.length };
}

async function readToEnd(filePath: string, buffer: Buffer): Promise<number> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return position;
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

async function runOpenClawStateDbPrewarm(
  stateDir: string,
  options: OpenClawStateDbPrewarmOptions,
): Promise<OpenClawStateDbPrewarmResult> {
  const startedAt = Date.now();
  const listed = await listOpenClawStateDbPrewarmFiles(
    stateDir,
    options.maxBytes ?? getDefaultOpenClawStateDbPrewarmBudget(),
  );
  const queue = [...listed.files];
  let files = 0;
  let bytes = 0;
  let unreadable = 0;
  const reader = async () => {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (let file = queue.shift(); file; file = queue.shift()) {
      try {
        // Await first: `bytes += await ...` would read the total before other readers add to it.
        const read = await readToEnd(file.path, buffer);
        bytes += read;
        files += 1;
      } catch {
        // A file removed or locked meanwhile only stays cold; the gateway checks it either way.
        unreadable += 1;
      }
    }
  };
  const concurrency = Math.max(1, options.concurrency ?? OPENCLAW_STATE_DB_PREWARM_CONCURRENCY);
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, reader));
  return {
    files,
    bytes,
    skippedFiles: listed.skippedFiles + unreadable,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Best-effort: read OpenClaw's state and agent databases into the OS page
 * cache ahead of the gateway's startup integrity checks. Never rejects for a
 * missing or unreadable file; the gateway verifies every database regardless.
 */
export function prewarmOpenClawStateDatabases(
  stateDir: string,
  options: OpenClawStateDbPrewarmOptions = {},
): Promise<OpenClawStateDbPrewarmResult> {
  const active = activePrewarms.get(stateDir);
  if (active) return active;
  const run = runOpenClawStateDbPrewarm(stateDir, options).finally(() => {
    activePrewarms.delete(stateDir);
  });
  activePrewarms.set(stateDir, run);
  return run;
}
