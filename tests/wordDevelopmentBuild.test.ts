import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { optimizeDeps, resolveConfig } from 'vite';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the real development config prebundles the Word editor from a cold cache', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'lobster-word-vite-'));
  try {
    // Resolve the app config and plugins, but do not start Electron or a server.
    // Build.target alone does not configure Vite's development prebundler.
    const config = await resolveConfig({
      root,
      configFile: path.join(root, 'vite.config.ts'),
      cacheDir,
      logLevel: 'silent',
      optimizeDeps: {
        entries: [path.join(root, 'src/renderer/services/wordEditorSession.ts')],
      },
    }, 'serve');
    const metadata = await optimizeDeps(config, true);
    for (const id of ['@docx-editor.dev/core/editor', '@docx-editor.dev/core/layout']) {
      expect(metadata.optimized[id], `Missing optimized Word entry: ${id}`).toBeDefined();
      expect((await readFile(metadata.optimized[id].file, 'utf8')).length).toBeGreaterThan(0);
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
