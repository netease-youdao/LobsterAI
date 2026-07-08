import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  patchBeePackageDirectory,
} = require('../scripts/openclaw-plugin-preparers/netease-bee.cjs');

describe('prepare-openclaw-netease-bee', () => {
  test('compiles TypeScript runtime entries and updates package metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-netease-bee-'));
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify(
        {
          name: 'openclaw-netease-bee',
          version: '0.1.3',
          main: './index.ts',
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
      "export function activate() { return 'bee'; }\n",
    );
    fs.writeFileSync(path.join(tempDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'bee' }));

    const result = patchBeePackageDirectory(tempDir);
    const pkg = JSON.parse(fs.readFileSync(path.join(tempDir, 'package.json'), 'utf-8'));

    expect(result).toEqual({ changed: true, compiledEntries: ['./index.mjs'] });
    expect(fs.existsSync(path.join(tempDir, 'index.mjs'))).toBe(true);
    expect(pkg.main).toBe('./index.mjs');
    expect(pkg.files).toContain('index.mjs');
    expect(pkg.openclaw.extensions).toEqual(['./index.mjs']);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('leaves already compiled runtime entries unchanged', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-netease-bee-'));
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'openclaw-netease-bee',
        version: '0.1.3',
        openclaw: {
          extensions: ['./index.mjs'],
        },
      }),
    );
    fs.writeFileSync(path.join(tempDir, 'index.mjs'), 'export {};\n');

    expect(patchBeePackageDirectory(tempDir)).toEqual({ changed: false, compiledEntries: [] });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
