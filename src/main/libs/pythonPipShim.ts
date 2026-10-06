import fs from 'fs';
import path from 'path';

// Canonical content of the LobsterAI-generated pip shim and wrapper files for
// the bundled Windows Python runtime. scripts/setup-python-runtime.js keeps a
// CJS copy of these templates for packaging time; pythonPipShim.test.ts asserts
// both copies stay byte-identical so the two can never drift again.
//
// This module must stay free of Electron imports so it remains unit-testable.

export const PIP_PYZ_REL_PATH = path.join('tools', 'pip.pyz');
export const PIP_SHIM_MAIN_REL_PATH = path.join('Lib', 'site-packages', 'pip', '__main__.py');
export const PIP_SHIM_INIT_REL_PATH = path.join('Lib', 'site-packages', 'pip', '__init__.py');

export const PIP_SHIM_MAIN_TEMPLATE = [
  'import pathlib',
  'import runpy',
  'import sys',
  '',
  'root = pathlib.Path(__file__).resolve().parents[3]',
  "pip_pyz = root / 'tools' / 'pip.pyz'",
  'if not pip_pyz.exists():',
  "    raise SystemExit(f'pip runtime archive missing: {pip_pyz}')",
  '',
  '# Ensure pip imports resolve to the zipapp payload, not this shim package.',
  'sys.path.insert(0, str(pip_pyz))',
  'for name in list(sys.modules):',
  "    if name == 'pip' or name.startswith('pip.'):",
  '        del sys.modules[name]',
  '',
  "sys.argv[0] = 'pip'",
  "runpy.run_module('pip', run_name='__main__', alter_sys=True)",
  '',
].join('\n');

export const PIP_SHIM_INIT_TEMPLATE = '';

export const PIP_WRAPPER_CMD_TEMPLATE = [
  '@echo off',
  'setlocal',
  'set "PYROOT=%~dp0.."',
  '"%PYROOT%\\python.exe" -m pip %*',
  '',
].join('\r\n');

export const PIP_WRAPPER_SH_TEMPLATE = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
  'PYROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"',
  'exec "${PYROOT}/python.exe" -m pip "$@"',
  '',
].join('\n');

// A pip module dir is "ours" when its __main__.py redirects through pip.pyz —
// true for every historical LobsterAI shim, never for a real pip package
// (e.g. copied from a host Python or installed by get-pip/`pip install pip`).
const PIP_SHIM_OWNERSHIP_MARKER = 'pip.pyz';
const PIP_WRAPPER_OWNERSHIP_MARKER = '-m pip';

const PIP_WRAPPER_FILES: Array<{ relPath: string; template: string }> = [
  { relPath: path.join('Scripts', 'pip.cmd'), template: PIP_WRAPPER_CMD_TEMPLATE },
  { relPath: path.join('Scripts', 'pip3.cmd'), template: PIP_WRAPPER_CMD_TEMPLATE },
  { relPath: path.join('Scripts', 'pip'), template: PIP_WRAPPER_SH_TEMPLATE },
  { relPath: path.join('Scripts', 'pip3'), template: PIP_WRAPPER_SH_TEMPLATE },
];

function readTextIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Converge LobsterAI-owned pip shim/wrapper files to the current templates.
 *
 * Runtimes deployed by older app versions keep whatever shim they were synced
 * with (the health checks only test file existence), so a broken shim would
 * otherwise survive every upgrade. Rewriting is guarded by ownership markers:
 * a real pip package installed into the runtime is never touched, and user
 * packages in site-packages are never affected.
 */
export function repairPipShims(rootDir: string): { changed: string[] } {
  const changed: string[] = [];
  const write = (relPath: string, content: string): void => {
    const fullPath = path.join(rootDir, relPath);
    if (readTextIfExists(fullPath) === content) {
      return;
    }
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    changed.push(relPath);
  };

  const shimMain = readTextIfExists(path.join(rootDir, PIP_SHIM_MAIN_REL_PATH));
  const ownsShim = shimMain === null
    ? fs.existsSync(path.join(rootDir, PIP_PYZ_REL_PATH))
    : shimMain.includes(PIP_SHIM_OWNERSHIP_MARKER);
  if (!ownsShim) {
    return { changed };
  }

  write(PIP_SHIM_MAIN_REL_PATH, PIP_SHIM_MAIN_TEMPLATE);
  write(PIP_SHIM_INIT_REL_PATH, PIP_SHIM_INIT_TEMPLATE);

  for (const wrapper of PIP_WRAPPER_FILES) {
    const existing = readTextIfExists(path.join(rootDir, wrapper.relPath));
    if (existing !== null && !existing.includes(PIP_WRAPPER_OWNERSHIP_MARKER)) {
      continue;
    }
    write(wrapper.relPath, wrapper.template);
  }

  return { changed };
}
