import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import {
  PIP_SHIM_INIT_TEMPLATE,
  PIP_SHIM_MAIN_TEMPLATE,
  PIP_WRAPPER_CMD_TEMPLATE,
  PIP_WRAPPER_SH_TEMPLATE,
  repairPipShims,
} from './pythonPipShim';

const requireCjs = createRequire(import.meta.url);
const setupPythonRuntime = requireCjs('../../../scripts/setup-python-runtime.js') as {
  convergePipShimFiles: (rootDir: string) => boolean;
  createPipWrappers: (rootDir: string) => void;
  PIP_SHIM_MAIN_TEMPLATE: string;
  PIP_SHIM_INIT_TEMPLATE: string;
  PIP_WRAPPER_CMD_TEMPLATE: string;
  PIP_WRAPPER_SH_TEMPLATE: string;
};

// The pre-2026-03 shim shipped by older builds. Its run_path bootstrap
// re-enters this same file through pip.pyz's `runpy.run_module('pip', ...)`
// (sys.modules['pip'] still points at the shim package), recursing until
// RecursionError. Kept verbatim as the regression fixture.
const LEGACY_RUN_PATH_SHIM = [
  'import pathlib',
  'import runpy',
  'import sys',
  '',
  'root = pathlib.Path(__file__).resolve().parents[3]',
  "pip_pyz = root / 'tools' / 'pip.pyz'",
  'if not pip_pyz.exists():',
  "    raise SystemExit(f'pip runtime archive missing: {pip_pyz}')",
  "sys.argv[0] = 'pip'",
  "runpy.run_path(str(pip_pyz), run_name='__main__')",
  '',
].join('\n');

// A real pip package's __main__.py contains no pip.pyz marker and must never
// be overwritten by the shim converger.
const REAL_PIP_MAIN = [
  'import sys',
  '',
  'from pip._internal.cli.main import main',
  '',
  "if __name__ == '__main__':",
  '    sys.exit(main())',
  '',
].join('\n');

const SHIM_MAIN_REL = path.join('Lib', 'site-packages', 'pip', '__main__.py');
const SHIM_INIT_REL = path.join('Lib', 'site-packages', 'pip', '__init__.py');
const PYZ_REL = path.join('tools', 'pip.pyz');
const WRAPPER_RELS = [
  path.join('Scripts', 'pip.cmd'),
  path.join('Scripts', 'pip3.cmd'),
  path.join('Scripts', 'pip'),
  path.join('Scripts', 'pip3'),
];

function writeLayout(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }
}

function readIfExists(root: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(root, relPath), 'utf8');
  } catch {
    return null;
  }
}

