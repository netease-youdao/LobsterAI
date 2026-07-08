import { LogReporterAction, reportYdAnalyzer } from '@/services/logReporter';
import type { Artifact } from '@/types/artifact';

type ArtifactAnalyticsValue = string | number | boolean | null | undefined;

const bucketLength = (length: number): string => {
  if (length <= 0) return '0';
  if (length <= 100) return '1_100';
  if (length <= 500) return '101_500';
  if (length <= 2000) return '501_2000';
  if (length <= 10000) return '2001_10000';
  return '10000_plus';
};

const getFileExtension = (artifact: Artifact): string | undefined => {
  const value = artifact.fileName || artifact.filePath || artifact.title;
  const lastSegment = value.split(/[\\/]/).pop()?.split('?')[0]?.split('#')[0] ?? '';
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === lastSegment.length - 1) return undefined;
  return lastSegment.slice(dotIndex + 1).toLowerCase();
};

const getBrowserUrlType = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'about:blank') return 'blank';
  if (normalized.startsWith('file:')) return 'local_file';
  if (
    normalized.includes('localhost') ||
    normalized.includes('127.0.0.1') ||
    normalized.includes('[::1]')
  ) {
    return 'localhost';
  }
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return 'external_url';
  }
  return 'other';
};

const logArtifactAnalytics = (actionType: string): void => {
  const message = `Reporting artifact preview action: ${actionType}.`;
  console.debug(`[ArtifactAnalytics] ${message}`);
  window.electron?.log?.fromRenderer?.('debug', 'ArtifactAnalytics', message);
};

export const getArtifactAnalyticsParams = (
  artifact: Artifact | null | undefined,
): Record<string, ArtifactAnalyticsValue> => {
  if (!artifact) return {};
  const titleLength = (artifact.fileName || artifact.title || '').length;
  const contentLength = artifact.content?.length ?? 0;
  return {
    artifactType: artifact.type,
    artifactSource: artifact.source,
    artifactTitleLength: titleLength,
    artifactTitleLengthBucket: bucketLength(titleLength),
    fileExtension: getFileExtension(artifact),
    hasFilePath: Boolean(artifact.filePath),
    hasUrl: Boolean(artifact.url || artifact.remoteUrl),
    hasContent: Boolean(artifact.content),
    contentLengthBucket: bucketLength(contentLength),
    isWebsite: artifact.type === 'html' || artifact.type === 'local-service',
  };
};

export interface ReportArtifactPreviewActionOptions {
  actionType: string;
  source: 'conversation_artifact_card' | 'artifact_panel' | 'artifact_browser';
  artifact?: Artifact | null;
  params?: Record<string, ArtifactAnalyticsValue>;
}

export const reportArtifactPreviewAction = (options: ReportArtifactPreviewActionOptions): void => {
  logArtifactAnalytics(options.actionType);
  void reportYdAnalyzer({
    action: LogReporterAction.ArtifactPreviewAction,
    source: options.source,
    actionType: options.actionType,
    ...getArtifactAnalyticsParams(options.artifact),
    ...options.params,
  });
};

export const getArtifactBrowserUrlType = getBrowserUrlType;
