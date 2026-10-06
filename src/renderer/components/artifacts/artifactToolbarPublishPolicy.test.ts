import type { LocalWebService } from '@shared/localWebServices/constants';
import { describe, expect, test } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import {
  ArtifactToolbarPublishActionKind,
  resolveArtifactPreviewToolbarPublishTarget,
  resolveBrowserToolbarPublishTarget,
} from './artifactToolbarPublishPolicy';

const makeArtifact = (
  type: Artifact['type'],
  overrides: Partial<Artifact> = {},
): Artifact => ({
  id: 'artifact-1',
  messageId: 'message-1',
  sessionId: 'session-1',
  type,
  title: 'Artifact title',
  content: '',
  createdAt: 1,
  ...overrides,
});

const localService: LocalWebService = {
  id: 'localhost:5175',
  title: 'Local app',
  url: 'http://localhost:5175',
  host: 'localhost',
  port: 5175,
  online: true,
};

describe('artifactToolbarPublishPolicy', () => {
  test('shares a shareable Artifact in the regular preview toolbar', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Image, {
      filePath: '/tmp/image.png',
    });

    expect(resolveArtifactPreviewToolbarPublishTarget(artifact, true)).toEqual({
      kind: ArtifactToolbarPublishActionKind.Share,
      artifact,
    });
  });

  test('does not expose sharing without a controller or shareable source', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Image, {
      filePath: '/tmp/image.png',
    });

    expect(resolveArtifactPreviewToolbarPublishTarget(artifact, false)).toBeNull();
    expect(
      resolveArtifactPreviewToolbarPublishTarget(
        makeArtifact(ArtifactTypeValue.Text, { content: 'text' }),
        true,
      ),
    ).toBeNull();
  });

  test('shares a managed HTML preview instead of deploying its loopback preview server', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Html, {
      filePath: '/tmp/index.html',
    });

    expect(resolveBrowserToolbarPublishTarget({
      htmlArtifact: artifact,
      localService,
      shareAvailable: true,
    })).toEqual({
      kind: ArtifactToolbarPublishActionKind.Share,
      artifact,
    });
  });

  test('does not deploy an unshareable managed HTML preview', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Html, {
      content: '<h1>Inline preview</h1>',
    });

    expect(resolveBrowserToolbarPublishTarget({
      htmlArtifact: artifact,
      localService,
      shareAvailable: true,
    })).toBeNull();
  });

  test('deploys a local service when no managed HTML preview is active', () => {
    expect(resolveBrowserToolbarPublishTarget({
      localService,
      shareAvailable: true,
    })).toEqual({
      kind: ArtifactToolbarPublishActionKind.Deploy,
      localService,
    });
  });

  test('does not expose an action for an ordinary browser page', () => {
    expect(resolveBrowserToolbarPublishTarget({
      shareAvailable: true,
    })).toBeNull();
  });
});
