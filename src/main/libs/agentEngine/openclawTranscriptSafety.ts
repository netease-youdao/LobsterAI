import fs from 'fs';
import path from 'path';

import {
  OpenClawTranscriptSafetyErrorCode,
  OpenClawTranscriptSafetyLimit,
  OpenClawTranscriptSafetyStatus,
  type OpenClawTranscriptSafetyStatus as OpenClawTranscriptSafetyStatusType,
} from '../../../shared/openclawTranscript/constants';

const OPENCLAW_SESSION_STORE_MAX_BYTES = 16 * 1024 * 1024;
const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

type OpenClawSessionEntry = {
  sessionId?: unknown;
  sessionFile?: unknown;
};

export type OpenClawTranscriptSafetyInspection = {
  status: OpenClawTranscriptSafetyStatusType;
  transcriptBytes?: number;
  transcriptPath?: string;
  reason?: string;
};

export type InspectOpenClawTranscriptSafetyInput = {
  stateDir: string;
  agentId: string;
  sessionKey: string;
};

export function classifyOpenClawTranscriptSize(
  transcriptBytes: number,
): OpenClawTranscriptSafetyStatusType {
  if (transcriptBytes >= OpenClawTranscriptSafetyLimit.HardBytes) {
    return OpenClawTranscriptSafetyStatus.Blocked;
  }
  if (transcriptBytes >= OpenClawTranscriptSafetyLimit.SoftBytes) {
    return OpenClawTranscriptSafetyStatus.CompactionRequired;
  }
  return OpenClawTranscriptSafetyStatus.Safe;
}

const isPathInside = (parentPath: string, candidatePath: string): boolean => {
  const relative = path.relative(parentPath, candidatePath);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const resolveSessionsDir = (stateDir: string, agentId: string): string | null => {
  const agentsDir = path.resolve(stateDir, 'agents');
  const sessionsDir = path.resolve(agentsDir, agentId, 'sessions');
  return isPathInside(agentsDir, sessionsDir) ? sessionsDir : null;
};

const resolveContainedTranscriptPath = async (
  sessionsDir: string,
  entry: OpenClawSessionEntry,
): Promise<string | null> => {
  const sessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile.trim() : '';
  const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId.trim() : '';
  const candidates: string[] = [];

  if (sessionFile) {
    candidates.push(path.isAbsolute(sessionFile)
      ? path.resolve(sessionFile)
      : path.resolve(sessionsDir, sessionFile));
  }
  if (SAFE_SESSION_ID_RE.test(sessionId)) {
    candidates.push(path.resolve(sessionsDir, `${sessionId}.jsonl`));
  }

  let realSessionsDir = sessionsDir;
  try {
    realSessionsDir = await fs.promises.realpath(sessionsDir);
  } catch {
    // The directory may not exist yet for a new session.
  }

  for (const candidate of candidates) {
    if (!isPathInside(sessionsDir, candidate)) continue;
    let realCandidate = candidate;
    try {
      realCandidate = await fs.promises.realpath(candidate);
    } catch {
      // A missing candidate is handled by stat in the caller.
    }
    if (isPathInside(realSessionsDir, realCandidate)) {
      return realCandidate;
    }
  }
  return null;
};

export async function inspectOpenClawTranscriptSafety(
  input: InspectOpenClawTranscriptSafetyInput,
): Promise<OpenClawTranscriptSafetyInspection> {
  const sessionsDir = resolveSessionsDir(input.stateDir, input.agentId);
  if (!sessionsDir) {
    return {
      status: OpenClawTranscriptSafetyStatus.Unknown,
      reason: 'invalid_agent_sessions_path',
    };
  }

  const sessionStorePath = path.join(sessionsDir, 'sessions.json');
  let sessionStoreStat: fs.Stats;
  try {
    sessionStoreStat = await fs.promises.stat(sessionStorePath);
  } catch {
    return {
      status: OpenClawTranscriptSafetyStatus.Unknown,
      reason: 'session_store_missing',
    };
  }

  if (!sessionStoreStat.isFile() || sessionStoreStat.size > OPENCLAW_SESSION_STORE_MAX_BYTES) {
    return {
      status: OpenClawTranscriptSafetyStatus.Unknown,
      reason: sessionStoreStat.isFile() ? 'session_store_too_large' : 'session_store_not_file',
    };
  }

  let store: Record<string, unknown>;
  try {
    const raw = await fs.promises.readFile(sessionStorePath, 'utf8');
    store = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      status: OpenClawTranscriptSafetyStatus.Unknown,
      reason: 'session_store_invalid',
    };
  }

  const rawEntry = store[input.sessionKey];
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    return {
      status: OpenClawTranscriptSafetyStatus.Unknown,
      reason: 'session_entry_missing',
    };
  }

  const transcriptPath = await resolveContainedTranscriptPath(
    sessionsDir,
    rawEntry as OpenClawSessionEntry,
  );
  if (!transcriptPath) {
    return {
      status: OpenClawTranscriptSafetyStatus.Unknown,
      reason: 'transcript_path_unresolved',
    };
  }

  try {
    const transcriptStat = await fs.promises.stat(transcriptPath);
    if (!transcriptStat.isFile()) {
      return {
        status: OpenClawTranscriptSafetyStatus.Unknown,
        transcriptPath,
        reason: 'transcript_not_file',
      };
    }
    return {
      status: classifyOpenClawTranscriptSize(transcriptStat.size),
      transcriptBytes: transcriptStat.size,
      transcriptPath,
    };
  } catch {
    return {
      status: OpenClawTranscriptSafetyStatus.Unknown,
      transcriptPath,
      reason: 'transcript_missing',
    };
  }
}

export function buildOpenClawTranscriptOversizedError(
  inspection: Pick<OpenClawTranscriptSafetyInspection, 'transcriptBytes'>,
): Error {
  const transcriptBytes = inspection.transcriptBytes ?? OpenClawTranscriptSafetyLimit.HardBytes;
  return new Error(
    `${OpenClawTranscriptSafetyErrorCode.ActiveTranscriptOversized}: `
    + `active OpenClaw transcript is ${transcriptBytes} bytes; `
    + `safe limit is ${OpenClawTranscriptSafetyLimit.HardBytes} bytes`,
  );
}
