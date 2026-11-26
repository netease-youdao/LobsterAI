// Read-only reader for migrated legacy OpenClaw dream diaries (`DREAMS.md`).
//
// Dreaming generation is retired in LobsterAI v2 (DSH cutover). Historical
// diaries migrated into `<userData>/workspaces/<agentId>/DREAMS.md` remain
// readable here without any Electron or runtime dependency.

import * as fs from 'fs';
import * as path from 'path';

import { AgentId } from '../../shared/agent/constants';
import {
  type DreamDiaryData,
  LEGACY_DREAM_DIARY_FILENAME,
  LEGACY_DREAM_DIARY_LOWERCASE_FILENAME,
  type LegacyAgentDreamDiary,
} from '../../shared/cowork/dreamDiary';
import { sanitizeAgentId } from './lobsterMemoryService';

export interface ReadLegacyDreamDiariesOptions {
  /** Optional single agent to query; when omitted, scans all agent workspaces. */
  agentId?: string;
  /** Optional display-name resolver for custom/preset experts. */
  resolveAgentName?: (agentId: string) => string | undefined;
}

/**
 * Find `DREAMS.md` (or case-insensitive variant such as `dreams.md`) inside
 * `dirPath`, preferring canonical uppercase `DREAMS.md`.
 */
export function findLegacyDreamDiaryFile(dirPath: string): string | null {
  if (!dirPath || !fs.existsSync(dirPath)) return null;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  let lowerMatch: string | null = null;
  let caseInsensitiveMatch: string | null = null;

  for (const entry of entries) {
    if (entry.name.toLowerCase() !== LEGACY_DREAM_DIARY_LOWERCASE_FILENAME) {
      continue;
    }
    const candidatePath = path.join(dirPath, entry.name);
    let isFile = entry.isFile();
    if (!isFile && entry.isSymbolicLink()) {
      try {
        isFile = fs.statSync(candidatePath).isFile();
      } catch {
        isFile = false;
      }
    }
    if (!isFile) continue;

    if (entry.name === LEGACY_DREAM_DIARY_FILENAME) {
      return candidatePath;
    }
    if (entry.name === LEGACY_DREAM_DIARY_LOWERCASE_FILENAME && !lowerMatch) {
      lowerMatch = candidatePath;
    } else if (!caseInsensitiveMatch) {
      caseInsensitiveMatch = candidatePath;
    }
  }

  return lowerMatch ?? caseInsensitiveMatch;
}

function readSingleAgentDreamDiary(
  workspacesDir: string,
  agentId: string,
  resolveAgentName?: (agentId: string) => string | undefined,
): LegacyAgentDreamDiary | null {
  let safeId: string;
  try {
    safeId = sanitizeAgentId(agentId);
  } catch {
    return null;
  }

  const agentDir = path.join(workspacesDir, safeId);
  const diaryPath = findLegacyDreamDiaryFile(agentDir);
  if (!diaryPath) return null;

  try {
    const content = fs.readFileSync(diaryPath, 'utf8');
    if (!content.trim()) return null;
    const stat = fs.statSync(diaryPath);
    const resolvedName = resolveAgentName?.(safeId)?.trim();
    return {
      agentId: safeId,
      ...(resolvedName ? { agentName: resolvedName } : {}),
      path: diaryPath,
      content,
      updatedAtMs: Math.round(stat.mtimeMs),
    };
  } catch {
    return null;
  }
}

/**
 * Scan `<workspacesDir>/<agentId>/DREAMS.md` (and `dreams.md`) across `main`
 * and all experts. Returns `main` first when present, plus all discovered
 * agents in `agents[]`, staying backward-compatible with `DreamDiaryData`.
 */
export function readLegacyDreamDiaries(
  workspacesDir: string,
  options: ReadLegacyDreamDiariesOptions = {},
): DreamDiaryData {
  const emptyResult: DreamDiaryData = {
    found: false,
    path: '',
    content: '',
    agents: [],
  };

  if (!workspacesDir || !fs.existsSync(workspacesDir)) {
    return emptyResult;
  }

  const requestedAgentId = options.agentId?.trim();
  if (requestedAgentId) {
    const single = readSingleAgentDreamDiary(
      workspacesDir,
      requestedAgentId,
      options.resolveAgentName,
    );
    if (!single) return emptyResult;
    return {
      found: true,
      agentId: single.agentId,
      path: single.path,
      content: single.content,
      updatedAtMs: single.updatedAtMs,
      agents: [single],
    };
  }

  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(workspacesDir, { withFileTypes: true });
  } catch {
    return emptyResult;
  }

  const agents: LegacyAgentDreamDiary[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const entry = readSingleAgentDreamDiary(
      workspacesDir,
      dirent.name,
      options.resolveAgentName,
    );
    if (entry) {
      agents.push(entry);
    }
  }

  if (agents.length === 0) {
    return emptyResult;
  }

  agents.sort((a, b) => {
    if (a.agentId === AgentId.Main && b.agentId !== AgentId.Main) return -1;
    if (b.agentId === AgentId.Main && a.agentId !== AgentId.Main) return 1;
    return a.agentId.localeCompare(b.agentId);
  });

  const primary = agents[0];
  return {
    found: true,
    agentId: primary.agentId,
    path: primary.path,
    content: primary.content,
    updatedAtMs: primary.updatedAtMs,
    agents,
  };
}
