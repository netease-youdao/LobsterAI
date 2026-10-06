import type { LocalWebService } from '@shared/localWebServices/constants';

import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import { isArtifactFileShareable } from './artifactFileSharePolicy';

export const ArtifactToolbarPublishActionKind = {
  Share: 'share',
  Deploy: 'deploy',
} as const;

export type ArtifactToolbarPublishActionKind =
  (typeof ArtifactToolbarPublishActionKind)[keyof typeof ArtifactToolbarPublishActionKind];

export interface ArtifactToolbarShareTarget {
  kind: typeof ArtifactToolbarPublishActionKind.Share;
  artifact: Artifact;
}

export interface ArtifactToolbarDeployTarget {
  kind: typeof ArtifactToolbarPublishActionKind.Deploy;
  localService: LocalWebService;
}

export type ArtifactToolbarPublishTarget =
  | ArtifactToolbarShareTarget
  | ArtifactToolbarDeployTarget;

export function resolveArtifactPreviewToolbarPublishTarget(
  artifact: Artifact | null | undefined,
  shareAvailable: boolean,
): ArtifactToolbarShareTarget | null {
  if (!shareAvailable || !artifact || !isArtifactFileShareable(artifact)) return null;
  return {
    kind: ArtifactToolbarPublishActionKind.Share,
    artifact,
  };
}

export function resolveBrowserToolbarPublishTarget(input: {
  htmlArtifact?: Artifact | null;
  localService?: LocalWebService | null;
  shareAvailable: boolean;
}): ArtifactToolbarPublishTarget | null {
  // Managed HTML previews use an internal loopback preview server. Preserve
  // the Artifact identity instead of mistaking that server for a deployable app.
  if (input.htmlArtifact) {
    if (input.htmlArtifact.type !== ArtifactTypeValue.Html) return null;
    return resolveArtifactPreviewToolbarPublishTarget(
      input.htmlArtifact,
      input.shareAvailable,
    );
  }
  if (!input.localService) return null;
  return {
    kind: ArtifactToolbarPublishActionKind.Deploy,
    localService: input.localService,
  };
}
