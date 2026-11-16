import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { build, type Plugin } from 'esbuild';
import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const {
  OPENCLAW_AGENT_DB_BUNDLE_BANNER,
  createOpenClawAgentDbBundlePlugin,
  hasOpenClawAgentDbBundlePolicy,
} = require('../scripts/openclaw-agent-db-bundle.cjs') as {
  OPENCLAW_AGENT_DB_BUNDLE_BANNER: string;
  createOpenClawAgentDbBundlePlugin: (runtimeDir: string) => Plugin;
  hasOpenClawAgentDbBundlePolicy: (bundlePath: string) => boolean;
};
const tempDirs: string[] = [];
const DB_CHUNK = 'openclaw-agent-db-a_B9.js';

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test.each([false, true])('bundled deletion closes a lazy task handle after relocation (runtime junction: %s)', async linked => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-agent-db-bundle-'));
  tempDirs.push(root);
  const runtime = path.join(root, 'build');
  const dist = path.join(runtime, 'dist');
  write(path.join(runtime, 'package.json'), JSON.stringify({ type: 'module' }));
  write(path.join(dist, DB_CHUNK), `
    import { DatabaseSync } from 'node:sqlite';
    const handles = new Map();
    export function open(id) {
      if (!handles.has(id)) handles.set(id, new DatabaseSync(':memory:'));
      return handles.get(id);
    }
    export function close(id) {
      handles.get(id)?.close();
      handles.delete(id);
    }
  `);
  write(path.join(dist, 'task.js'), `export { open } from './${DB_CHUNK}';`);
  write(path.join(dist, 'entry.js'), `#!/usr/bin/env node
    import { open, close } from './${DB_CHUNK}';
    const taskPath = './dist/task.js';
    const task = await import(taskPath);
    const taskHandle = task.open('retired');
    const otherHandle = task.open('survivor');
    const sameHandle = open('retired') === taskHandle;
    close('retired');
    let closed = false;
    try { taskHandle.prepare('SELECT 1').get(); } catch { closed = true; }
    const otherOpen = otherHandle.prepare('SELECT 1 AS n').get().n === 1;
    console.log(JSON.stringify({ sameHandle, closed, otherOpen }));
  `);
  const options = {
    entryPoints: [path.join(dist, 'entry.js')], bundle: true,
    platform: 'node' as const, format: 'esm' as const,
  };
  await build({ ...options, outfile: path.join(runtime, 'baseline.mjs') });
  const runtimeAlias = path.join(root, 'current');
  if (linked) fs.symlinkSync(runtime, runtimeAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await build({
    ...options, outfile: path.join(runtime, 'gateway-bundle.mjs'), metafile: true,
    banner: { js: OPENCLAW_AGENT_DB_BUNDLE_BANNER },
    plugins: [createOpenClawAgentDbBundlePlugin(linked ? runtimeAlias : runtime)],
  });
  expect(Object.keys(result.metafile!.inputs).some(file => file.endsWith(DB_CHUNK))).toBe(false);

  const installed = path.join(root, 'installed 龙虾');
  fs.renameSync(runtime, installed);
  // Cache/archive restoration can give an old bundle a newer mtime than the
  // build scripts. The embedded policy must still distinguish that bundle.
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(installed, 'baseline.mjs'), future, future);
  expect(hasOpenClawAgentDbBundlePolicy(path.join(installed, 'baseline.mjs'))).toBe(false);
  expect(hasOpenClawAgentDbBundlePolicy(path.join(installed, 'gateway-bundle.mjs'))).toBe(true);
  const run = (file: string) => JSON.parse(execFileSync(process.execPath, [path.join(installed, file)], {
    encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' },
  }).trim());
  expect(run('baseline.mjs')).toEqual({ sameHandle: false, closed: false, otherOpen: true });
  expect(run('gateway-bundle.mjs')).toEqual({ sameHandle: true, closed: true, otherOpen: true });
});

test('externalizes DB maintenance chunks but leaves unrelated and outside modules bundled', async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-agent-db-scope-'));
  tempDirs.push(runtime);
  const dist = path.join(runtime, 'dist');
  const maintenance = 'openclaw-agent-db-maintenance-Ab12.js';
  write(path.join(dist, maintenance), 'export const value = 1;');
  write(path.join(runtime, 'outside', DB_CHUNK), 'export const value = 2;');
  write(path.join(dist, 'agent-ui.js'), 'export const value = 3;');
  write(path.join(dist, 'entry.js'), `
    import { value as maintenance } from './${maintenance}';
    import { value as outside } from '../outside/${DB_CHUNK}';
    import { value as ui } from './agent-ui.js';
    console.log(maintenance, outside, ui);
  `);
  const result = await build({
    entryPoints: [path.join(dist, 'entry.js')], outfile: path.join(runtime, 'gateway-bundle.mjs'),
    platform: 'node', format: 'esm', bundle: true, metafile: true, write: false,
    plugins: [createOpenClawAgentDbBundlePlugin(runtime)],
  });
  const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
  expect(inputs.some(file => file.endsWith(maintenance))).toBe(false);
  expect(inputs.some(file => file.endsWith(`/outside/${DB_CHUNK}`))).toBe(true);
  expect(inputs.some(file => file.endsWith('/agent-ui.js'))).toBe(true);
  expect(result.outputFiles![0].text).toContain(`./dist/${maintenance}`);
  expect(result.outputFiles![0].text).not.toContain(runtime);
});
