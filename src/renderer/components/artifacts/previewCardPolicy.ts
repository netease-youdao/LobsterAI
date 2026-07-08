import { i18nService } from '@/services/i18n';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

export const PreviewCardDisplayKind = {
  Website: 'website',
  Document: 'document',
  Spreadsheet: 'spreadsheet',
  Presentation: 'presentation',
  Image: 'image',
  Video: 'video',
  Diagram: 'diagram',
  Code: 'code',
  Text: 'text',
  File: 'file',
} as const;
export type PreviewCardDisplayKind = typeof PreviewCardDisplayKind[keyof typeof PreviewCardDisplayKind];

export const PreviewCardOpenAction = {
  Browser: 'browser',
  Preview: 'preview',
} as const;
export type PreviewCardOpenAction = typeof PreviewCardOpenAction[keyof typeof PreviewCardOpenAction];

export interface PreviewCardDescriptor {
  displayKind: PreviewCardDisplayKind;
  title: string;
  subtitle: string;
  hoverSubtitle: string;
  iconFileName: string;
  supportsOpenMenu: boolean;
  defaultOpenAction: PreviewCardOpenAction;
}

const t = (key: string) => i18nService.t(key);

const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv', 'tsv']);
const PRESENTATION_EXTENSIONS = new Set(['pptx', 'ppt']);
const DOCUMENT_EXTENSIONS = new Set(['md', 'pdf', 'docx', 'doc', 'rtf', 'odt']);

function normalizeLocalFilePath(filePath: string): string {
  let normalized = filePath.trim();
  if (normalized.startsWith('file:///')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file://')) {
    normalized = normalized.slice(7);
  } else if (normalized.startsWith('file:/')) {
    normalized = normalized.slice(5);
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function getBaseName(value: string | undefined): string {
  if (!value) return '';
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  const normalized = normalizeLocalFilePath(withoutQuery);
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

function getExtension(value: string | undefined): string {
  const baseName = getBaseName(value);
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === baseName.length - 1) return '';
  return baseName.slice(dotIndex + 1).toLowerCase();
}

function getPreferredFileName(artifact: Artifact): string {
  return artifact.fileName || getBaseName(artifact.filePath) || getBaseName(artifact.url) || artifact.title || t('artifactFileKindFile');
}

function formatSubtitle(kindKey: string, extension: string): string {
  const kind = t(kindKey);
  return extension ? `${kind} · ${extension.toUpperCase()}` : kind;
}

function isHtmlFileTitle(title: string, fileName: string): boolean {
  const normalizedTitle = title.trim().toLowerCase();
  const normalizedFileName = fileName.trim().toLowerCase();
  return normalizedTitle === normalizedFileName ||
    normalizedTitle.endsWith('.html') ||
    normalizedTitle.endsWith('.htm') ||
    normalizedTitle.includes('/') ||
    normalizedTitle.includes('\\');
}

function getWebsiteTitle(artifact: Artifact, fileName: string): string {
  const title = artifact.title.trim();
  if (title && !isHtmlFileTitle(title, fileName)) {
    return title;
  }
  return fileName || title || t('artifactFileKindWebsite');
}

function getDisplayKind(artifact: Artifact, extension: string): PreviewCardDisplayKind {
  if (artifact.type === ArtifactTypeValue.Html || artifact.type === ArtifactTypeValue.LocalService) {
    return PreviewCardDisplayKind.Website;
  }
  if (artifact.type === ArtifactTypeValue.Image || artifact.type === ArtifactTypeValue.Svg) {
    return PreviewCardDisplayKind.Image;
  }
  if (artifact.type === ArtifactTypeValue.Video) {
    return PreviewCardDisplayKind.Video;
  }
  if (artifact.type === ArtifactTypeValue.Mermaid) {
    return PreviewCardDisplayKind.Diagram;
  }
  if (artifact.type === ArtifactTypeValue.Code) {
    return PreviewCardDisplayKind.Code;
  }
  if (artifact.type === ArtifactTypeValue.Text) {
    return PreviewCardDisplayKind.Text;
  }
  if (artifact.type === ArtifactTypeValue.Markdown) {
    return PreviewCardDisplayKind.Document;
  }
  if (SPREADSHEET_EXTENSIONS.has(extension)) {
    return PreviewCardDisplayKind.Spreadsheet;
  }
  if (PRESENTATION_EXTENSIONS.has(extension)) {
    return PreviewCardDisplayKind.Presentation;
  }
  if (artifact.type === ArtifactTypeValue.Document || DOCUMENT_EXTENSIONS.has(extension)) {
    return PreviewCardDisplayKind.Document;
  }
  return PreviewCardDisplayKind.File;
}

function getKindKey(displayKind: PreviewCardDisplayKind): string {
  switch (displayKind) {
    case PreviewCardDisplayKind.Website:
      return 'artifactFileKindWebsite';
    case PreviewCardDisplayKind.Document:
      return 'artifactFileKindDocument';
    case PreviewCardDisplayKind.Spreadsheet:
      return 'artifactFileKindSpreadsheet';
    case PreviewCardDisplayKind.Presentation:
      return 'artifactFileKindPresentation';
    case PreviewCardDisplayKind.Image:
      return 'artifactFileKindImage';
    case PreviewCardDisplayKind.Video:
      return 'artifactFileKindVideo';
    case PreviewCardDisplayKind.Diagram:
      return 'artifactFileKindDiagram';
    case PreviewCardDisplayKind.Code:
      return 'artifactFileKindCode';
    case PreviewCardDisplayKind.Text:
      return 'artifactFileKindText';
    case PreviewCardDisplayKind.File:
    default:
      return 'artifactFileKindFile';
  }
}

export function getPreviewCardDescriptor(artifact: Artifact): PreviewCardDescriptor {
  const fileName = getPreferredFileName(artifact);
  const extension = getExtension(fileName);
  const displayKind = getDisplayKind(artifact, extension);
  const isWebsite = displayKind === PreviewCardDisplayKind.Website;
  const title = isWebsite ? getWebsiteTitle(artifact, fileName) : fileName;
  const subtitle = isWebsite
    ? t('artifactFileKindWebsite')
    : formatSubtitle(getKindKey(displayKind), extension);
  const defaultOpenAction = isWebsite ? PreviewCardOpenAction.Browser : PreviewCardOpenAction.Preview;
  const hoverSubtitle = defaultOpenAction === PreviewCardOpenAction.Browser
    ? t('artifactPreviewCardOpenInLobsterBrowser')
    : t('artifactPreviewCardOpenPreview');

  return {
    displayKind,
    title,
    subtitle,
    hoverSubtitle,
    iconFileName: fileName,
    supportsOpenMenu: Boolean(
      artifact.filePath ||
        (artifact.type === ArtifactTypeValue.LocalService && (artifact.url || artifact.content)),
    ),
    defaultOpenAction,
  };
}
