import {
  ShareDeploymentCandidateSource,
  type ShareDeploymentProjectCandidate,
} from '../../shared/shareDeployment/constants';
import { type Artifact, type ArtifactType, ArtifactTypeValue } from '../types/artifact';
import type { CoworkMessage } from '../types/cowork';

/**
 * Normalize a local artifact path from markdown, MEDIA tokens, or tool metadata.
 */
export function normalizeArtifactFilePath(filePath: string): string {
  let normalized = filePath.trim();
  const mediaMatch = normalized.match(/(?:^|[\\/])MEDIA:\s*(.+)$/i);
  if (mediaMatch) {
    normalized = mediaMatch[1].trim();
  } else {
    normalized = normalized.replace(/^MEDIA:\s*/i, '').trim();
  }
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file:/')) {
    normalized = normalized.slice(5);
  } else if (normalized.startsWith('localfile:///')) {
    normalized = normalized.slice(12);
  } else if (normalized.startsWith('localfile://')) {
    normalized = normalized.slice(12);
  }
  const queryIndex = normalized.search(/[?#]/);
  if (queryIndex >= 0) {
    normalized = normalized.slice(0, queryIndex);
  }
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep the original value if it contains a literal percent sign.
  }
  // Strip leading / before drive letter (e.g. /D:/path from file:///D:/path)
  if (/^\/[A-Za-z]:/.test(normalized)) normalized = normalized.slice(1);
  return normalized;
}

/**
 * Normalize file path for deduplication comparison.
 * Handles Windows file:// URL leading slash and backslash differences.
 */
export function normalizeFilePathForDedup(p: string): string {
  const normalized = normalizeArtifactFilePath(p);
  // Unify separators and case for comparison
  return normalized.replace(/\\/g, '/').toLowerCase();
}

export function normalizeProjectDirectoryForDedup(projectDirectory: string): string {
  let normalized = projectDirectory.trim().replace(/\\/g, '/');
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.toLowerCase();
}

