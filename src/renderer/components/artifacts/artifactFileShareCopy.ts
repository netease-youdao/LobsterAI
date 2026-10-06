import {
  HtmlShareAccessMode,
  type HtmlShareAccessMode as HtmlShareAccessModeValue,
  type HtmlShareConfigurableStatus,
} from '@shared/htmlShare/constants';

export const ArtifactFileShareCopyUnavailableReason = {
  MissingUrl: 'missing_url',
  MissingShareCode: 'missing_share_code',
} as const;

export type ArtifactFileShareCopyUnavailableReason =
  (typeof ArtifactFileShareCopyUnavailableReason)[keyof typeof ArtifactFileShareCopyUnavailableReason];

export interface ArtifactFileShareCopyLabels {
  link: string;
  shareCode: string;
}

export interface ArtifactFileShareCopyInput {
  accessMode: HtmlShareAccessModeValue;
  labels: ArtifactFileShareCopyLabels;
  shareCode?: string | null;
  status?: HtmlShareConfigurableStatus;
  url?: string | null;
}

export type ArtifactFileShareCopyResult =
  | {
      copyable: true;
      text: string;
    }
  | {
      copyable: false;
      reason: ArtifactFileShareCopyUnavailableReason;
      text: null;
    };

export function buildArtifactFileShareCopyText({
  accessMode,
  labels,
  shareCode,
  url,
}: ArtifactFileShareCopyInput): ArtifactFileShareCopyResult {
  const normalizedUrl = url?.trim();
  if (!normalizedUrl) {
    return {
      copyable: false,
      reason: ArtifactFileShareCopyUnavailableReason.MissingUrl,
      text: null,
    };
  }

  if (accessMode === HtmlShareAccessMode.Public) {
    return {
      copyable: true,
      text: normalizedUrl,
    };
  }

  const normalizedShareCode = shareCode?.trim();
  if (!normalizedShareCode) {
    return {
      copyable: false,
      reason: ArtifactFileShareCopyUnavailableReason.MissingShareCode,
      text: null,
    };
  }

  return {
    copyable: true,
    text: `${labels.link}: ${normalizedUrl}\n${labels.shareCode}: ${normalizedShareCode}`,
  };
}
