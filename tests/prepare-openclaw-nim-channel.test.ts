import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  patchNimPackageDirectory,
} = require('../scripts/openclaw-plugin-preparers/nim-channel.cjs');

describe('prepare-openclaw-nim-channel', () => {
  test('compiles the scoped NIM package and bundles relative TypeScript modules', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-nim-channel-'));
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify(
        {
          name: '@nimsuite/openclaw-nim-channel',
          version: '1.0.3',
          files: ['index.ts', 'src', 'openclaw.plugin.json'],
          openclaw: {
            extensions: ['./index.ts'],
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(tempDir, 'index.ts'),
      "export { getRuntimeName } from './src/runtime.js';\n",
    );
    fs.writeFileSync(
      path.join(srcDir, 'runtime.ts'),
      "export const getRuntimeName = () => 'nim';\n",
    );
    fs.writeFileSync(
      path.join(tempDir, 'openclaw.plugin.json'),
      JSON.stringify({ id: 'nimsuite-openclaw-nim-channel' }),
    );

    const result = patchNimPackageDirectory(tempDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf-8'));
    const output = fs.readFileSync(path.join(tempDir, 'index.mjs'), 'utf-8');

    expect(result).toEqual({ changed: true, compiledEntries: ['./index.mjs'] });
    expect(output).toContain('getRuntimeName');
    expect(pkg.main).toBe('./index.mjs');
    expect(pkg.files).toContain('index.mjs');
    expect(pkg.openclaw.extensions).toEqual(['./index.mjs']);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects a package with an unexpected npm name', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-nim-channel-'));
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'different-plugin',
        openclaw: {
          extensions: ['./index.ts'],
        },
      }),
    );
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export {};\n');

    expect(() => patchNimPackageDirectory(tempDir)).toThrow(
      'Expected @nimsuite/openclaw-nim-channel, got different-plugin',
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