export function getLocalServicePortIdentityKey(url?: string): string {
  if (!url?.trim()) return '';
  try {
    const parsed = new URL(trimLocalServiceUrl(url));
    const port = parsed.port ||
      (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    return port ? `local-service-port:${port}` : `local-service:${normalizeLocalServiceUrlForDedup(url)}`;
  } catch {
    return `local-service:${normalizeLocalServiceUrlForDedup(url)}`;
  }
}

interface DedupeArtifactsOptions {
  defaultProjectDirectory?: string;
}

const getArtifactIdentityKeys = (artifact: Artifact): string[] => {
  const keys: string[] = [];
  if (artifact.filePath) {
    keys.push(`file:${artifact.type}:${normalizeFilePathForDedup(artifact.filePath)}`);
  }
  const remoteUrl = artifact.remoteUrl?.trim();
  if (remoteUrl) {
    keys.push(`url:${artifact.type}:${remoteUrl}`);
  }
  if ((artifact.type === 'image' || artifact.type === 'video') && artifact.content?.trim()) {
    keys.push(`url:${artifact.type}:${artifact.content.trim()}`);
  }
  if (artifact.type === ArtifactTypeValue.LocalService) {
    const localServiceUrl = artifact.url?.trim() || artifact.content?.trim();
    if (localServiceUrl) {
      keys.push(getLocalServicePortIdentityKey(localServiceUrl));
    }
  }
  const fileName = artifact.fileName?.trim() || artifact.title?.trim();
  if (artifact.type === 'video' && fileName) {
    keys.push(`name:${artifact.type}:${fileName.toLowerCase()}`);
  }
  return keys;
};

function getLocalServiceProjectConfidence(
  artifact: Artifact,
  options: DedupeArtifactsOptions = {},
): number {
  if (artifact.type !== ArtifactTypeValue.LocalService) return 0;
  const projectDirectory = artifact.localService?.projectDirectory?.trim();
  if (!projectDirectory) return 0;

  const defaultProjectDirectory = options.defaultProjectDirectory?.trim()
    ? normalizeProjectDirectoryForDedup(options.defaultProjectDirectory)
    : '';
  const normalizedProjectDirectory = normalizeProjectDirectoryForDedup(projectDirectory);
  return defaultProjectDirectory && normalizedProjectDirectory === defaultProjectDirectory ? 0 : 1;
}

export const shouldPreferArtifactForDisplay = (
  candidate: Artifact,
  current: Artifact,
  options: DedupeArtifactsOptions = {},
): boolean => {
  if (
    candidate.type === ArtifactTypeValue.LocalService &&
    current.type === ArtifactTypeValue.LocalService
  ) {
    const candidateProjectConfidence = getLocalServiceProjectConfidence(candidate, options);
    const currentProjectConfidence = getLocalServiceProjectConfidence(current, options);
    if (candidateProjectConfidence !== currentProjectConfidence) {
      return candidateProjectConfidence > currentProjectConfidence;
    }
  }

  const currentHasFileProtocol = Boolean(current.filePath && /^file:/i.test(current.filePath));
  const candidateHasFileProtocol = Boolean(candidate.filePath && /^file:/i.test(candidate.filePath));
  if (current.filePath && !candidate.filePath) return false;
  if (!current.filePath && candidate.filePath) return true;
  if (currentHasFileProtocol && candidate.filePath && !candidateHasFileProtocol) return true;
  if (!currentHasFileProtocol && current.filePath && candidateHasFileProtocol) return false;
  if (!current.remoteUrl && candidate.remoteUrl) return true;
  if (!current.content && candidate.content) return true;
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  return true;
};

export function dedupeArtifactsForDisplay(
  artifacts: Artifact[],
  options: DedupeArtifactsOptions = {},
): Artifact[] {
  const result: Artifact[] = [];
  const keyToIndex = new Map<string, number>();

  for (const artifact of artifacts) {
    const keys = getArtifactIdentityKeys(artifact);
    const existingIndex = keys
      .map(key => keyToIndex.get(key))
      .find((index): index is number => index !== undefined);

    if (existingIndex === undefined) {
      const nextIndex = result.length;
      result.push(artifact);
      for (const key of keys) {
        keyToIndex.set(key, nextIndex);
      }
      continue;
    }

    if (shouldPreferArtifactForDisplay(artifact, result[existingIndex], options)) {
      result[existingIndex] = artifact;
    }
    for (const key of keys) {
      keyToIndex.set(key, existingIndex);
    }
  }

  return result;
}

export function resolveArtifactIdForDisplay(
  artifacts: Artifact[],
  artifactId: string,
  options: DedupeArtifactsOptions = {},
): string {
  const target = artifacts.find(artifact => artifact.id === artifactId);
  if (!target) return artifactId;

  const displayArtifacts = dedupeArtifactsForDisplay(artifacts, options);
  if (displayArtifacts.some(artifact => artifact.id === artifactId)) {
    return artifactId;
  }

  const targetKeys = new Set(getArtifactIdentityKeys(target));
  if (targetKeys.size === 0) return artifactId;

  const displayArtifact = displayArtifacts.find(artifact =>
    getArtifactIdentityKeys(artifact).some(key => targetKeys.has(key))
  );

  return displayArtifact?.id ?? artifactId;
}

export function dedupeArtifactsWithinMessages(artifacts: Artifact[]): Artifact[] {
  const result: Artifact[] = [];
  const keyToIndex = new Map<string, number>();

  for (const artifact of artifacts) {
    const keys = getArtifactIdentityKeys(artifact).map(key => `${artifact.messageId}:${key}`);
    const existingIndex = keys
      .map(key => keyToIndex.get(key))
      .find((index): index is number => index !== undefined);

    if (existingIndex === undefined) {
      const nextIndex = result.length;
      result.push(artifact);
      for (const key of keys) {
        keyToIndex.set(key, nextIndex);
      }
      continue;
    }

    if (shouldPreferArtifactForDisplay(artifact, result[existingIndex])) {
      result[existingIndex] = artifact;
    }
    for (const key of keys) {
      keyToIndex.set(key, existingIndex);
    }
  }

  return result;
}

export function hasToolResultMediaAssets(toolResultMsg: CoworkMessage | undefined): boolean {
  if (!toolResultMsg?.metadata || toolResultMsg.metadata.isError) return false;

  const details = toolResultMsg.metadata.toolResultDetails;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;

  const assets = (details as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return false;

  return assets.some(asset => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
    const item = asset as Record<string, unknown>;
    if (item.type !== 'image' && item.type !== 'video') return false;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const filePath = typeof item.filePath === 'string' ? item.filePath.trim() : '';
    const localPath = typeof item.localPath === 'string' ? item.localPath.trim() : '';
    if (item.type === 'video') {
      return Boolean(filePath || localPath);
    }
    return Boolean(url || filePath || localPath);
  });
}

const EXTENSION_TO_ARTIFACT_TYPE: Record<string, ArtifactType> = {
  '.html': 'html',
  '.htm': 'html',
  '.svg': 'svg',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.bmp': 'image',
  '.avif': 'image',
  '.mp4': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.mermaid': 'mermaid',
  '.mmd': 'mermaid',
  '.jsx': 'code',
  '.tsx': 'code',
  '.css': 'code',
  '.md': 'markdown',
  '.txt': 'text',
  '.log': 'text',
  '.csv': 'document',
  '.tsv': 'document',
  '.xls': 'document',
  '.docx': 'document',
  '.xlsx': 'document',
  '.pptx': 'document',
  '.pdf': 'document',
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const BINARY_DOCUMENT_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.csv', '.tsv', '.xls']);
const LOCAL_SERVICE_URL_RE = /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d{1,5})?(?:\/[^\s<>"'`)\]]*)?/gi;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;
const FILE_MARKDOWN_LINK_RE = /\[([^\]]+)\]\((file:\/\/[^)\s]+)\)/gi;
const LOCAL_SERVICE_TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？、]+$/;
const PROJECT_DIRECTORY_LABEL_RE = /(?:项目目录|项目路径|工程目录|工作目录|project\s+directory|project\s+path|working\s+directory)\s*[:：]\s*([^\n]+)|(?:项目位置|项目位于)\s*(?:[:：]|为|是|在)?\s*([^\n]+)/gi;
const CD_COMMAND_RE = /(?:^|\n)\s*(?:[$>]\s*)?cd(?:\s+\/d)?\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\n;&|]+))/gi;
const FILE_LIKE_PATH_EXTENSION_RE = /\.[A-Za-z0-9]{1,12}$/;


