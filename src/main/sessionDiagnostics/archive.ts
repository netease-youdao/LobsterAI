import fs from 'fs';
import { pipeline } from 'stream/promises';
import yazl from 'yazl';

import type {
  CoworkSessionDiagnosticsData,
  CoworkSessionDiagnosticsMessageRow,
} from './types';

const EXPORT_TIMEOUT_MS = 30_000;
const MAX_TITLE_FILE_NAME_CHARS = 40;
const MAX_SESSION_ID_FILE_NAME_CHARS = 8;
const SESSION_DIAGNOSTICS_SCHEMA_VERSION = 1;

export interface SessionDiagnosticsArchiveInput {
  data: CoworkSessionDiagnosticsData;
  appVersion: string;
  exportedAt: string;
}

export interface SessionDiagnosticsArchiveEntry {
  archiveName: string;
  content: string;
}

export interface SessionDiagnosticsStats {
  sessionId: string;
  title: string;
  totalMessages: number;
  messagesByType: Record<string, number>;
  visibleRailMessages: number;
  maxContentChars: number;
  maxAssistantContentChars: number;
  maxToolResultContentChars: number;
  totalContentChars: number;
  hasContinuityCapsule: boolean;
}

const padTwoDigits = (value: number): string => value.toString().padStart(2, '0');

const formatTimestampForFileName = (date: Date): string => (
  `${date.getFullYear()}${padTwoDigits(date.getMonth() + 1)}${padTwoDigits(date.getDate())}`
  + `-${padTwoDigits(date.getHours())}${padTwoDigits(date.getMinutes())}${padTwoDigits(date.getSeconds())}`
);

const sanitizeTitleFileNamePart = (value: string): string => {
  const sanitized = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N} _()-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return Array.from(sanitized).slice(0, MAX_TITLE_FILE_NAME_CHARS).join('').trim();
};

const sanitizeSessionIdFileNamePart = (value: string): string => {
  return value
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_-]+/g, '')
    .slice(0, MAX_SESSION_ID_FILE_NAME_CHARS);
};

const parseJsonObject = (value: string | null): Record<string, unknown> | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const isVisibleRailMessage = (row: CoworkSessionDiagnosticsMessageRow): boolean => {
  if (row.type === 'user') return Boolean(row.content.trim());
  if (row.type !== 'assistant' || !row.content.trim()) return false;

  const metadata = parseJsonObject(row.metadata);
  return metadata?.isThinking !== true;
};

export function buildSessionDiagnosticsDefaultFileName(input: {
  title: string;
  sessionId: string;
  now?: Date;
}): string {
  const titlePart = sanitizeTitleFileNamePart(input.title) || 'session';
  const sessionPart = sanitizeSessionIdFileNamePart(input.sessionId) || 'unknown';
  const timestamp = formatTimestampForFileName(input.now ?? new Date());
  return `lobsterai-diagnostics-${titlePart}-${sessionPart}-${timestamp}.zip`;
}

export function buildSessionDiagnosticsStats(
  data: CoworkSessionDiagnosticsData,
): SessionDiagnosticsStats {
  const messagesByType: Record<string, number> = {};
  let visibleRailMessages = 0;
  let maxContentChars = 0;
  let maxAssistantContentChars = 0;
  let maxToolResultContentChars = 0;
  let totalContentChars = 0;

  for (const message of data.messages) {
    messagesByType[message.type] = (messagesByType[message.type] ?? 0) + 1;

    const contentChars = message.content.length;
    totalContentChars += contentChars;
    maxContentChars = Math.max(maxContentChars, contentChars);
    if (message.type === 'assistant') {
      maxAssistantContentChars = Math.max(maxAssistantContentChars, contentChars);
    }
    if (message.type === 'tool_result') {
      maxToolResultContentChars = Math.max(maxToolResultContentChars, contentChars);
    }
    if (isVisibleRailMessage(message)) {
      visibleRailMessages += 1;
    }
  }

  return {
    sessionId: data.session.id,
    title: data.session.title,
    totalMessages: data.messages.length,
    messagesByType,
    visibleRailMessages,
    maxContentChars,
    maxAssistantContentChars,
    maxToolResultContentChars,
    totalContentChars,
    hasContinuityCapsule: data.capsule !== null,
  };
}

export function buildSessionDiagnosticsArchiveEntries(
  input: SessionDiagnosticsArchiveInput,
): SessionDiagnosticsArchiveEntry[] {
  const stats = buildSessionDiagnosticsStats(input.data);
  const manifest = {
    schemaVersion: SESSION_DIAGNOSTICS_SCHEMA_VERSION,
    packageType: 'lobsterai-session-diagnostics',
    exportedAt: input.exportedAt,
    appVersion: input.appVersion,
    sessionId: input.data.session.id,
    title: input.data.session.title,
    files: [
      'session.json',
      'messages.jsonl',
      'capsule.json',
      'agent.json',
      'stats.json',
    ],
  };
  const messagesJsonl = input.data.messages.map((message) => JSON.stringify(message)).join('\n');

  return [
    {
      archiveName: 'manifest.json',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      archiveName: 'session.json',
      content: `${JSON.stringify(input.data.session, null, 2)}\n`,
    },
    {
      archiveName: 'messages.jsonl',
      content: messagesJsonl ? `${messagesJsonl}\n` : '',
    },
    {
      archiveName: 'capsule.json',
      content: `${JSON.stringify(input.data.capsule, null, 2)}\n`,
    },
    {
      archiveName: 'agent.json',
      content: `${JSON.stringify(input.data.agent, null, 2)}\n`,
    },
    {
      archiveName: 'stats.json',
      content: `${JSON.stringify(stats, null, 2)}\n`,
    },
  ];
}

export async function exportSessionDiagnosticsZip(
  outputPath: string,
  input: SessionDiagnosticsArchiveInput,
): Promise<void> {
  const zipFile = new yazl.ZipFile();

  zipFile.on('error', (err) => {
    (zipFile.outputStream as unknown as { destroy(err: Error): void }).destroy(err as Error);
  });

  for (const entry of buildSessionDiagnosticsArchiveEntries(input)) {
    zipFile.addBuffer(Buffer.from(entry.content, 'utf8'), entry.archiveName);
  }

  const outputStream = fs.createWriteStream(outputPath);
  const pipelinePromise = pipeline(zipFile.outputStream, outputStream);
  zipFile.end();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Session diagnostics export timed out')), EXPORT_TIMEOUT_MS);
  });

  try {
    await Promise.race([pipelinePromise, timeoutPromise]);
  } catch (error) {
    outputStream.destroy();
    pipelinePromise.catch(() => {});
    try { fs.unlinkSync(outputPath); } catch { /* ignore cleanup errors */ }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
