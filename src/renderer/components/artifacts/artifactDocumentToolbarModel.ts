import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

export interface ArtifactDocumentToolbarModelInput {
  artifact: Pick<Artifact, 'filePath' | 'type'>;
  canShare: boolean;
  canDownload: boolean;
  canCopy: boolean;
  canRefresh: boolean;
  hasCodeControls: boolean;
  hasZoomControls: boolean;
  canOpenFileList: boolean;
}

export interface ArtifactDocumentToolbarModel {
  showShareButton: boolean;
  showDownloadButton: boolean;
  showCopyInMenu: boolean;
  showRefreshInMenu: boolean;
  showRevealInFolderInMenu: boolean;
  hasMenuActions: boolean;
  showMoreMenu: boolean;
  showFileListButton: boolean;
}

export interface InlineArtifactDownloadDescriptor {
  fileName: string;
  mimeType: string;
  content: string;
  isDataUrl: boolean;
}

const INVALID_FILENAME_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f]/g;
const DATA_URL_MIME_RE = /^data:([^;,]+)[;,]/i;

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

const CODE_LANGUAGE_EXTENSION_MAP: Record<string, string> = {
  bash: '.sh',
  c: '.c',
  cpp: '.cpp',
  css: '.css',
  go: '.go',
  html: '.html',
  java: '.java',
  javascript: '.js',
  js: '.js',
  json: '.json',
  jsx: '.jsx',
  kotlin: '.kt',
  markdown: '.md',
  md: '.md',
  py: '.py',
  python: '.py',
  ruby: '.rb',
  rust: '.rs',
  sh: '.sh',
  shell: '.sh',
  sql: '.sql',
  svg: '.svg',
  swift: '.swift',
  toml: '.toml',
  ts: '.ts',
  tsx: '.tsx',
  typescript: '.ts',
  xml: '.xml',
  yaml: '.yml',
  yml: '.yml',
};

function hasFileExtension(name: string): boolean {
  const dotIndex = name.lastIndexOf('.');
  return dotIndex > 0 && dotIndex < name.length - 1;
}

function sanitizeDownloadFileName(fileName: string | undefined, title: string | undefined): string {
  const fromFileName = fileName?.trim()
    ? fileName.trim().split(/[\\/]/).pop()
    : undefined;
  const raw = fromFileName || title || '';
  const sanitized = raw.replace(INVALID_FILENAME_CHARS_RE, '_').trim();
  return sanitized || 'artifact';
}

function getDefaultInlineFileMeta(
  artifact: Pick<Artifact, 'type' | 'language'>,
): { extension: string; mimeType: string } {
  switch (artifact.type) {
    case ArtifactTypeValue.Html:
      return { extension: '.html', mimeType: 'text/html;charset=utf-8' };
    case ArtifactTypeValue.Svg:
      return { extension: '.svg', mimeType: 'image/svg+xml;charset=utf-8' };
    case ArtifactTypeValue.Mermaid:
      return { extension: '.mmd', mimeType: 'text/plain;charset=utf-8' };
    case ArtifactTypeValue.Markdown:
      return { extension: '.md', mimeType: 'text/markdown;charset=utf-8' };
    case ArtifactTypeValue.Code: {
      const normalizedLang = artifact.language?.trim().toLowerCase() ?? '';
      return {
        extension: CODE_LANGUAGE_EXTENSION_MAP[normalizedLang] ?? '.txt',
        mimeType: 'text/plain;charset=utf-8',
      };
    }
    case ArtifactTypeValue.Text:
    default:
      return { extension: '.txt', mimeType: 'text/plain;charset=utf-8' };
  }
}

export function canDownloadArtifact(
  artifact: Pick<Artifact, 'filePath' | 'type' | 'content'> | null | undefined,
): boolean {
  if (!artifact || artifact.type === ArtifactTypeValue.LocalService) {
    return false;
  }
  if (artifact.filePath?.trim()) {
    return true;
  }
  return Boolean(artifact.content);
}

export function buildInlineArtifactDownload(
  artifact: Pick<Artifact, 'type' | 'title' | 'fileName' | 'content' | 'language'>,
): InlineArtifactDownloadDescriptor | null {
  if (!artifact.content || artifact.type === ArtifactTypeValue.LocalService) {
    return null;
  }

  const baseName = sanitizeDownloadFileName(artifact.fileName, artifact.title);

  if (artifact.type === ArtifactTypeValue.Image && artifact.content.startsWith('data:')) {
    const mimeMatch = DATA_URL_MIME_RE.exec(artifact.content);
    const mimeType = mimeMatch?.[1]?.toLowerCase() ?? 'application/octet-stream';
    const extension = MIME_EXTENSION_MAP[mimeType] ?? '.png';
    return {
      fileName: hasFileExtension(baseName) ? baseName : `${baseName}${extension}`,
      mimeType,
      content: artifact.content,
      isDataUrl: true,
    };
  }

  const { extension, mimeType } = getDefaultInlineFileMeta(artifact);
  return {
    fileName: hasFileExtension(baseName) ? baseName : `${baseName}${extension}`,
    mimeType,
    content: artifact.content,
    isDataUrl: false,
  };
}

export function resolveArtifactDocumentToolbarModel({
  artifact,
  canShare,
  canDownload,
  canCopy,
  canRefresh,
  hasCodeControls,
  hasZoomControls,
  canOpenFileList,
}: ArtifactDocumentToolbarModelInput): ArtifactDocumentToolbarModel {
  const isLocalFile = Boolean(
    artifact.filePath && artifact.type !== ArtifactTypeValue.LocalService,
  );
  const showCopyInMenu = Boolean(canCopy && !hasCodeControls);
  const showRefreshInMenu = Boolean(canRefresh);
  const showRevealInFolderInMenu = isLocalFile;
  const hasMenuActions = showCopyInMenu || showRefreshInMenu || showRevealInFolderInMenu;

  return {
    showShareButton: Boolean(canShare),
    showDownloadButton: Boolean(canDownload),
    showCopyInMenu,
    showRefreshInMenu,
    showRevealInFolderInMenu,
    hasMenuActions,
    showMoreMenu: hasMenuActions || Boolean(hasZoomControls),
    showFileListButton: Boolean(canOpenFileList),
  };
}