export function getArtifactTypeFromExtension(ext: string): ArtifactType | null {
  return EXTENSION_TO_ARTIFACT_TYPE[ext.toLowerCase()] ?? null;
}

export function isImageExtension(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

export function isVideoExtension(ext: string): boolean {
  return VIDEO_EXTENSIONS.has(ext.toLowerCase());
}

export function isBinaryDocumentExtension(ext: string): boolean {
  return BINARY_DOCUMENT_EXTENSIONS.has(ext.toLowerCase());
}

function trimLocalServiceUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  while (url.endsWith(')') && !url.includes('(')) {
    url = url.slice(0, -1);
  }
  while (url.endsWith(']') && !url.includes('[')) {
    url = url.slice(0, -1);
  }
  return url.replace(LOCAL_SERVICE_TRAILING_PUNCTUATION_RE, '');
}

function decodeProjectDirectoryFileUrl(value: string): string {
  const trimmed = value.trim();
  if (!/^file:/i.test(trimmed)) return '';
  try {
    const parsed = new URL(trimmed);
    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname;
  } catch {
    return '';
  }
}

function cleanProjectDirectoryCandidate(value: string): string {
  let candidate = value.trim();
  const markdownLinkMatch = candidate.match(/^\[\s*`?([^`\]\n]+?)`?\s*\]\(([^)\n]+)\)/);
  if (markdownLinkMatch) {
    const linkText = markdownLinkMatch[1].trim();
    const hrefPath = decodeProjectDirectoryFileUrl(markdownLinkMatch[2]);
    candidate = isAbsoluteProjectDirectoryCandidate(linkText) || linkText.includes('/') || linkText.includes('\\')
      ? linkText
      : hrefPath || linkText;
  }

  return candidate
    .trim()
    .replace(/^`+|`+$/g, '')
    .replace(/[，。；;,.]+$/g, '')
    .trim();
}

function isAbsoluteProjectDirectoryCandidate(value: string): boolean {
  return /^\/[^/]/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\/.test(value) ||
    /^~\//.test(value);
}

function isPlausibleProjectDirectoryCandidate(value: string): boolean {
  if (!value) return false;
  if (/^[`[\](){}<>]+$/.test(value)) return false;
  return isAbsoluteProjectDirectoryCandidate(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    /^[\w.-]+$/.test(value);
}

