import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  type AgentLegacyIdentityCleanupResult,
  AgentLegacyIdentityCleanupSkipReason,
  AgentLegacyIdentityCleanupStatus,
} from '../../shared/agent/constants';

const AGENTS_MD_FILENAME = 'AGENTS.md';
const LOBSTERAI_MIGRATIONS_DIR = path.join('.lobsterai', 'migrations');
const LEGACY_IDENTITY_TITLE = '## Identity（必须遵守）';
const MANAGED_MARKER = '<!-- LobsterAI managed: do not edit below this line -->';
const MAX_LEGACY_IDENTITY_BLOCK_CHARS = 20_000;

const TEMPLATE_ANCHORS = [
  'This folder is home. Treat it that way.',
  '## First Run',
  '## Session Startup',
  '## Every Session',
  '## Memory',
] as const;

type LegacyIdentityRemovalReason =
  | typeof AgentLegacyIdentityCleanupSkipReason.NoLegacyBlock
  | typeof AgentLegacyIdentityCleanupSkipReason.LowConfidence;

export type LegacyIdentityRemovalResult =
  | {
      changed: true;
      nextContent: string;
      removedContent: string;
    }
  | {
      changed: false;
      nextContent: string;
      reason: LegacyIdentityRemovalReason;
    };

const detectLineEnding = (content: string): string => (content.includes('\r\n') ? '\r\n' : '\n');

const normalizeLineEndings = (content: string): string => content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const restoreLineEndings = (content: string, lineEnding: string): string =>
  lineEnding === '\n' ? content : content.replace(/\n/g, lineEnding);

const stripBom = (value: string): string => value.replace(/^\uFEFF/, '');

const isBlank = (value: string): boolean => stripBom(value).trim().length === 0;

const findFirstNonBlankLine = (lines: string[], startIndex: number): number => {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!isBlank(lines[index])) {
      return index;
    }
  }
  return -1;
};

const startsWithKnownTemplateAnchor = (line: string): boolean => {
  const trimmed = line.trim();
  return TEMPLATE_ANCHORS.some(anchor => trimmed === anchor || trimmed.startsWith(`${anchor} `));
};

const buildNoChangeResult = (
  content: string,
  reason: LegacyIdentityRemovalReason,
): LegacyIdentityRemovalResult => ({
  changed: false,
  nextContent: content,
  reason,
});

const trimTrailingWhitespace = (content: string): string => content.replace(/[ \t\n]*$/u, '');

const removeLegacyBlockFromPreMarkerContent = (
  preMarkerContent: string,
): LegacyIdentityRemovalResult => {
  const lines = preMarkerContent.split('\n');
  const firstContentLineIndex = findFirstNonBlankLine(lines, 0);
  const hasLegacyTitle = lines.some(line => line.trim() === LEGACY_IDENTITY_TITLE);

  if (firstContentLineIndex < 0) {
    return buildNoChangeResult(preMarkerContent, AgentLegacyIdentityCleanupSkipReason.NoLegacyBlock);
  }

  if (stripBom(lines[firstContentLineIndex]).trim() !== '# AGENTS.md - Your Workspace') {
    return buildNoChangeResult(
      preMarkerContent,
      hasLegacyTitle
        ? AgentLegacyIdentityCleanupSkipReason.LowConfidence
        : AgentLegacyIdentityCleanupSkipReason.NoLegacyBlock,
    );
  }

  const titleLineIndex = findFirstNonBlankLine(lines, firstContentLineIndex + 1);
  if (titleLineIndex < 0 || lines[titleLineIndex].trim() !== LEGACY_IDENTITY_TITLE) {
    return buildNoChangeResult(
      preMarkerContent,
      hasLegacyTitle
        ? AgentLegacyIdentityCleanupSkipReason.LowConfidence
        : AgentLegacyIdentityCleanupSkipReason.NoLegacyBlock,
    );
  }

  let separatorLineIndex = -1;
  for (let index = titleLineIndex + 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      separatorLineIndex = index;
      break;
    }
  }

  if (separatorLineIndex < 0) {
    return buildNoChangeResult(preMarkerContent, AgentLegacyIdentityCleanupSkipReason.LowConfidence);
  }

  const anchorLineIndex = findFirstNonBlankLine(lines, separatorLineIndex + 1);
  if (anchorLineIndex < 0 || !startsWithKnownTemplateAnchor(lines[anchorLineIndex])) {
    return buildNoChangeResult(preMarkerContent, AgentLegacyIdentityCleanupSkipReason.LowConfidence);
  }

  const removedContent = lines.slice(titleLineIndex, anchorLineIndex).join('\n');
  if (removedContent.length > MAX_LEGACY_IDENTITY_BLOCK_CHARS) {
    return buildNoChangeResult(preMarkerContent, AgentLegacyIdentityCleanupSkipReason.LowConfidence);
  }

  const nextLines = [
    ...lines.slice(0, titleLineIndex),
    ...lines.slice(anchorLineIndex),
  ];
  return {
    changed: true,
    nextContent: nextLines.join('\n'),
    removedContent,
  };
};

