import { builtinModules } from 'module';
import path from 'path';
import type { ElectronOptions } from 'vite-plugin-electron';

import { RemoteWorkerFile } from './src/main/remote/remoteWorkerPath';

const nativeExternals = ['better-sqlite3', 'electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`)];

/** Separate Rollup entry points: workers must never load the application main bundle. */
export function remoteWorkerBuilds(outDir = path.resolve(__dirname, 'dist-electron')): ElectronOptions[] {
  return Object.values(RemoteWorkerFile).map(filename => {
    const source = filename.endsWith('.cjs') ? filename : filename.replace(/\.js$/u, '.ts');
    const entry = path.resolve(__dirname, 'src/main/remote', source);
    return {
      entry,
      vite: {
        configFile: false,
        publicDir: false,
        build: {
          outDir, emptyOutDir: false, minify: false, sourcemap: true,
          lib: { entry, formats: ['cjs'], fileName: () => filename },
          rollupOptions: { external: nativeExternals, output: { inlineDynamicImports: true } },
        },
      },
      onstart() {},
    };
  });
}