function resolveRelativeProjectDirectory(candidate: string, baseDirectory?: string): string {
  const base = baseDirectory?.trim();
  if (!base || isAbsoluteProjectDirectoryCandidate(candidate)) return candidate;
  if (!candidate || candidate.startsWith('$')) return candidate;

  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  const normalizedBase = base.replace(/[\\/]+$/g, '');
  const combined = `${normalizedBase}${separator}${candidate}`;
  const parts = combined.replace(/\\/g, '/').split('/');
  const resolvedParts: string[] = [];
  const prefix = combined.startsWith('/') ? '/' : '';

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      resolvedParts.pop();
      continue;
    }
    resolvedParts.push(part);
  }

  return `${prefix}${resolvedParts.join('/')}`;
}

function pathDirectoryName(value: string): string {
  let normalized = value.trim().replace(/\\/g, '/');
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  const separatorIndex = normalized.lastIndexOf('/');
  if (separatorIndex <= 0) return normalized;
  return normalized.slice(0, separatorIndex);
}

function fileUrlPathToDirectory(value: string, linkText?: string): string {
  const decoded = decodeProjectDirectoryFileUrl(value);
  if (!decoded) return '';
  const link = linkText?.trim() || '';
  if (decoded.endsWith('/') || link.endsWith('/')) {
    return decoded.replace(/[\\/]+$/g, '');
  }
  const lastSegment = decoded.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const linkLastSegment = link.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const targetLooksLikeFile = FILE_LIKE_PATH_EXTENSION_RE.test(lastSegment) ||
    FILE_LIKE_PATH_EXTENSION_RE.test(linkLastSegment);
  return targetLooksLikeFile ? pathDirectoryName(decoded) : decoded;
}

