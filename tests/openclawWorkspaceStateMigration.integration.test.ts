// Run against a built runtime, using only temporary state:
// OPENCLAW_WORKSPACE_MIGRATION_RUNTIME=<runtime> npm test -- openclawWorkspaceStateMigration
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  OPENCLAW_WORKSPACE_MIGRATION_ENTRY,
  OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX,
  type OpenClawWorkspaceMigrationReport,
  OpenClawWorkspaceMigrationStatus,
} from '../src/shared/openclawEngine/workspaceMigration';

const runtimeRoot = process.env.OPENCLAW_WORKSPACE_MIGRATION_RUNTIME;
const execFileAsync = promisify(execFile);
const seededAt = '2026-09-01T01:02:03.000Z';
const completedAt = '2026-09-02T04:05:06.000Z';
const content = JSON.stringify({ version: 1, bootstrapSeededAt: seededAt, onboardingCompletedAt: completedAt });
const digest = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let tempDir: string;
let stateDir: string;
let configPath: string;
let workspaces: string[];

describe.skipIf(!runtimeRoot)('bundled OpenClaw workspace migration', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-workspace-migration-integration-'));
    stateDir = path.join(tempDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    workspaces = [path.join(stateDir, 'workspace-main'), path.join(tempDir, 'custom workspace')];
    for (const workspace of workspaces) {
      fs.mkdirSync(path.join(workspace, '.openclaw'), { recursive: true });
      for (const filename of ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md']) {
        fs.writeFileSync(path.join(workspace, filename), `# Preserve ${filename}\nUser content.\n`);
      }
    }
    fs.writeFileSync(configPath, JSON.stringify({
      agents: { entries: { main: { default: true, workspace: workspaces[0] }, custom: { workspace: workspaces[1] } } },
      // A full Doctor/validator would reject this: this migration must leave IM alone.
      channels: { discord: { accounts: { fixture: { dm: { policy: 'open', allowFrom: ['*'] } } } } },
      plugins: { load: { paths: [path.join(tempDir, 'must-not-load-plugin')] } },
    }));
  });
  afterEach(() => { fs.rmSync(tempDir, { recursive: true, force: true }); });

  async function migrate(): Promise<{ code: number; report: OpenClawWorkspaceMigrationReport }> {
    const args = [path.join(runtimeRoot!, OPENCLAW_WORKSPACE_MIGRATION_ENTRY)];
    const options = {
      cwd: runtimeRoot, windowsHide: true, timeout: 30_000,
      env: { ...process.env, OPENCLAW_HOME: tempDir, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
    };
    let stdout: string;
    let stderr = '';
    let code = 0;
    try {
      ({ stdout, stderr } = await execFileAsync(process.execPath, args, options));
    } catch (error) {
      const failure = error as Error & { code: number; stdout: string; stderr: string };
      if (failure.code !== 1) throw error;
      code = failure.code;
      stdout = failure.stdout;
      stderr = failure.stderr;
    }
    const line = stdout.split(/\r?\n/).find(value => value.startsWith(OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX));
    expect(line, (stdout + stderr).slice(-3000)).toBeDefined();
    return { code, report: JSON.parse(line!.slice(OPENCLAW_WORKSPACE_MIGRATION_RESULT_PREFIX.length)) };
  }

  test('imports both legacy setup formats for all configured workspaces and preserves files/config/empty lock', async () => {
    const markers = [path.join(workspaces[0], '.openclaw/workspace-state.json'), path.join(workspaces[1], 'openclaw-workspace-state.json')];
    for (const marker of markers) fs.writeFileSync(marker, content);
    fs.writeFileSync(`${configPath}.lock`, '');
    const lockMtime = fs.statSync(`${configPath}.lock`).mtimeMs;
    const protectedFiles = [configPath, ...workspaces.flatMap(workspace =>
      ['AGENTS.md', 'SOUL.md', 'USER.md', 'IDENTITY.md', 'MEMORY.md'].map(name => path.join(workspace, name)))];
    const before = protectedFiles.map(digest);
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.report).toMatchObject({ status: OpenClawWorkspaceMigrationStatus.Migrated, sourceCount: 2, warnings: [], remainingPaths: [] });
    expect(markers.every(marker => !fs.existsSync(marker))).toBe(true);
    expect(protectedFiles.map(digest)).toEqual(before);
    expect(fs.statSync(`${configPath}.lock`).size).toBe(0);
    expect(fs.statSync(`${configPath}.lock`).mtimeMs).toBe(lockMtime);
    const db = new DatabaseSync(path.join(stateDir, 'state/openclaw.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT bootstrap_seeded_at, setup_completed_at FROM workspace_setup_state').all();
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(Array.from({ length: 2 }, () => ({ bootstrap_seeded_at: seededAt, setup_completed_at: completedAt })));
    } finally { db.close(); }
    expect((await migrate()).report.status).toBe(OpenClawWorkspaceMigrationStatus.Skipped);
  });

  test('preserves invalid state and retries successfully after it is repaired', async () => {
    const marker = path.join(workspaces[0], 'openclaw-workspace-state.json');
    fs.writeFileSync(marker, '{broken');
    const failed = await migrate();
    expect(failed.code).toBe(1);
    expect(failed.report.status).toBe(OpenClawWorkspaceMigrationStatus.Failed);
    expect(failed.report.warnings.join(' ')).toContain('invalid JSON');
    expect(fs.readFileSync(marker, 'utf8')).toBe('{broken');
    fs.writeFileSync(marker, content);
    expect((await migrate()).report.status).toBe(OpenClawWorkspaceMigrationStatus.Migrated);
  });

  test('recovers an interrupted Doctor claim', async () => {
    const marker = path.join(workspaces[1], 'openclaw-workspace-state.json.doctor-importing');
    fs.writeFileSync(marker, content);
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.report.status).toBe(OpenClawWorkspaceMigrationStatus.Migrated);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('imports owned attestation files and preserves unrelated sibling files', async () => {
    const attestation = `${workspaces[0]}.attested`;
    const unrelated = `${workspaces[1]}.attested`;
    const generatedHash = digest(path.join(workspaces[0], 'AGENTS.md'));
    fs.writeFileSync(attestation, `openclaw-workspace-attestation:v1\n${seededAt}\ngenerated:AGENTS.md:${generatedHash}\n`);
    fs.writeFileSync(unrelated, 'Unrelated user file');
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.report.status).toBe(OpenClawWorkspaceMigrationStatus.Migrated);
    expect(fs.existsSync(attestation)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('Unrelated user file');
    const db = new DatabaseSync(path.join(stateDir, 'state/openclaw.sqlite'), { readOnly: true });
    try {
      expect(db.prepare('SELECT COUNT(*) AS count FROM workspace_generated_bootstrap_hashes').get()?.count).toBe(1);
    } finally { db.close(); }
  });

  test('does not create a database when there are no legacy workspace sources', async () => {
    expect((await migrate()).report.status).toBe(OpenClawWorkspaceMigrationStatus.Skipped);
    expect(fs.existsSync(path.join(stateDir, 'state/openclaw.sqlite'))).toBe(false);
  });
});
