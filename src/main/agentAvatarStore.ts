import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  AGENT_AVATAR_DIR_NAME,
  AGENT_AVATAR_MAX_BYTES,
  AgentAvatarAllowedExtensions,
  AgentAvatarErrorCode,
  type AgentAvatarErrorCode as AgentAvatarErrorCodeValue,
  AgentAvatarExtension,
} from '../shared/agentAvatar/constants';

const TAG = '[AgentAvatarStore]';

const isWithinDirectory = (targetPath: string, directoryPath: string): boolean => {
  const relative = path.relative(directoryPath, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const getUserDataPath = (userDataPath?: string): string => {
  return userDataPath ?? app.getPath('userData');
};

const normalizeExtension = (filePath: string): string => {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
};

export class AgentAvatarError extends Error {
  code: AgentAvatarErrorCodeValue;

  constructor(code: AgentAvatarErrorCodeValue, message?: string) {
    super(message ?? code);
    this.name = 'AgentAvatarError';
    this.code = code;
  }
}

export const isAgentAvatarError = (error: unknown): error is AgentAvatarError => {
  return error instanceof AgentAvatarError;
};

export const resolveAgentAvatarDir = (userDataPath?: string): string => {
  return path.join(getUserDataPath(userDataPath), AGENT_AVATAR_DIR_NAME);
};

export const isManagedAgentAvatarPath = (
  avatarPath?: string | null,
  userDataPath?: string,
): boolean => {
  if (typeof avatarPath !== 'string' || !avatarPath.trim()) {
    return false;
  }

  const resolvedAvatarPath = path.resolve(avatarPath.trim());
  return isWithinDirectory(resolvedAvatarPath, resolveAgentAvatarDir(userDataPath));
};

interface ImportAgentAvatarOptions {
  agentId: string;
  sourcePath: string;
  userDataPath?: string;
}

export async function importAgentAvatar({
  agentId,
  sourcePath,
  userDataPath,
}: ImportAgentAvatarOptions): Promise<string> {
  const trimmedSourcePath = sourcePath.trim();
  if (!trimmedSourcePath) {
    throw new AgentAvatarError(AgentAvatarErrorCode.SourceNotFound);
  }

  const resolvedSourcePath = path.resolve(trimmedSourcePath);
  const extension = normalizeExtension(resolvedSourcePath);
  if (!AgentAvatarAllowedExtensions.includes(extension as AgentAvatarExtension)) {
    throw new AgentAvatarError(AgentAvatarErrorCode.UnsupportedFileType);
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolvedSourcePath);
  } catch (error) {
    console.warn(`${TAG} Failed to stat source avatar file:`, error);
    throw new AgentAvatarError(AgentAvatarErrorCode.SourceNotFound);
  }

  if (!stat.isFile()) {
    throw new AgentAvatarError(AgentAvatarErrorCode.SourceNotFound);
  }

  if (stat.size > AGENT_AVATAR_MAX_BYTES) {
    throw new AgentAvatarError(AgentAvatarErrorCode.FileTooLarge);
  }

  const avatarDir = resolveAgentAvatarDir(userDataPath);
  await fs.promises.mkdir(avatarDir, { recursive: true });

  const safeAgentId = agentId.replace(/[^a-z0-9_-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'agent';
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const destinationPath = path.join(avatarDir, `${safeAgentId}-${uniqueSuffix}.${extension}`);

  try {
    await fs.promises.copyFile(resolvedSourcePath, destinationPath);
    return destinationPath;
  } catch (error) {
    console.error(`${TAG} Failed to import avatar file:`, error);
    throw new AgentAvatarError(AgentAvatarErrorCode.ImportFailed);
  }
}

export async function deleteManagedAgentAvatar(
  avatarPath?: string | null,
  userDataPath?: string,
): Promise<void> {
  if (!isManagedAgentAvatarPath(avatarPath, userDataPath)) {
    return;
  }

  const resolvedAvatarPath = path.resolve(avatarPath!.trim());
  try {
    await fs.promises.unlink(resolvedAvatarPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return;
    }
    console.warn(`${TAG} Failed to delete managed avatar:`, error);
  }
}