function normalizeDirectoryForCompare(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function splitDirectoryParts(value: string): {
  prefix: string;
  parts: string[];
} {
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (/^[A-Za-z]:\//.test(normalized)) {
    return {
      prefix: normalized.slice(0, 3),
      parts: normalized.slice(3).split('/').filter(Boolean),
    };
  }
  if (normalized.startsWith('/')) {
    return {
      prefix: '/',
      parts: normalized.slice(1).split('/').filter(Boolean),
    };
  }
  return {
    prefix: '',
    parts: normalized.split('/').filter(Boolean),
  };
}

function commonProjectDirectory(directories: string[]): string {
  const normalizedDirectories = Array.from(new Set(
    directories
      .map(directory => directory.trim())
      .filter(Boolean)
      .map(directory => directory.replace(/\\/g, '/').replace(/\/+$/g, '')),
  ));
  if (normalizedDirectories.length < 2) return '';

  const first = splitDirectoryParts(normalizedDirectories[0]);
  const commonParts = [...first.parts];
  for (const directory of normalizedDirectories.slice(1)) {
    const current = splitDirectoryParts(directory);
    if (current.prefix.toLowerCase() !== first.prefix.toLowerCase()) return '';
    let index = 0;
    while (
      index < commonParts.length &&
      index < current.parts.length &&
      commonParts[index].toLowerCase() === current.parts[index].toLowerCase()
    ) {
      index++;
    }
    commonParts.length = index;
  }

  if (commonParts.length === 0) return '';
  return `${first.prefix}${commonParts.join('/')}`;
}

function addProjectDirectoryCandidate(
  candidates: ShareDeploymentProjectCandidate[],
  inputDirectory: string,
  source: ShareDeploymentProjectCandidate['source'],
  confidence: number,
  options: {
    fallbackProjectDirectory?: string;
    reason?: string;
    evidence?: string;
    messageId?: string;
  } = {},
): void {
  const cleaned = cleanProjectDirectoryCandidate(inputDirectory);
  if (!isPlausibleProjectDirectoryCandidate(cleaned)) return;
  const directory = resolveRelativeProjectDirectory(cleaned, options.fallbackProjectDirectory);
  if (!isPlausibleProjectDirectoryCandidate(directory)) return;
  const normalized = normalizeDirectoryForCompare(directory);
  if (!normalized) return;

  const existing = candidates.find(candidate => normalizeDirectoryForCompare(candidate.directory) === normalized);
  const candidate: ShareDeploymentProjectCandidate = {
    directory,
    source,
    confidence,
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
    ...(options.messageId ? { messageId: options.messageId } : {}),
    detectedAt: Date.now(),
  };
  if (!existing) {
    candidates.push(candidate);
    return;
  }
  if (candidate.confidence > existing.confidence) {
    Object.assign(existing, candidate);
  }
}

function selectBestProjectDirectoryCandidate(
  candidates: ShareDeploymentProjectCandidate[],
): ShareDeploymentProjectCandidate | undefined {
  return [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
}

function collectProjectDirectoryCandidatesFromText(
  messageContent: string,
  fallbackProjectDirectory?: string,
  messageId?: string,
): ShareDeploymentProjectCandidate[] {
  const candidates: ShareDeploymentProjectCandidate[] = [];

  const labelRe = new RegExp(PROJECT_DIRECTORY_LABEL_RE.source, 'gi');
  let labelMatch: RegExpExecArray | null;
  while ((labelMatch = labelRe.exec(messageContent)) !== null) {
    addProjectDirectoryCandidate(
      candidates,
      labelMatch[1] || labelMatch[2] || '',
      ShareDeploymentCandidateSource.TextLabeledPath,
      85,
      {
        fallbackProjectDirectory,
        reason: 'Matched an explicit project directory label in the assistant response.',
        evidence: labelMatch[0],
        messageId,
      },
    );
  }

  const cdRe = new RegExp(CD_COMMAND_RE.source, 'gi');
  let cdMatch: RegExpExecArray | null;
  while ((cdMatch = cdRe.exec(messageContent)) !== null) {
    addProjectDirectoryCandidate(
      candidates,
      cdMatch[1] || cdMatch[2] || cdMatch[3] || cdMatch[4] || '',
      ShareDeploymentCandidateSource.TextCdCommand,
      80,
      {
        fallbackProjectDirectory,
        reason: 'Matched a cd command near the local service output.',
        evidence: cdMatch[0],
        messageId,
      },
    );
  }

  const fileLinkDirectories: string[] = [];
  const fileLinkRe = new RegExp(FILE_MARKDOWN_LINK_RE.source, 'gi');
  let fileLinkMatch: RegExpExecArray | null;
  while ((fileLinkMatch = fileLinkRe.exec(messageContent)) !== null) {
    const directory = fileUrlPathToDirectory(fileLinkMatch[2], fileLinkMatch[1]);
    if (!directory) continue;
    fileLinkDirectories.push(directory);
    addProjectDirectoryCandidate(
      candidates,
      directory,
      ShareDeploymentCandidateSource.TextFileLink,
      82,
      {
        reason: 'Matched a local file link in the assistant response.',
        evidence: fileLinkMatch[0],
        messageId,
      },
    );
  }

  const commonDirectory = commonProjectDirectory(fileLinkDirectories);
  if (commonDirectory) {
    addProjectDirectoryCandidate(
      candidates,
      commonDirectory,
      ShareDeploymentCandidateSource.TextCommonParent,
      84,
      {
        reason: 'Matched the common parent directory of local file links.',
        messageId,
      },
    );
  }

  return candidates;
}

export function normalizeLocalServiceUrlForDedup(url: string): string {
  try {
    const parsed = new URL(trimLocalServiceUrl(url));
    const pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return trimLocalServiceUrl(url).toLowerCase();
  }
}

export function normalizeLocalServiceOrigin(url: string): string {
  try {
    const parsed = new URL(trimLocalServiceUrl(url));
    return parsed.origin.toLowerCase();
  } catch {
    return trimLocalServiceUrl(url).replace(/\/+$/, '').toLowerCase();
  }
}

function isLocalServiceUrl(url: string): boolean {
  try {
    const parsed = new URL(trimLocalServiceUrl(url));
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    if (!isHttp) return false;

    return parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '0.0.0.0' ||
      parsed.hostname === '[::1]' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname);
  } catch {
    return false;
  }
}

function buildLocalServiceTitle(url: string, linkText?: string): string {
  const title = linkText?.trim();
  if (title && !/^https?:\/\//i.test(title)) {
    return title;
  }

  try {
    const parsed = new URL(url);
    const pathPart = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
    return pathPart || parsed.host;
  } catch {
    return url;
  }
}

export function parseLocalServiceUrlsFromText(
  messageContent: string,
  messageId: string,
  sessionId: string,
  context?: { projectDirectory?: string },
): Artifact[] {
  if (!messageContent) return [];

  const artifacts: Artifact[] = [];
  const seenUrls = new Set<string>();
  const projectCandidates = collectProjectDirectoryCandidatesFromText(
    messageContent,
    context?.projectDirectory,
    messageId,
  );
  const projectDirectory = selectBestProjectDirectoryCandidate(projectCandidates)?.directory || '';
  let index = 0;

  const addUrl = (rawUrl: string, linkText?: string) => {
    const url = trimLocalServiceUrl(rawUrl);
    if (!url || !isLocalServiceUrl(url)) return;

    const normalized = normalizeLocalServiceUrlForDedup(url);
    if (seenUrls.has(normalized)) return;
    seenUrls.add(normalized);

    artifacts.push({
      id: `artifact-local-service-${messageId}-${index}`,
      messageId,
      sessionId,
      type: ArtifactTypeValue.LocalService,
      title: buildLocalServiceTitle(url, linkText),
      content: url,
      url,
      localService: {
        url,
        origin: normalizeLocalServiceOrigin(url),
        ...(projectDirectory
          ? { projectDirectory }
          : {}),
        ...(projectCandidates.length > 0
          ? { projectCandidates }
          : {}),
      },
      createdAt: Date.now(),
    });
    index++;
  };

  const markdownRe = new RegExp(MARKDOWN_LINK_RE.source, 'gi');
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownRe.exec(messageContent)) !== null) {
    addUrl(markdownMatch[2], markdownMatch[1]);
  }

  const urlRe = new RegExp(LOCAL_SERVICE_URL_RE.source, 'gi');
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlRe.exec(messageContent)) !== null) {
    addUrl(urlMatch[0]);
  }

  return artifacts;
}

