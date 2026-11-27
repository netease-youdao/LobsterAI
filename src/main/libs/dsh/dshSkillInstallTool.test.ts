import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { DSH_SKILL_INSTALL_TOOL, DshSkillInstallAction } from '../../../shared/dshEngine/hostConstants';
import type { SkillSecurityReport } from '../skillSecurity/skillSecurityTypes';
import { createDshSkillInstallProvider } from './dshSkillInstallTool';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-chat-')));
  dirs.push(dir);
  return dir;
}

test('uses the bound profile, accepts a chat attachment outside cwd, and rejects other paths', async () => {
  const cwd = tempDir();
  const attachment = tempDir();
  const other = tempDir();
  const root = path.join(cwd, 'active profile', 'SKILLs');
  const manager = {
    getSkillsRoot: () => root,
    downloadSkill: vi.fn().mockResolvedValue({ success: true, installedIds: ['meeting-minutes'] }),
    confirmPendingInstall: vi.fn(),
  };
  const provider = createDshSkillInstallProvider({
    manager: () => manager,
    session: () => ({ cwd, userMessage: 'Install this\nInput Folder: ' + attachment }),
    ask: vi.fn(),
  });
  const context = { coworkSessionId: 'chat', agentId: 'main' };
  expect(await provider.execute(DSH_SKILL_INSTALL_TOOL, { action: DshSkillInstallAction.Inspect }, context)).toEqual({ root });
  const install = (source: string) => provider.execute(DSH_SKILL_INSTALL_TOOL, { source, action: DshSkillInstallAction.Install }, context);
  await expect(install(other)).rejects.toThrow(/attach/);
  await expect(install(attachment)).resolves.toMatchObject({ installed: true, root, ids: ['meeting-minutes'] });
  expect(manager.downloadSkill.mock.calls).toEqual([[attachment, undefined]]);
});

test('a missing native audit decision cancels the pending install', async () => {
  const cwd = tempDir();
  const source = path.join(cwd, 'minutes');
  fs.mkdirSync(source);
  const report: SkillSecurityReport = { scannedAt: 0, skillName: 'minutes', riskLevel: 'high', riskScore: 70, findings: [], dimensionSummary: {}, scanDurationMs: 10 };
  const manager = {
    getSkillsRoot: () => path.join(cwd, 'SKILLs'),
    downloadSkill: vi.fn().mockResolvedValue({ success: true, auditReport: report, pendingInstallId: 'pending' }),
    confirmPendingInstall: vi.fn(),
  };
  const ask = vi.fn().mockResolvedValue(null);
  const provider = createDshSkillInstallProvider({ manager: () => manager, session: () => ({ cwd }), ask });
  const result = await provider.execute(DSH_SKILL_INSTALL_TOOL, { source, action: DshSkillInstallAction.Install }, { coworkSessionId: 'chat', agentId: 'main' });
  expect(ask).toHaveBeenCalledOnce();
  expect(manager.confirmPendingInstall.mock.calls).toEqual([['pending', 'cancel']]);
  expect(result).toMatchObject({ installed: false, cancelled: true });
});