export function removeLegacyAgentsMdIdentityBlock(content: string): LegacyIdentityRemovalResult {
  const lineEnding = detectLineEnding(content);
  const normalized = normalizeLineEndings(content);
  const markerIndex = normalized.indexOf(MANAGED_MARKER);
  const preMarkerContent = markerIndex >= 0 ? normalized.slice(0, markerIndex) : normalized;
  const managedContent = markerIndex >= 0 ? normalized.slice(markerIndex) : '';
  const result = removeLegacyBlockFromPreMarkerContent(preMarkerContent);

  if (!result.changed) {
    return {
      ...result,
      nextContent: content,
    };
  }

  const nextPreMarkerContent = trimTrailingWhitespace(result.nextContent);
  const nextNormalized = managedContent
    ? `${nextPreMarkerContent}\n\n${managedContent}`
    : `${nextPreMarkerContent}\n`;

  return {
    changed: true,
    nextContent: restoreLineEndings(nextNormalized, lineEnding),
    removedContent: restoreLineEndings(result.removedContent, lineEnding),
  };
}

const formatBackupTimestamp = (date: Date): string =>
  date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');

const buildBackupPath = (workspaceDir: string, originalContent: string, now: Date): string => {
  const hash = crypto.createHash('sha256').update(originalContent).digest('hex').slice(0, 12);
  return path.join(
    workspaceDir,
    LOBSTERAI_MIGRATIONS_DIR,
    `agents-md-before-legacy-identity-cleanup-${formatBackupTimestamp(now)}-${hash}.md`,
  );
};

const atomicWriteFile = (filePath: string, content: string): void => {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
};

export function cleanupLegacyAgentsMdIdentityBlockInWorkspace(
  workspaceDir: string,
  now: Date = new Date(),
): AgentLegacyIdentityCleanupResult {
  try {
    const agentsMdPath = path.join(workspaceDir, AGENTS_MD_FILENAME);
    if (!fs.existsSync(agentsMdPath)) {
      return {
        status: AgentLegacyIdentityCleanupStatus.Skipped,
        reason: AgentLegacyIdentityCleanupSkipReason.NoAgentsMd,
      };
    }

    const originalContent = fs.readFileSync(agentsMdPath, 'utf8');
    const removal = removeLegacyAgentsMdIdentityBlock(originalContent);
    if (removal.changed === false) {
      return {
        status: AgentLegacyIdentityCleanupStatus.Skipped,
        reason: removal.reason,
      };
    }

    const backupPath = buildBackupPath(workspaceDir, originalContent, now);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, originalContent, 'utf8');
    }
    atomicWriteFile(agentsMdPath, removal.nextContent);

    return {
      status: AgentLegacyIdentityCleanupStatus.Cleaned,
      backupPath,
      removedChars: removal.removedContent.length,
    };
  } catch (error) {
    return {
      status: AgentLegacyIdentityCleanupStatus.Failed,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