export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^`\n]+?)`?\s*$/gim;

export function parseMediaTokensFromText(
  messageContent: string,
  messageId: string,
  sessionId: string,
): Artifact[] {
  if (!messageContent) return [];

  const artifacts: Artifact[] = [];
  const re = new RegExp(MEDIA_TOKEN_RE.source, 'gim');
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = re.exec(messageContent)) !== null) {
    const filePath = normalizeArtifactFilePath(match[1]);
    if (!filePath) continue;

    const ext = getFileExtension(filePath);
    const artifactType = getArtifactTypeFromExtension(ext);
    if (!artifactType) continue;

    const fileName = getFileName(filePath);

    artifacts.push({
      id: `artifact-media-${messageId}-${index}`,
      messageId,
      sessionId,
      type: artifactType,
      title: fileName,
      content: '',
      fileName,
      filePath,
      createdAt: Date.now(),
    });

    index++;
  }

  return artifacts;
}

const FILE_LINK_RE = /\[([^\]]+)\]\(file:\/\/([^)]+)\)/g;
const REMOTE_MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const REMOTE_IMAGE_URL_RE = /(?:^|[\s<("'`])(https?:\/\/[^\s<>"'`)]*\.(?:png|jpe?g|gif|webp|bmp|avif)(?:\?[^\s<>"'`)]*)?)(?:[\s>)"'`]|$)/gi;

export function stripFileLinksFromText(text: string): string {
  return text.replace(/\[([^\]]+)\]\(file:\/\/([^)]+)\)/g, '');
}

