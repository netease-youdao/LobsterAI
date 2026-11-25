import { buildBrowserSearchUrl } from '@shared/browserWebAccess/constants';
import { LibraryAvailability } from '@shared/library/constants';
import type { LocalArtifactItem } from '@shared/library/types';

import { dedupeArtifactsForDisplay, normalizeFilePathForDedup } from '@/services/artifactParser';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

export const ArtifactNewTabMode = {
  Work: 'work',
  Code: 'code',
} as const;
export type ArtifactNewTabMode = typeof ArtifactNewTabMode[keyof typeof ArtifactNewTabMode];

export const ArtifactNewTabCardId = {
  NewDocument: 'newDocument',
  NewPresentation: 'newPresentation',
  NewSpreadsheet: 'newSpreadsheet',
  NewMarkdown: 'newMarkdown',
  Files: 'files',
  Browser: 'browser',
  WorkspaceChanges: 'workspaceChanges',
  Subagents: 'subagents',
  OpenLocalFile: 'openLocalFile',
  RevealWorkspace: 'revealWorkspace',
} as const;
export type ArtifactNewTabCardId = typeof ArtifactNewTabCardId[keyof typeof ArtifactNewTabCardId];

export const OmniBarInputKind = {
  Empty: 'empty',
  Url: 'url',
  Search: 'search',
} as const;
export type OmniBarInputKind = typeof OmniBarInputKind[keyof typeof OmniBarInputKind];

export interface OmniBarInputClassification {
  kind: OmniBarInputKind;
  query: string;
  normalizedUrl: string | null;
}

const FILE_EXTENSION_TLD_EXCLUSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rtf', 'pdf',
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'tsv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash', 'sql',
  'html', 'htm', 'css', 'scss', 'less', 'svg', 'xml', 'json', 'yaml', 'yml', 'toml', 'ini', 'env',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'mp4', 'mov', 'webm', 'mp3', 'wav',
  'zip', 'tar', 'gz', 'tgz', 'log', 'lock',
]);

const EXPLICIT_URL_SCHEME_RE = /^(https?|file):\/\//i;
const LOCALHOST_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)(:\d+)?(\/.*)?$/i;
const BARE_DOMAIN_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(:\d+)?(\/.*)?$/i;

export function classifyOmniBarInput(raw: string, language?: string): OmniBarInputClassification {
  const query = raw.trim();
  if (!query) {
    return { kind: OmniBarInputKind.Empty, query: '', normalizedUrl: null };
  }
  if (EXPLICIT_URL_SCHEME_RE.test(query)) {
    return { kind: OmniBarInputKind.Url, query, normalizedUrl: query };
  }
  if (LOCALHOST_HOST_RE.test(query)) {
    return { kind: OmniBarInputKind.Url, query, normalizedUrl: `http://${query}` };
  }
  if (!/\s/.test(query)) {
    const match = query.match(BARE_DOMAIN_RE);
    if (match) {
      const host = match[1];
      const port = match[2];
      const pathname = match[3];
      const tld = host.split('.').pop()?.toLowerCase() ?? '';
      const looksLikeLocalFile = !port && !pathname && FILE_EXTENSION_TLD_EXCLUSIONS.has(tld);
      if (tld.length >= 2 && !looksLikeLocalFile) {
        return { kind: OmniBarInputKind.Url, query, normalizedUrl: `https://${query}` };
      }
    }
  }
  return {
    kind: OmniBarInputKind.Search,
    query,
    normalizedUrl: buildBrowserSearchUrl(query, language),
  };
}

export function resolveNewTabMode(isGitRepository: boolean): ArtifactNewTabMode {
  return isGitRepository ? ArtifactNewTabMode.Code : ArtifactNewTabMode.Work;
}

