import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { getFileMatchers, copyFiles } = require('app-builder-lib/out/fileMatcher');
const builderConfig = require('../electron-builder.json');
const {
  configureWindowsSkillsPayload,
  listSkillDevOnlyPackages,
} = require('../scripts/skill-payload.cjs');

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-skill-payload-'));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relative: string, content = 'fixture'): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function lock(packages: Record<string, { dev?: boolean; devOptional?: boolean }>): string {
  return JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });
}

function fixture(): string {
  const skills = tempDir();
  write(skills, 'web-search/package-lock.json', lock({
    'node_modules/express': {},
    'node_modules/typescript': { dev: true },
    'node_modules/@types/node': { dev: true },
    'node_modules/@types/serve-static/node_modules/@types/send': { dev: true },
    'node_modules/fsevents': { devOptional: true },
  }));
  for (const relative of [
    'web-search/dist/server/index.js', 'web-search/node_modules/express/index.js',
    'web-search/node_modules/typescript/lib/typescript.js', 'web-search/node_modules/@types/node/package.json',
    'web-search/node_modules/@types/serve-static/node_modules/@types/send/package.json',
    'web-search/node_modules/fsevents/fsevents.js',
  ]) write(skills, relative);
  // Installed without a package-lock.json: npm's hidden lockfile still records dev flags.
  write(skills, 'email/node_modules/.package-lock.json', lock({ 'node_modules/eslint': { dev: true }, 'node_modules/imap': {} }));
  write(skills, 'email/node_modules/eslint/lib/api.js');
  write(skills, 'email/node_modules/imap/lib/Connection.js');
  write(skills, 'weather/SKILL.md');
  return skills;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('lists only the packages a skill lockfile marks dev-only', () => {
  expect(listSkillDevOnlyPackages(fixture())).toEqual([
    'email/node_modules/eslint',
    'web-search/node_modules/@types/node',
    'web-search/node_modules/@types/serve-static/node_modules/@types/send',
    'web-search/node_modules/typescript',
  ]);
});

test('the Windows extraResources filter keeps skill runtime code and drops dev-only packages', async () => {
  const skills = fixture();
  const winSkillsEntry = builderConfig.win.extraResources.find(
    (entry: { to?: string }) => entry.to === 'SKILLs',
  );
  expect(winSkillsEntry).toBeDefined();

  const context = {
    packager: {
      platformSpecificBuildOptions: {
        extraResources: [{ ...winSkillsEntry, from: skills }],
      },
    },
  };
  configureWindowsSkillsPayload(context, skills);

  const out = path.join(tempDir(), 'resources');
  const matchers = getFileMatchers({}, 'extraResources', out, {
    defaultSrc: tempDir(),
    globalOutDir: out,
    customBuildOptions: context.packager.platformSpecificBuildOptions,
    macroExpander: (value: string) => value,
  });
  await copyFiles(matchers);

  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(path.relative(out, full).replace(/\\/g, '/'));
    }
  };
  walk(out);

  expect(entries.sort()).toEqual([
    'SKILLs/email/node_modules/.package-lock.json',
    'SKILLs/email/node_modules/imap/lib/Connection.js',
    'SKILLs/weather/SKILL.md',
    'SKILLs/web-search/dist/server/index.js',
    'SKILLs/web-search/node_modules/express/index.js',
    'SKILLs/web-search/node_modules/fsevents/fsevents.js',
    'SKILLs/web-search/package-lock.json',
  ]);
});