const BARE_FILE_PATH_RE = /(?:^|[\s"'`(])(\/?(?:[^\s"'`()\[\]]+\/)+[^\s"'`()\[\]]+\.(?:png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|docx|xlsx|pptx|pdf|md|txt|log|csv))(?:[\s"'`)]|$)/gm;

export function parseFilePathsFromText(
  messageContent: string,
  messageId: string,
  sessionId: string,
  idPrefix = 'artifact-path',
): Artifact[] {
  if (!messageContent) return [];

  const artifacts: Artifact[] = [];
  const re = new RegExp(BARE_FILE_PATH_RE.source, 'gm');
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = re.exec(messageContent)) !== null) {
    const filePath = normalizeArtifactFilePath(match[1]);

    const ext = getFileExtension(filePath);
    const artifactType = getArtifactTypeFromExtension(ext);
    if (!artifactType) continue;

    const fileName = getFileName(filePath);

    artifacts.push({
      id: `${idPrefix}-${messageId}-${index}`,
      messageId,
      sessionId,
      type: artifactType,
      title: fileName,
      content: '',
      fileName,
      filePath,
      createdAt: Date.now(),
    });

    index++;
  }

  return artifacts;
}

export function parseFileLinksFromMessage(
  messageContent: string,
  messageId: string,
  sessionId: string,
): Artifact[] {
  if (!messageContent) return [];

  const artifacts: Artifact[] = [];
  const re = new RegExp(FILE_LINK_RE.source, 'g');
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = re.exec(messageContent)) !== null) {
    const linkText = match[1];
    let filePath: string;
    try {
      filePath = normalizeArtifactFilePath(decodeURIComponent(match[2]));
    } catch {
      filePath = normalizeArtifactFilePath(match[2]);
    }
    const ext = getFileExtension(filePath);
    const artifactType = getArtifactTypeFromExtension(ext);
    if (!artifactType) continue;

    const fileName = getFileName(filePath);

    artifacts.push({
      id: `artifact-link-${messageId}-${index}`,
      messageId,
      sessionId,
      type: artifactType,
      title: linkText || fileName,
      content: '',
      fileName,
      filePath,
      createdAt: Date.now(),
    });

    index++;
  }

  return artifacts;
}

export function parseRemoteImageArtifactsFromText(
  messageContent: string,
  messageId: string,
  sessionId: string,
  idPrefix = 'artifact-remote-image',
): Artifact[] {
  if (!messageContent) return [];

  const artifacts: Artifact[] = [];
  const seen = new Set<string>();
  let index = 0;

  const pushImage = (url: string, title?: string) => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl || seen.has(trimmedUrl)) return;
    seen.add(trimmedUrl);
    artifacts.push({
      id: `${idPrefix}-${messageId}-${index++}`,
      messageId,
      sessionId,
      type: 'image',
      title: title?.trim() || `Generated image ${index}`,
      content: trimmedUrl,
      fileName: title?.trim() || `generated-image-${index}`,
      source: 'tool',
      createdAt: Date.now(),
    });
  };

  const markdownRe = new RegExp(REMOTE_MARKDOWN_IMAGE_RE.source, 'g');
  let markdownMatch: RegExpExecArray | null;
  while ((markdownMatch = markdownRe.exec(messageContent)) !== null) {
    pushImage(markdownMatch[2], markdownMatch[1]);
  }

  const bareUrlRe = new RegExp(REMOTE_IMAGE_URL_RE.source, 'gi');
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = bareUrlRe.exec(messageContent)) !== null) {
    pushImage(urlMatch[1]);
  }

  return artifacts;
}

