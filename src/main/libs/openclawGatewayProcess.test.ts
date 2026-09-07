import { type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { spawnOpenClawGatewayProcess } from './openclawGatewayProcess';

const tempDirs: string[] = [];

function makeEntry(source: string): { cwd: string; entryPath: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw gateway process '));
  tempDirs.push(cwd);
  const entryPath = path.join(cwd, 'gateway entry.cjs');
  fs.writeFileSync(entryPath, source);
  return { cwd, entryPath };
}

async function readResult(child: ChildProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('spawnOpenClawGatewayProcess', () => {
  test('propagates Node mode to gateway workers while preserving launch arguments and environment', async () => {
    const entry = makeEntry(`
      const { spawnSync } = require('node:child_process');
      const worker = spawnSync(process.execPath, [
        '-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE || "missing")',
      ], { encoding: 'utf8' });
      if (worker.status !== 0) throw new Error(worker.stderr);
      console.log(JSON.stringify({
        args: process.argv.slice(2),
        execArgv: process.execArgv,
        cwd: process.cwd(),
        nodeMode: process.env.ELECTRON_RUN_AS_NODE,
        workerNodeMode: worker.stdout,
        marker: process.env.OPENCLAW_TEST_MARKER,
      }));
    `);
    const args = ['gateway', '--port', '18789', 'argument with spaces'];
    const execArgv = ['--max-old-space-size=256'];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '0', OPENCLAW_TEST_MARKER: 'preserved' };

    const result = await readResult(spawnOpenClawGatewayProcess({
      executablePath: process.execPath,
      ...entry,
      args,
      execArgv,
      env,
    }));

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args,
      execArgv,
      cwd: fs.realpathSync(entry.cwd),
      nodeMode: '1',
      workerNodeMode: '1',
      marker: 'preserved',
    });
    expect(env.ELECTRON_RUN_AS_NODE).toBe('0');
  });

  test('reports gateway failures and stderr to the supervisor', async () => {
    const entry = makeEntry('process.stderr.write("gateway failed"); process.exitCode = 7;');

    const result = await readResult(spawnOpenClawGatewayProcess({
      executablePath: process.execPath,
      ...entry,
      args: [],
      execArgv: [],
      env: process.env,
    }));

    expect(result).toEqual({ code: 7, stdout: '', stderr: 'gateway failed' });
  });
});
