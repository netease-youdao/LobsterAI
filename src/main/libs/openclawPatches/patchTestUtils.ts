import fs from 'fs';
import path from 'path';
import { expect } from 'vitest';

export function getCurrentOpenClawVersion(): string {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const openclawVersion = packageJson.openclaw?.version;
  expect(openclawVersion).toBeTruthy();
  return openclawVersion;
}

export function getCurrentOpenClawPatchDir(): string {
  const patchDir = path.resolve('scripts', 'patches', getCurrentOpenClawVersion());
  expect(fs.existsSync(patchDir)).toBe(true);
  return patchDir;
}

export function readCurrentOpenClawPatch(patchFile: string): string {
  const patchPath = path.join(getCurrentOpenClawPatchDir(), patchFile);
  expect(fs.existsSync(patchPath)).toBe(true);

  const patchContent = fs.readFileSync(patchPath, 'utf8');
  expect(patchContent.trim().length).toBeGreaterThan(0);
  return patchContent;
}

export function expectPatchContains(patchFile: string, snippets: string[]): void {
  const patchContent = readCurrentOpenClawPatch(patchFile);
  for (const snippet of snippets) {
    expect(patchContent).toContain(snippet);
  }
}

export function expectCurrentOpenClawPatchMissing(patchFile: string): void {
  const patchPath = path.join(getCurrentOpenClawPatchDir(), patchFile);
  expect(fs.existsSync(patchPath)).toBe(false);
}

export function getOpenClawSourceDir(): string {
  return process.env.OPENCLAW_SRC
    ? path.resolve(process.env.OPENCLAW_SRC)
    : path.resolve('..', 'openclaw');
}

export function isOpenClawSourceAvailable(): boolean {
  return fs.existsSync(path.join(getOpenClawSourceDir(), 'package.json'));
}

export function expectOpenClawSourceContains(checks: Array<{
  file: string;
  snippets: string[];
}>): void {
  const openclawSourceDir = getOpenClawSourceDir();
  expect(fs.existsSync(path.join(openclawSourceDir, 'package.json'))).toBe(true);

  for (const check of checks) {
    const sourcePath = path.join(openclawSourceDir, check.file);
    expect(fs.existsSync(sourcePath)).toBe(true);
    const source = fs.readFileSync(sourcePath, 'utf8');
    for (const snippet of check.snippets) {
      expect(source).toContain(snippet);
    }
  }
}

export function findBundledOpenClawRuntimeBundlePath(): string | null {
  const runtimeDir = path.resolve('vendor', 'openclaw-runtime');
  if (!fs.existsSync(runtimeDir)) return null;

  const candidates = [
    path.join(runtimeDir, 'current', 'gateway-bundle.mjs'),
    ...fs.readdirSync(runtimeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(runtimeDir, entry.name, 'gateway-bundle.mjs')),
  ];
  return candidates.find((candidate, index) => (
    candidates.indexOf(candidate) === index && fs.existsSync(candidate)
  )) ?? null;
}

export function isBundledOpenClawRuntimeAvailable(): boolean {
  return findBundledOpenClawRuntimeBundlePath() !== null;
}

export function expectBundledOpenClawRuntimeContains(snippets: string[]): void {
  const runtimePath = findBundledOpenClawRuntimeBundlePath();
  expect(runtimePath).toBeTruthy();

  const source = fs.readFileSync(runtimePath!, 'utf8');
  for (const snippet of snippets) {
    expect(source).toContain(snippet);
  }
}