export function parseToolResultMediaArtifacts(
  toolResultMsg: CoworkMessage | undefined,
  sessionId: string,
): Artifact[] {
  if (!toolResultMsg?.metadata || toolResultMsg.metadata.isError) return [];

  const details = toolResultMsg.metadata.toolResultDetails;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];

  const assets = (details as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return [];

  const artifacts: Artifact[] = [];
  for (let index = 0; index < assets.length; index++) {
    const asset = assets[index];
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) continue;
    const item = asset as Record<string, unknown>;
    if (item.type !== 'image' && item.type !== 'video') continue;
    const artifactType: ArtifactType = item.type === 'video' ? 'video' : 'image';

    const url = typeof item.url === 'string' && item.url.trim()
      ? item.url.trim()
      : '';
    const filePath = typeof item.filePath === 'string' && item.filePath.trim()
      ? normalizeArtifactFilePath(item.filePath)
      : typeof item.localPath === 'string' && item.localPath.trim()
        ? normalizeArtifactFilePath(item.localPath)
        : '';
    if (artifactType === 'video' && !filePath) continue;
    if (!url && !filePath) continue;

    const filename = typeof item.filename === 'string' && item.filename.trim()
      ? item.filename.trim()
      : filePath
        ? getFileName(filePath)
        : `generated-${artifactType}-${index + 1}`;

    artifacts.push({
      id: `artifact-media-${toolResultMsg.id}-${index}`,
      messageId: toolResultMsg.id,
      sessionId,
      type: artifactType,
      title: filename,
      content: filePath ? '' : url,
      fileName: filename,
      ...(filePath ? { filePath } : {}),
      ...(filePath && url ? { remoteUrl: url } : {}),
      source: 'tool',
      createdAt: toolResultMsg.timestamp || Date.now(),
    });
  }

  return artifacts;
}

const WRITE_TOOL_NAMES = new Set(['write', 'writefile', 'write_file']);

/**
 * Tool names whose tool_result content may contain bare file paths that should
 * be detected as artifacts. Other tools (e.g. Bash running `find` / `ls`) can
 * produce file listings in their output which should NOT become artifacts.
 */
const IMAGE_GEN_TOOL_NAMES_FOR_PATH_DETECTION = new Set([
  'image_generate',
  'lobsterai_image_generate',
]);

export function shouldParseFilePathsFromToolResult(toolName: string | undefined | null): boolean {
  if (!toolName) return false;
  return IMAGE_GEN_TOOL_NAMES_FOR_PATH_DETECTION.has(toolName.toLowerCase());
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[_\s]/g, '');
}

function extractFilePath(toolInput: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'path', 'filePath', 'target_file', 'targetFile']) {
    const val = toolInput[key];
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  return null;
}

function getFileExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filePath.slice(lastDot).toLowerCase();
}

function getFileName(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
}

export function parseToolArtifact(
  toolUseMsg: CoworkMessage,
  toolResultMsg: CoworkMessage | undefined,
  sessionId: string,
): Artifact | null {
  const toolName = toolUseMsg.metadata?.toolName;
  if (!toolName || !WRITE_TOOL_NAMES.has(normalizeToolName(toolName))) {
    return null;
  }

  if (toolResultMsg?.metadata?.isError) {
    return null;
  }

  const toolInput = toolUseMsg.metadata?.toolInput as Record<string, unknown> | undefined;
  if (!toolInput) return null;

  const rawFilePath = extractFilePath(toolInput);
  const filePath = rawFilePath ? normalizeArtifactFilePath(rawFilePath) : null;
  if (!filePath) return null;

  const ext = getFileExtension(filePath);
  const artifactType = getArtifactTypeFromExtension(ext);
  if (!artifactType) return null;

  const fileName = getFileName(filePath);
  const isImage = isImageExtension(ext);
  const isVideo = isVideoExtension(ext);
  const isBinaryDoc = isBinaryDocumentExtension(ext);
  const content = (isImage || isVideo || isBinaryDoc) ? '' : (typeof toolInput.content === 'string' ? toolInput.content : '');

  return {
    id: `artifact-tool-${toolUseMsg.id}`,
    messageId: toolUseMsg.id,
    sessionId,
    type: artifactType,
    title: fileName,
    content,
    fileName,
    filePath,
    createdAt: toolUseMsg.timestamp || Date.now(),
  };
}
