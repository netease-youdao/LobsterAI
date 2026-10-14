import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { recoverLegacyDreamingState } from '../scripts/openclaw-dreaming-state-recovery.mjs';
import { isDreamingRecoveryReport, readDreamingRecoverySummary } from '../src/main/libs/openclawDreamingRecovery';
import {
  DREAMING_RECOVERY_DIRECTORY, OpenClawDreamingRecoveryOutcome as Outcome,
  OpenClawDreamingRecoveryStage as Stage, OpenClawDreamingStateFile as File,
} from '../src/shared/openclawEngine/dreamingRecovery';

let root: string;
let stateDir: string;
let configPath: string;
let configRaw: Buffer;
let workspaces: { workspaceDir: string; agentIds: string[] }[];
const invalid = Buffer.from('{"privateSnippet":"测试"}\n{"unexpected":true}\n');
const hash = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');

function source(workspace = workspaces[0], fileName: string = File.DailyIngestion, raw = invalid) {
  const filePath = path.join(workspace.workspaceDir, 'memory', '.dreams', fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, raw);
  return filePath;
}
const run = () => recoverLegacyDreamingState({ stateDir, configPath, configRaw, workspaces });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dreaming-files-')));
  stateDir = path.join(root, 'state');
  configPath = path.join(stateDir, 'openclaw.json');
  workspaces = [{ workspaceDir: path.join(root, '自定义 工作区'), agentIds: ['main'] }];
  configRaw = Buffer.from(JSON.stringify({ agents: { entries: { main: { workspace: workspaces[0].workspaceDir } } } }));
  fs.mkdirSync(stateDir);
  fs.writeFileSync(configPath, configRaw);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (!path.resolve(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) throw new Error('Unexpected fixture path');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe('legacy dreaming source recovery on real files', () => {
  test('leaves absent, valid, unknown-schema JSON and unrelated files untouched', async () => {
    for (const name of Object.values(File)) source(workspaces[0], name, Buffer.from('{"futureVersion":9000}'));
    const unrelated = source(workspaces[0], 'not-a-dreaming-owner.json');
    expect(await run()).toMatchObject({ outcome: Outcome.NotApplicable, files: [], blockers: [] });
    expect(fs.readFileSync(unrelated)).toEqual(invalid);
    expect(fs.existsSync(path.join(stateDir, DREAMING_RECOVERY_DIRECTORY))).toBe(false);
    for (const name of Object.values(File)) expect(fs.readFileSync(sourcePath(name), 'utf8')).toBe('{"futureVersion":9000}');
  });

  test.each(['{} trailing', '{}{}', '{"unterminated":', '', '\u0000\u0000', '\uFEFF{}'])('preserves exact invalid bytes for %j', async text => {
    const raw = Buffer.from(text);
    const original = source(workspaces[0], File.ShortTermRecall, raw);
    const result = await run();
    expect(result.outcome).toBe(Outcome.Recovered);
    expect(isDreamingRecoveryReport(result)).toBe(true);
    expect(result.files[0]).toMatchObject({ sourcePath: original, sha256: hash(raw), size: raw.length, stage: Stage.Verified });
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.readFileSync(result.files[0].backupPath)).toEqual(raw);
    expect(fs.readFileSync(result.files[0].isolatedPath)).toEqual(raw);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(result.manifestPath!, 'utf8')))).not.toContain('unterminated');
  });

  test('handles the 5-workspace / 15-source incident in one run, deduplicates shared workspaces and keeps canonical data', async () => {
    workspaces = Array.from({ length: 5 }, (_, index) => ({ workspaceDir: path.join(root, `工作区 ${index}`), agentIds: [`agent-${index}`] }));
    const originalPaths = workspaces.flatMap(workspace => [File.DailyIngestion, File.SessionIngestion, File.ShortTermRecall].map(name => source(workspace, name)));
    const valid = workspaces.map(workspace => source(workspace, File.PhaseSignals, Buffer.from('{"version":1,"signals":[]}')));
    workspaces.push({ ...workspaces[0], agentIds: ['shared-agent'] });
    const canonical = path.join(stateDir, 'memory.sqlite');
    const archive = originalPaths[0] + '.migrated';
    fs.writeFileSync(canonical, 'canonical state owned by Memory Core');
    fs.writeFileSync(archive, 'historical archive');
    const result = await run();
    expect(result.outcome).toBe(Outcome.Recovered);
    expect(result.files).toHaveLength(15);
    expect(result.files[0].agentIds).toEqual(['agent-0', 'shared-agent']);
    for (const file of result.files) {
      expect(fs.readFileSync(file.backupPath)).toEqual(invalid);
      expect(fs.readFileSync(file.isolatedPath)).toEqual(invalid);
    }
    for (const file of valid) expect(fs.readFileSync(file, 'utf8')).toBe('{"version":1,"signals":[]}');
    expect(fs.readFileSync(canonical, 'utf8')).toBe('canonical state owned by Memory Core');
    expect(fs.readFileSync(archive, 'utf8')).toBe('historical archive');
    const summary = readDreamingRecoverySummary(stateDir);
    expect(summary).toMatchObject({ affectedWorkspaceCount: 5, quarantinedFileCount: 15, pendingFileCount: 0 });
    expect(await run()).toMatchObject({ outcome: Outcome.NotApplicable, files: [] });
    expect(readDreamingRecoverySummary(stateDir)).toEqual(summary);
    expect(fs.readdirSync(path.join(stateDir, DREAMING_RECOVERY_DIRECTORY))).toHaveLength(2);
    // An older writer creating a fresh corrupt source requires a new generation.
    fs.writeFileSync(originalPaths[0], '{} another generation');
    const second = await run();
    expect(second.outcome).toBe(Outcome.Recovered);
    expect(second.manifestPath).not.toBe(result.manifestPath);
    expect(fs.readFileSync(result.files[0].backupPath)).toEqual(invalid);
  });

  test('backs up every candidate before touching any source and stops on disk-full failure', async () => {
    const first = source();
    const second = source(workspaces[0], File.SessionIngestion);
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file).endsWith('1.original.json')) throw Object.assign(new Error('ENOSPC fixture'), { code: 'ENOSPC' });
      return open(file, flags, mode);
    });
    const result = await run();
    expect(result.outcome).toBe(Outcome.Blocked);
    expect(result.blockers.join()).toContain('ENOSPC');
    expect(fs.readFileSync(first)).toEqual(invalid);
    expect(fs.readFileSync(second)).toEqual(invalid);
    expect(readDreamingRecoverySummary(stateDir)).toBeUndefined();
  });

  test('does not overwrite a pre-existing isolation destination', async () => {
    const original = source();
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      fs.writeFileSync(to, 'unrelated destination');
      link(from, to);
    });
    const result = await run();
    expect(result.outcome).toBe(Outcome.Blocked);
    expect(fs.readFileSync(original)).toEqual(invalid);
    expect(fs.readFileSync(result.files[0].isolatedPath, 'utf8')).toBe('unrelated destination');
    expect(readDreamingRecoverySummary(stateDir)).toMatchObject({ quarantinedFileCount: 0, pendingFileCount: 1 });
  });

  test('resumes after linking but before unlinking, using the durable plan and verified disk identity', async () => {
    const original = source();
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file) === original) throw new Error('Interrupted before unlink');
      unlink(file);
    });
    const first = await run();
    expect(first.outcome).toBe(Outcome.Blocked);
    expect(first.files[0].stage).toBe(Stage.Isolated);
    expect(fs.statSync(original).nlink).toBe(2);
    vi.restoreAllMocks();
    const second = await run();
    expect(second).toMatchObject({ outcome: Outcome.Recovered, manifestPath: first.manifestPath });
    expect(fs.existsSync(original)).toBe(false);
    expect(fs.statSync(second.files[0].isolatedPath).nlink).toBe(1);
    expect(readDreamingRecoverySummary(stateDir)).toMatchObject({ quarantinedFileCount: 1, pendingFileCount: 0 });
  });

  test('resumes after unlink succeeded but progress could not be recorded', async () => {
    const original = source();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('manifest.json') && !fs.existsSync(original)) throw new Error('Interrupted manifest update');
      rename(from, to);
    });
    const first = await run();
    expect(first.outcome).toBe(Outcome.Blocked);
    expect(fs.existsSync(original)).toBe(false);
    vi.restoreAllMocks();
    expect(await run()).toMatchObject({ outcome: Outcome.Recovered, manifestPath: first.manifestPath });
  });

  test('retains a changed source instead of treating an old backup as current data', async () => {
    const original = source();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).endsWith('latest.json')) fs.writeFileSync(original, '{"new":"valid"}');
    });
    const result = await run();
    expect(result.outcome).toBe(Outcome.Blocked);
    expect(result.blockers.join()).toContain('source changed');
    expect(fs.readFileSync(original, 'utf8')).toBe('{"new":"valid"}');
    expect(fs.readFileSync(result.files[0].backupPath)).toEqual(invalid);
  });

  test('blocks a config change after backup and never mistakes a read error for invalid JSON', async () => {
    const original = source();
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (String(file) === original) throw Object.assign(new Error('EACCES fixture'), { code: 'EACCES' });
      return open(file, flags, mode);
    });
    expect((await run()).blockers.join()).toContain('EACCES');
    expect(fs.readFileSync(configPath)).toEqual(configRaw);
    vi.restoreAllMocks();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).endsWith('latest.json')) fs.appendFileSync(configPath, ' ');
    });
    const result = await run();
    expect(result.outcome).toBe(Outcome.Blocked);
    expect(result.blockers.join()).toContain('config changed during');
    expect(fs.readFileSync(original)).toEqual(invalid);
    expect(fs.readFileSync(result.files[0].backupPath)).toEqual(invalid);
  });

  test('blocks changed config, oversized sources and unrecognized links without retiring sources', async () => {
    const original = source();
    fs.appendFileSync(configPath, ' ');
    expect((await run()).blockers.join()).toContain('config changed');
    fs.writeFileSync(configPath, configRaw);
    fs.truncateSync(original, 16 * 1024 * 1024 + 1);
    expect((await run()).blockers.join()).toContain('regular file');
    fs.writeFileSync(original, invalid);
    fs.linkSync(original, original + '.another-link');
    expect((await run()).blockers.join()).toContain('unrecognized hard link');
    expect(fs.readFileSync(original)).toEqual(invalid);
  });

  test('refuses a linked memory directory rather than scanning its target', async () => {
    const external = path.join(root, 'external');
    fs.mkdirSync(path.join(external, '.dreams'), { recursive: true });
    fs.writeFileSync(path.join(external, '.dreams', File.DailyIngestion), invalid);
    fs.mkdirSync(workspaces[0].workspaceDir);
    fs.symlinkSync(external, path.join(workspaces[0].workspaceDir, 'memory'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await run()).outcome).toBe(Outcome.Blocked);
    expect(fs.readFileSync(path.join(external, '.dreams', File.DailyIngestion))).toEqual(invalid);
  });
});

function sourcePath(fileName: string) {
  return path.join(workspaces[0].workspaceDir, 'memory', '.dreams', fileName);
}