function withRoot(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pip-shim-test-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('pip shim template contract with scripts/setup-python-runtime.js', () => {
  test('templates are byte-identical in both sources', () => {
    expect(setupPythonRuntime.PIP_SHIM_MAIN_TEMPLATE).toBe(PIP_SHIM_MAIN_TEMPLATE);
    expect(setupPythonRuntime.PIP_SHIM_INIT_TEMPLATE).toBe(PIP_SHIM_INIT_TEMPLATE);
    expect(setupPythonRuntime.PIP_WRAPPER_CMD_TEMPLATE).toBe(PIP_WRAPPER_CMD_TEMPLATE);
    expect(setupPythonRuntime.PIP_WRAPPER_SH_TEMPLATE).toBe(PIP_WRAPPER_SH_TEMPLATE);
  });

  test('canonical shim boots pip via run_module, never via run_path recursion', () => {
    expect(PIP_SHIM_MAIN_TEMPLATE).toContain("runpy.run_module('pip'");
    expect(PIP_SHIM_MAIN_TEMPLATE).toContain('sys.path.insert(0, str(pip_pyz))');
    expect(PIP_SHIM_MAIN_TEMPLATE).not.toContain('run_path');
  });
});

describe('repairPipShims', () => {
  test('rewrites the legacy run_path shim to the canonical template', () => {
    withRoot((root) => {
      writeLayout(root, {
        [PYZ_REL]: 'fake-pyz',
        [SHIM_MAIN_REL]: LEGACY_RUN_PATH_SHIM,
        [SHIM_INIT_REL]: '',
        [WRAPPER_RELS[0]]: '"%PYROOT%\\python.exe" -m pip %*',
      });
      const { changed } = repairPipShims(root);
      expect(readIfExists(root, SHIM_MAIN_REL)).toBe(PIP_SHIM_MAIN_TEMPLATE);
      expect(changed).toContain(SHIM_MAIN_REL);
      expect(readIfExists(root, WRAPPER_RELS[0])).toBe(PIP_WRAPPER_CMD_TEMPLATE);
      expect(readIfExists(root, WRAPPER_RELS[2])).toBe(PIP_WRAPPER_SH_TEMPLATE);
    });
  });

  test('is a no-op on an already-canonical runtime', () => {
    withRoot((root) => {
      writeLayout(root, {
        [PYZ_REL]: 'fake-pyz',
        [SHIM_MAIN_REL]: PIP_SHIM_MAIN_TEMPLATE,
        [SHIM_INIT_REL]: PIP_SHIM_INIT_TEMPLATE,
        [WRAPPER_RELS[0]]: PIP_WRAPPER_CMD_TEMPLATE,
        [WRAPPER_RELS[1]]: PIP_WRAPPER_CMD_TEMPLATE,
        [WRAPPER_RELS[2]]: PIP_WRAPPER_SH_TEMPLATE,
        [WRAPPER_RELS[3]]: PIP_WRAPPER_SH_TEMPLATE,
      });
      const { changed } = repairPipShims(root);
      expect(changed).toEqual([]);
    });
  });

  test('leaves a real pip package untouched', () => {
    withRoot((root) => {
      writeLayout(root, {
        [PYZ_REL]: 'fake-pyz',
        [SHIM_MAIN_REL]: REAL_PIP_MAIN,
        [SHIM_INIT_REL]: "__version__ = '24.0'\n",
      });
      const { changed } = repairPipShims(root);
      expect(changed).toEqual([]);
      expect(readIfExists(root, SHIM_MAIN_REL)).toBe(REAL_PIP_MAIN);
      expect(readIfExists(root, SHIM_INIT_REL)).toBe("__version__ = '24.0'\n");
      expect(readIfExists(root, WRAPPER_RELS[0])).toBeNull();
    });
  });

  test('creates shim files when the pip module is missing but pip.pyz exists', () => {
    withRoot((root) => {
      writeLayout(root, { [PYZ_REL]: 'fake-pyz' });
      const { changed } = repairPipShims(root);
      expect(changed.length).toBeGreaterThan(0);
      expect(readIfExists(root, SHIM_MAIN_REL)).toBe(PIP_SHIM_MAIN_TEMPLATE);
      expect(readIfExists(root, SHIM_INIT_REL)).toBe(PIP_SHIM_INIT_TEMPLATE);
      expect(readIfExists(root, WRAPPER_RELS[0])).toBe(PIP_WRAPPER_CMD_TEMPLATE);
    });
  });

  test('does nothing when neither pip module nor pip.pyz exists', () => {
    withRoot((root) => {
      const { changed } = repairPipShims(root);
      expect(changed).toEqual([]);
      expect(readIfExists(root, SHIM_MAIN_REL)).toBeNull();
    });
  });

  test('does not overwrite a foreign wrapper script', () => {
    withRoot((root) => {
      writeLayout(root, {
        [PYZ_REL]: 'fake-pyz',
        [SHIM_MAIN_REL]: LEGACY_RUN_PATH_SHIM,
        [WRAPPER_RELS[0]]: 'echo custom launcher',
      });
      repairPipShims(root);
      expect(readIfExists(root, WRAPPER_RELS[0])).toBe('echo custom launcher');
      expect(readIfExists(root, WRAPPER_RELS[1])).toBe(PIP_WRAPPER_CMD_TEMPLATE);
    });
  });
});

describe('build-script convergence matches runtime repair', () => {
  test('both implementations produce identical files from a legacy layout', () => {
    const layout = {
      [PYZ_REL]: 'fake-pyz',
      [SHIM_MAIN_REL]: LEGACY_RUN_PATH_SHIM,
      [SHIM_INIT_REL]: '',
    };
    withRoot((tsRoot) => {
      withRoot((scriptRoot) => {
        writeLayout(tsRoot, layout);
        writeLayout(scriptRoot, layout);
        repairPipShims(tsRoot);
        if (setupPythonRuntime.convergePipShimFiles(scriptRoot)) {
          setupPythonRuntime.createPipWrappers(scriptRoot);
        }
        for (const relPath of [SHIM_MAIN_REL, SHIM_INIT_REL, ...WRAPPER_RELS]) {
          expect(readIfExists(scriptRoot, relPath)).toBe(readIfExists(tsRoot, relPath));
        }
      });
    });
  });

  test('both implementations refuse to touch a real pip package', () => {
    const layout = {
      [SHIM_MAIN_REL]: REAL_PIP_MAIN,
      [SHIM_INIT_REL]: "__version__ = '24.0'\n",
    };
    withRoot((tsRoot) => {
      withRoot((scriptRoot) => {
        writeLayout(tsRoot, layout);
        writeLayout(scriptRoot, layout);
        expect(repairPipShims(tsRoot).changed).toEqual([]);
        expect(setupPythonRuntime.convergePipShimFiles(scriptRoot)).toBe(false);
        expect(readIfExists(scriptRoot, SHIM_MAIN_REL)).toBe(REAL_PIP_MAIN);
      });
    });
  });
});
