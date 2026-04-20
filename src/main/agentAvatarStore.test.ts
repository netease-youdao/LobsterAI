import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/lobsterai-tests',
  },
}));

import { AGENT_AVATAR_MAX_BYTES, AgentAvatarErrorCode } from '../shared/agentAvatar/constants';
import {
  deleteManagedAgentAvatar,
  importAgentAvatar,
  isManagedAgentAvatarPath,
} from './agentAvatarStore';

let userDataPath: string;

beforeEach(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-avatar-store-'));
});

test('importAgentAvatar copies a supported image into the managed avatar directory', async () => {
  const sourcePath = path.join(userDataPath, 'source.png');
  fs.writeFileSync(sourcePath, Buffer.from('avatar-image'));

  const importedPath = await importAgentAvatar({
    agentId: 'writer',
    sourcePath,
    userDataPath,
  });

  expect(importedPath).not.toBe(sourcePath);
  expect(path.basename(path.dirname(importedPath))).toBe('agent-avatars');
  expect(fs.existsSync(importedPath)).toBe(true);
  expect(isManagedAgentAvatarPath(importedPath, userDataPath)).toBe(true);

  await deleteManagedAgentAvatar(importedPath, userDataPath);
  expect(fs.existsSync(importedPath)).toBe(false);
});

test('importAgentAvatar rejects unsupported file types', async () => {
  const sourcePath = path.join(userDataPath, 'source.txt');
  fs.writeFileSync(sourcePath, 'not-an-image');

  await expect(importAgentAvatar({
    agentId: 'writer',
    sourcePath,
    userDataPath,
  })).rejects.toMatchObject({
    code: AgentAvatarErrorCode.UnsupportedFileType,
  });
});

test('importAgentAvatar rejects files that exceed the size limit', async () => {
  const sourcePath = path.join(userDataPath, 'large.png');
  fs.writeFileSync(sourcePath, Buffer.alloc(AGENT_AVATAR_MAX_BYTES + 1, 1));

  await expect(importAgentAvatar({
    agentId: 'writer',
    sourcePath,
    userDataPath,
  })).rejects.toMatchObject({
    code: AgentAvatarErrorCode.FileTooLarge,
  });
});
