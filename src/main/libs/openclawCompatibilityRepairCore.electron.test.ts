import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { expect, test } from 'vitest';

import { OPENCLAW_REPAIR_SNAPSHOT_MANIFEST, OpenClawRepairPhase } from '../../shared/openclawEngine/repair';
import { removeTreeNoFollowSync } from './removeTreeNoFollow';

// Exercise the app's Electron fs bindings as well as Node's. On Windows these
// are actual junctions, including a target removed by an installer upgrade.
test('Electron snapshots valid and dangling generated junctions without creating links', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-repair-electron-')));
  const require = createRequire(import.meta.url);
  try {
    await build({
      entryPoints: [fileURLToPath(new URL('./openclawCompatibilityRepairCore.ts', import.meta.url))],
      outfile: path.join(root, 'owner.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    });
    const request = {
      stateDir: path.join(root, 'state'), configPath: path.join(root, 'state', 'openclaw.json'),
      backupDir: path.join(root, 'backup'), phase: OpenClawRepairPhase.Snapshot,
    };
    fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify(request));
    const script = path.join(root, 'exercise.cjs');
    fs.writeFileSync(script, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const options = require('./request.json');
const { repairOpenClawCompatibility } = require('./owner.cjs');
(async () => {
  const skills = path.join(options.stateDir, 'plugin-skills');
  const external = path.join(__dirname, 'external-plugin');
  for (const dir of [skills, external, options.backupDir]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(external, 'SKILL.md'), 'external content');
  fs.writeFileSync(path.join(skills, 'user-file.txt'), 'user content');
  const links = [path.join(skills, 'valid'), path.join(skills, 'dangling')];
  fs.symlinkSync(external, links[0], 'junction');
  fs.symlinkSync(path.join(__dirname, 'removed-installation'), links[1], 'junction');
  const targets = links.map(link => fs.readlinkSync(link));
  fs.symlinkSync = () => { throw Object.assign(new Error('EPERM: symlink creation denied'), { code: 'EPERM' }); };
  const report = await repairOpenClawCompatibility(options, { withLock: async run => run() });
  assert.equal(report.success, true, report.error);
  assert.deepEqual(links.map(link => fs.readlinkSync(link)), targets);
  assert.equal(fs.readFileSync(path.join(external, 'SKILL.md'), 'utf8'), 'external content');
  assert.equal(fs.readFileSync(path.join(options.backupDir, 'original', 'plugin-skills', 'user-file.txt'), 'utf8'), 'user content');
  console.log(JSON.stringify({ electron: process.versions.electron, platform: process.platform, report }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
    const result = await promisify(execFile)(require('electron') as string, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 20_000,
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ electron: expect.any(String), platform: process.platform,
      report: { success: true, phase: OpenClawRepairPhase.Snapshot } });
    const manifest = JSON.parse(fs.readFileSync(path.join(request.backupDir, OPENCLAW_REPAIR_SNAPSHOT_MANIFEST), 'utf8'));
    expect(manifest.generatedPluginSkillLinks).toHaveLength(2);
  } finally {
    removeTreeNoFollowSync(root);
  }
}, 30_000);
