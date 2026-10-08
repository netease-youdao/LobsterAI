import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  DREAMING_RECOVERY_DIRECTORY, DREAMING_RECOVERY_LATEST_FILE, DREAMING_RECOVERY_REPORT_VERSION,
  OpenClawDreamingRecoveryOutcome as Outcome, OpenClawDreamingRecoveryStage as Stage,
  OpenClawDreamingStateFile,
} from '../src/shared/openclawEngine/dreamingRecovery.ts';
import { OPENCLAW_STARTUP_COMPATIBILITY_VERSION } from '../src/shared/openclawEngine/startupCompatibility.ts';

const FILE_LIMIT = 16 * 1024 * 1024;
const TOTAL_LIMIT = 64 * 1024 * 1024;
const MANIFEST_LIMIT = 1024 * 1024;
const SOURCE_LIMIT = 128;
const RUN_ID = /^[a-f0-9-]{36}$/;
const digest = raw => createHash('sha256').update(raw).digest('hex');
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

function statIfPresent(filePath) {
  try { return fs.lstatSync(filePath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function requireDirectory(directory, create = false) {
  const stat = statIfPresent(directory);
  if (!stat && create) fs.mkdirSync(directory, { mode: 0o700 });
  else if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe recovery directory: ${directory}`);
}

function readFile(filePath, limit = FILE_LIMIT) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) {
    throw new Error(`Recovery requires a regular file no larger than ${limit} bytes: ${filePath}`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
      throw new Error(`Recovery source changed while opening: ${filePath}`);
    }
    // A bounded read also handles a writer growing the file after lstat.
    const buffer = Buffer.alloc(Math.min(limit + 1, stat.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`Recovery source changed while reading: ${filePath}`);
    }
    return { raw: buffer.subarray(0, length), stat, identity: `${stat.dev}:${stat.ino}` };
  } finally { fs.closeSync(fd); }
}

function writeVerified(filePath, raw) {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  if (digest(readFile(filePath, Math.max(raw.length, MANIFEST_LIMIT)).raw) !== digest(raw)) {
    throw new Error(`Recovery backup verification failed: ${filePath}`);
  }
}

function writeJson(filePath, value) {
  const existing = statIfPresent(filePath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error(`Unsafe recovery record: ${filePath}`);
  }
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const raw = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (raw.length > MANIFEST_LIMIT) throw new Error('Dreaming recovery report exceeds its size limit.');
  writeVerified(temporary, raw);
  fs.renameSync(temporary, filePath);
}

function collectTargets(workspaces) {
  const targets = new Map();
  for (const workspace of workspaces) {
    const workspaceStat = statIfPresent(workspace.workspaceDir);
    if (!workspaceStat) continue;
    // Explicit workspace roots may be links; descendants must be regular directories.
    const root = fs.realpathSync(workspace.workspaceDir);
    requireDirectory(root);
    const memory = path.join(root, 'memory');
    const dreams = path.join(memory, '.dreams');
    if (!statIfPresent(memory)) continue;
    requireDirectory(memory);
    if (!statIfPresent(dreams)) continue;
    requireDirectory(dreams);
    for (const fileName of Object.values(OpenClawDreamingStateFile)) {
      const sourcePath = path.join(dreams, fileName);
      const key = normalized(sourcePath);
      const previous = targets.get(key);
      targets.set(key, { sourcePath, fileName, agentIds: [...new Set([...(previous?.agentIds ?? []), ...workspace.agentIds])] });
    }
  }
  return targets;
}

function assertInvalid(raw, filePath) {
  try { JSON.parse(raw.toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
  throw new Error(`Recovery source is now valid JSON; retry startup: ${filePath}`);
}

/** Caller owns the existing stopped-gateway maintenance lock. No SQLite writes. */
export async function recoverLegacyDreamingState({ stateDir, configPath, configRaw, workspaces }) {
  const report = {
    reportVersion: DREAMING_RECOVERY_REPORT_VERSION,
    runtimeVersion: OPENCLAW_STARTUP_COMPATIBILITY_VERSION,
    outcome: Outcome.NotApplicable, files: [], blockers: [],
  };
  let manifest;
  let recoveryRoot;
  const persist = () => {
    manifest.files = report.files;
    manifest.outcome = report.outcome;
    manifest.blockers = report.blockers;
    manifest.recordedAt = new Date().toISOString();
    writeJson(report.manifestPath, manifest);
  };
  try {
    const configHash = digest(readFile(configPath).raw);
    if (configHash !== digest(configRaw)) throw new Error('OpenClaw config changed while resolving dreaming workspaces.');
    const targets = collectTargets(workspaces);
    const parent = path.join(stateDir, 'startup-recovery-backups');
    recoveryRoot = path.join(stateDir, DREAMING_RECOVERY_DIRECTORY);
    // Inspect existing records before reading sources: a crashed no-clobber move
    // can leave two links to the same source, which only this manifest can explain.
    for (const directory of [parent, recoveryRoot]) {
      if (statIfPresent(directory)) requireDirectory(directory);
    }
    const latestPath = path.join(recoveryRoot, DREAMING_RECOVERY_LATEST_FILE);
    if (statIfPresent(latestPath)) {
      const latest = JSON.parse(readFile(latestPath, MANIFEST_LIMIT).raw.toString('utf8'));
      if (typeof latest.runId !== 'string' || !RUN_ID.test(latest.runId)) throw new Error('Invalid dreaming recovery record.');
      const runDir = path.join(recoveryRoot, latest.runId);
      requireDirectory(runDir);
      const manifestPath = path.join(runDir, 'manifest.json');
      const previous = JSON.parse(readFile(manifestPath, MANIFEST_LIMIT).raw.toString('utf8'));
      if (previous.reportVersion !== DREAMING_RECOVERY_REPORT_VERSION
        || previous.runtimeVersion !== OPENCLAW_STARTUP_COMPATIBILITY_VERSION || !Array.isArray(previous.files)
        || previous.files.length > SOURCE_LIMIT) throw new Error('Unsupported dreaming recovery manifest.');
      if (previous.configHash === configHash && previous.files.some(file => file.stage !== Stage.Verified)) {
        for (const [index, file] of previous.files.entries()) {
          const target = targets.get(normalized(file.sourcePath));
          if (!target || target.fileName !== file.fileName || target.sourcePath !== file.sourcePath
            || file.backupPath !== path.join(runDir, `${index}.original.json`)
            || file.isolatedPath !== `${target.sourcePath}.invalid-${latest.runId}`
            || !/^[a-f0-9]{64}$/.test(file.sha256)
            || !Number.isSafeInteger(file.size) || file.size < 0
            || typeof file.identity !== 'string'
            || !Object.values(Stage).includes(file.stage)) throw new Error('Dreaming recovery manifest no longer matches configured sources.');
          file.agentIds = target.agentIds;
        }
        manifest = previous;
        report.outcome = Outcome.Blocked;
        report.files = previous.files;
        report.manifestPath = manifestPath;
      }
    }

    if (!manifest) {
      const sources = [];
      let total = 0;
      for (const target of targets.values()) {
        if (!statIfPresent(target.sourcePath)) continue;
        const source = readFile(target.sourcePath);
        total += source.raw.length;
        if (total > TOTAL_LIMIT) throw new Error('Dreaming recovery sources exceed the 64 MiB limit.');
        if (source.stat.nlink !== 1) throw new Error(`Recovery refuses an unrecognized hard link: ${target.sourcePath}`);
        try { JSON.parse(source.raw.toString('utf8')); }
        catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          sources.push({ ...target, ...source });
        }
      }
      if (!sources.length) return report;
      if (sources.length > SOURCE_LIMIT) throw new Error('Too many invalid dreaming sources for one recovery.');
      report.outcome = Outcome.Blocked;
      requireDirectory(parent, true);
      requireDirectory(recoveryRoot, true);
      const runId = randomUUID();
      const runDir = path.join(recoveryRoot, runId);
      requireDirectory(runDir, true);
      report.manifestPath = path.join(runDir, 'manifest.json');
      for (const [index, source] of sources.entries()) {
        const backupPath = path.join(runDir, `${index}.original.json`);
        writeVerified(backupPath, source.raw);
        report.files.push({
          sourcePath: source.sourcePath, fileName: source.fileName, agentIds: source.agentIds,
          backupPath, isolatedPath: `${source.sourcePath}.invalid-${runId}`,
          sha256: digest(source.raw), size: source.raw.length, identity: source.identity, stage: Stage.BackedUp,
        });
      }
      manifest = { ...report, runId, configHash };
      // Publish the durable plan before the first source can disappear.
      persist();
      writeJson(latestPath, { runId });
    }

    for (const file of report.files) {
      if (digest(readFile(configPath).raw) !== manifest.configHash) throw new Error('OpenClaw config changed during dreaming recovery.');
      requireDirectory(path.dirname(path.dirname(path.dirname(file.sourcePath))));
      requireDirectory(path.dirname(path.dirname(file.sourcePath)));
      requireDirectory(path.dirname(file.sourcePath));
      const backup = readFile(file.backupPath);
      if (digest(backup.raw) !== file.sha256 || backup.raw.length !== file.size) throw new Error(`Dreaming backup changed: ${file.backupPath}`);
      assertInvalid(backup.raw, file.sourcePath);
      let source = statIfPresent(file.sourcePath) ? readFile(file.sourcePath) : null;
      let isolated = statIfPresent(file.isolatedPath) ? readFile(file.isolatedPath) : null;
      if (source && (source.identity !== file.identity || digest(source.raw) !== file.sha256)) {
        throw new Error(`Dreaming source changed; preserved current file: ${file.sourcePath}`);
      }
      if (isolated && (isolated.identity !== file.identity || digest(isolated.raw) !== file.sha256)) {
        throw new Error(`Dreaming isolation target changed: ${file.isolatedPath}`);
      }
      if (!source && !isolated) throw new Error(`Dreaming source and isolation target are missing: ${file.sourcePath}`);
      if (!isolated) {
        if (source.stat.nlink !== 1) throw new Error(`Dreaming source has an unexpected link: ${file.sourcePath}`);
        // link/unlink is a same-volume move that cannot overwrite another file.
        // If the filesystem cannot hard-link, fail with the original still present.
        fs.linkSync(file.sourcePath, file.isolatedPath);
        isolated = readFile(file.isolatedPath);
      }
      if (isolated.identity !== file.identity || digest(isolated.raw) !== file.sha256) {
        throw new Error(`Dreaming source changed while isolating: ${file.sourcePath}`);
      }
      if (source) {
        file.stage = Stage.Isolated;
        persist();
        source = readFile(file.sourcePath);
        if (source.identity !== isolated.identity || digest(source.raw) !== file.sha256 || source.stat.nlink !== 2) {
          throw new Error(`Dreaming source changed before retirement: ${file.sourcePath}`);
        }
        fs.unlinkSync(file.sourcePath);
      }
      if (statIfPresent(file.sourcePath) || digest(readFile(file.isolatedPath).raw) !== file.sha256) {
        throw new Error(`Dreaming isolation could not be verified: ${file.sourcePath}`);
      }
      file.stage = Stage.Verified;
      persist();
    }
    report.outcome = Outcome.Recovered;
    persist();
  } catch (error) {
    report.outcome = Outcome.Blocked;
    // Syntax errors in our records may quote contents. Do not expose those bytes.
    report.blockers.push(error instanceof SyntaxError ? 'Invalid dreaming recovery record; original sources were retained where present.' : String(error.message ?? error));
    if (manifest) {
      try { persist(); } catch { /* Keep the last durable progress record. */ }
    } else {
      // Backups may exist, but no durable isolation plan was published.
      delete report.manifestPath;
    }
  }
  return report;
}
