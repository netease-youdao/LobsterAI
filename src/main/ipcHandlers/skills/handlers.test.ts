import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { registeredHandlers } = vi.hoisted(() => ({
  registeredHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      registeredHandlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../skills', () => ({
  updatePluginSkillIdsFromReport: vi.fn(),
}));

import { registerSkillHandlers, type SkillHandlerDeps } from './handlers';
import type { SkillManager } from '../../skills/skillManager';

describe('skills:delete - OpenClaw source dir deletion target', () => {
  let work: string;
  let sentinelDir: string;

  beforeEach(() => {
    registeredHandlers.clear();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skills-test-'));
    sentinelDir = path.join(work, 'victim-real-data-outside-skills-root');
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.writeFileSync(path.join(sentinelDir, 'irreplaceable.txt'), 'SENTINEL');
  });

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  function makeDeps(openclawSourceDir: string | null): {
    deps: SkillHandlerDeps;
    clearOpenClawSourceDir: ReturnType<typeof vi.fn>;
  } {
    const clearOpenClawSourceDir = vi.fn();
    const deps: SkillHandlerDeps = {
      getSkillManager: () => ({
        getOpenClawSourceDir: () => openclawSourceDir,
        clearOpenClawSourceDir,
        deleteSkill: vi.fn(async () => []),
      }) as unknown as SkillManager,
      getSkillStoreUrl: () => '',
      getOpenClawRuntimeAdapter: () => null,
    };
    return { deps, clearOpenClawSourceDir };
  }

  test('a skill with no recorded OpenClaw source dir never deletes anything outside the skills root', async () => {
    // This is the attack: a malicious skill's own _meta.json could claim any
    // openclawSourceDir it likes, but since this skill was never synced via
    // syncSkillsFromOpenClaw, getOpenClawSourceDir() correctly returns null,
    // regardless of what that skill's own files on disk might say.
    const { deps } = makeDeps(null);
    registerSkillHandlers(deps);
    const handler = registeredHandlers.get('skills:delete')!;

    await handler({}, 'malicious-skill');

    expect(fs.existsSync(sentinelDir)).toBe(true);
  });

  test('a skill with a legitimately recorded OpenClaw source dir still gets cleaned up on delete', async () => {
    const { deps, clearOpenClawSourceDir } = makeDeps(sentinelDir);
    registerSkillHandlers(deps);
    const handler = registeredHandlers.get('skills:delete')!;

    await handler({}, 'synced-skill');

    expect(fs.existsSync(sentinelDir)).toBe(false);
    expect(clearOpenClawSourceDir).toHaveBeenCalledWith('synced-skill');
  });
});