export function resolveNewTabPrimaryCards(mode: ArtifactNewTabMode): ArtifactNewTabCardId[] {
  if (mode === ArtifactNewTabMode.Code) {
    return [
      ArtifactNewTabCardId.Files,
      ArtifactNewTabCardId.WorkspaceChanges,
      ArtifactNewTabCardId.Browser,
      ArtifactNewTabCardId.NewMarkdown,
    ];
  }
  return [
    ArtifactNewTabCardId.NewDocument,
    ArtifactNewTabCardId.NewPresentation,
    ArtifactNewTabCardId.Files,
    ArtifactNewTabCardId.Browser,
  ];
}

export function resolveNewTabOverflowItems(
  mode: ArtifactNewTabMode,
  options: { isGitRepository: boolean; hasWorkingDirectory: boolean; includeSubagents?: boolean },
): ArtifactNewTabCardId[] {
  const includeSubagents = options.includeSubagents ?? true;
  const items: ArtifactNewTabCardId[] = mode === ArtifactNewTabMode.Code
    ? [
        ArtifactNewTabCardId.NewDocument,
        ArtifactNewTabCardId.NewPresentation,
        ArtifactNewTabCardId.NewSpreadsheet,
        ArtifactNewTabCardId.OpenLocalFile,
        ...(includeSubagents ? [ArtifactNewTabCardId.Subagents] : []),
      ]
    : [
        ArtifactNewTabCardId.NewSpreadsheet,
        ArtifactNewTabCardId.NewMarkdown,
        ArtifactNewTabCardId.OpenLocalFile,
        ...(includeSubagents ? [ArtifactNewTabCardId.Subagents] : []),
        ...(options.isGitRepository ? [ArtifactNewTabCardId.WorkspaceChanges] : []),
      ];

  if (options.hasWorkingDirectory) {
    items.push(ArtifactNewTabCardId.RevealWorkspace);
  }
  return items;
}

export function filterSessionArtifactsForOmniBar(
  artifacts: Artifact[],
  query: string,
  limit = 5,
): Artifact[] {
  const keyword = query.trim().toLowerCase();
  const deduped = dedupeArtifactsForDisplay(artifacts);
  if (!keyword) {
    return deduped.slice(0, limit);
  }
  const scored = deduped
    .map(artifact => {
      const name = (artifact.fileName || artifact.title || '').toLowerCase();
      const filePath = (artifact.filePath || '').toLowerCase();
      if (name.startsWith(keyword)) return { artifact, rank: 0 };
      if (name.includes(keyword)) return { artifact, rank: 1 };
      if (filePath.includes(keyword)) return { artifact, rank: 2 };
      return null;
    })
    .filter((entry): entry is { artifact: Artifact; rank: number } => entry !== null)
    .sort((left, right) => left.rank - right.rank);

  return scored.slice(0, limit).map(entry => entry.artifact);
}

export function dedupeLibraryItemsAgainstSession(
  libraryItems: LocalArtifactItem[],
  sessionArtifacts: Artifact[],
  limit = 5,
): LocalArtifactItem[] {
  const sessionPaths = new Set<string>();
  for (const artifact of sessionArtifacts) {
    if (artifact.filePath) {
      sessionPaths.add(normalizeFilePathForDedup(artifact.filePath));
    }
  }
  const seen = new Set<string>();
  const result: LocalArtifactItem[] = [];
  for (const item of libraryItems) {
    if (item.availability !== LibraryAvailability.Available || !item.filePath) continue;
    const normalized = normalizeFilePathForDedup(item.filePath);
    if (sessionPaths.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

export function getWorkspaceDisplayName(cwd?: string | null): string {
  const trimmed = (cwd ?? '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return '';
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

export function extractSessionLocalServicePorts(artifacts: Artifact[]): number[] {
  const ports = new Set<number>();
  for (const artifact of artifacts) {
    if (artifact.type !== ArtifactTypeValue.LocalService) continue;
    const rawUrl = (artifact.url || artifact.content || '').trim();
    if (!rawUrl) continue;
    try {
      const parsed = new URL(rawUrl);
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        ports.add(port);
      }
    } catch {
      // Ignore malformed local service URLs.
    }
  }
  return Array.from(ports);
}
