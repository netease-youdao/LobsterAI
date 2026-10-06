import crypto from 'crypto';
import path from 'path';

import { HtmlShareSourceType, type HtmlShareSourceType as HtmlShareSourceTypeValue } from '../../../shared/htmlShare/constants';

const safeDecodeFilePath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const normalizeHtmlShareSourceFilePath = (filePath: string): string => {
  let normalized = filePath.trim();
  if (/^file:\/\//i.test(normalized)) {
    normalized = safeDecodeFilePath(normalized.replace(/^file:\/\//i, ''));
  }
  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  return path.resolve(normalized).replace(/\\/g, '/').toLowerCase();
};

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

export const buildHtmlShareClientSourceKey = (filePath: string): string => (
  sha256(`${HtmlShareSourceType.HtmlFile}:${normalizeHtmlShareSourceFilePath(filePath)}`)
);

export const buildArtifactFileClientSourceKey = (
  sourceType: HtmlShareSourceTypeValue,
  filePath: string,
): string => sha256(`${sourceType}:file:${normalizeHtmlShareSourceFilePath(filePath)}`);

export const buildArtifactIdentityClientSourceKey = (
  sourceType: HtmlShareSourceTypeValue,
  sessionId: string,
  artifactId: string,
): string => sha256(`${sourceType}:artifact:${sessionId}:${artifactId}`);
