import { expect, test } from 'vitest';

import { ShareDeploymentCandidateSource } from '../../../shared/shareDeployment/constants';
import { type Artifact, ArtifactTypeValue } from '../../types/artifact';
import type { RootState } from '..';
import artifactReducer, {
  addArtifact,
  addLinkedFileArtifact,
  openArtifactPreviewTab,
  selectSessionArtifacts,
  setSessionArtifacts,
  updateLocalServiceProjectMetadata,
} from './artifactSlice';

const makeVideoArtifact = (id: string, filePath: string, messageId = 'message-1'): Artifact => ({
  id,
  messageId,
  sessionId: 'session-1',
  type: 'video',
  title: 'generated-video-20260522-171920-1.mp4',
  content: '',
  fileName: 'generated-video-20260522-171920-1.mp4',
  filePath,
  createdAt: 1,
});

const makeLocalServiceArtifact = (
  id: string,
  url: string,
  projectDirectory?: string,
  createdAt = 1,
): Artifact => ({
  id,
  messageId: 'message-1',
  sessionId: 'session-1',
  type: ArtifactTypeValue.LocalService,
  title: 'localhost:3000',
  content: url,
  url,
  createdAt,
  localService: {
    url,
    origin: 'http://localhost:3000',
    ...(projectDirectory ? { projectDirectory } : {}),
  },
});

const makeImageArtifact = (
  id: string,
  overrides: Partial<Artifact> = {},
): Artifact => ({
  id,
  messageId: 'message-1',
  sessionId: 'session-1',
  type: ArtifactTypeValue.Image,
  title: 'generated-image.png',
  content: overrides.content ?? '',
  fileName: 'generated-image.png',
  createdAt: 1,
  ...overrides,
});

test('setSessionArtifacts dedupes generated videos by file path within one message', () => {
  const state = artifactReducer(undefined, setSessionArtifacts({
    sessionId: 'session-1',
    artifacts: [
      makeVideoArtifact('video-file-url', 'file:///Users/admin/work/test0522/generated-video-20260522-171920-1.mp4'),
      makeVideoArtifact('video-local-path', '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4'),
    ],
  }));

  expect(state.artifactsBySession['session-1']).toHaveLength(1);
  expect(state.artifactsBySession['session-1'][0].id).toBe('video-local-path');
});

test('addArtifact keeps same file path cards from different messages', () => {
  let state = artifactReducer(undefined, addArtifact({
    sessionId: 'session-1',
    artifact: makeVideoArtifact(
      'video-first-reply',
      '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4',
      'message-first-reply',
    ),
  }));

  state = artifactReducer(state, addArtifact({
    sessionId: 'session-1',
    artifact: makeVideoArtifact(
      'video-second-reply',
      '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4',
      'message-second-reply',
    ),
  }));

  expect(state.artifactsBySession['session-1']).toHaveLength(2);
});

test('addArtifact keeps one local service per port and prefers detected project directory', () => {
  let state = artifactReducer(undefined, addArtifact({
    sessionId: 'session-1',
    artifact: makeLocalServiceArtifact(
      'default-project-service',
      'http://localhost:3000',
      '/Users/admin/project',
      2,
    ),
    defaultProjectDirectory: '/Users/admin/project',
  }));

  state = artifactReducer(state, addArtifact({
    sessionId: 'session-1',
    artifact: makeLocalServiceArtifact(
      'detected-project-service',
      'http://127.0.0.1:3000/app',
      '/Users/admin/project/ai-datacenter',
      1,
    ),
    defaultProjectDirectory: '/Users/admin/project',
  }));

  expect(state.artifactsBySession['session-1']).toHaveLength(1);
  expect(state.artifactsBySession['session-1'][0].id).toBe('detected-project-service');
});

test('updateLocalServiceProjectMetadata writes the shared preview and deployment directory', () => {
  const artifact = makeLocalServiceArtifact('service', 'http://localhost:3000');
  let state = artifactReducer(undefined, addArtifact({
    sessionId: 'session-1',
    artifact,
  }));

  state = artifactReducer(state, updateLocalServiceProjectMetadata({
    sessionId: 'session-1',
    artifactId: artifact.id,
    projectDirectory: '/Users/admin/project/resolved-app',
    projectCandidates: [{
      directory: '/Users/admin/project/resolved-app',
      source: ShareDeploymentCandidateSource.ProcessCwd,
      confidence: 95,
    }],
  }));

  expect(state.artifactsBySession['session-1'][0].localService).toEqual(expect.objectContaining({
    projectDirectory: '/Users/admin/project/resolved-app',
    projectCandidates: [expect.objectContaining({
      source: ShareDeploymentCandidateSource.ProcessCwd,
    })],
  }));
});

test('addArtifact preserves an asynchronously resolved local service directory', () => {
  const artifact = makeLocalServiceArtifact('service', 'http://localhost:3000');
  let state = artifactReducer(undefined, addArtifact({
    sessionId: 'session-1',
    artifact,
  }));
  state = artifactReducer(state, updateLocalServiceProjectMetadata({
    sessionId: 'session-1',
    artifactId: artifact.id,
    projectDirectory: '/Users/admin/project/resolved-app',
    projectCandidates: [{
      directory: '/Users/admin/project/resolved-app',
      source: ShareDeploymentCandidateSource.ProcessCwd,
      confidence: 95,
    }],
  }));
  state = artifactReducer(state, addArtifact({
    sessionId: 'session-1',
    artifact: makeLocalServiceArtifact('service', 'http://localhost:3000'),
  }));

  expect(state.artifactsBySession['session-1'][0].localService?.projectDirectory).toBe(
    '/Users/admin/project/resolved-app',
  );
});

test('addArtifact preserves an artifact metadata directory when context is unchanged', () => {
  const artifact = makeLocalServiceArtifact(
    'service',
    'http://localhost:3000',
    '/Users/admin/project/context-app',
  );
  const contextCandidate = {
    directory: '/Users/admin/project/context-app',
    source: ShareDeploymentCandidateSource.ToolCdCommand,
    confidence: 94,
    messageId: 'bash-context',
  };
  artifact.localService!.projectCandidates = [contextCandidate];
  let state = artifactReducer(undefined, addArtifact({ sessionId: 'session-1', artifact }));
  state = artifactReducer(state, updateLocalServiceProjectMetadata({
    sessionId: 'session-1',
    artifactId: artifact.id,
    projectDirectory: '/Users/admin/project/selected-app',
    projectCandidates: [{
      directory: '/Users/admin/project/selected-app',
      source: ShareDeploymentCandidateSource.ArtifactMetadata,
      confidence: 96,
    }, contextCandidate],
  }));

  const reparsedArtifact = makeLocalServiceArtifact(
    'service',
    'http://localhost:3000',
    '/Users/admin/project/context-app',
  );
  reparsedArtifact.localService!.projectCandidates = [contextCandidate];
  state = artifactReducer(state, addArtifact({
    sessionId: 'session-1',
    artifact: reparsedArtifact,
  }));

  expect(state.artifactsBySession['session-1'][0].localService).toEqual(expect.objectContaining({
    projectDirectory: '/Users/admin/project/selected-app',
    projectCandidates: [expect.objectContaining({
      source: ShareDeploymentCandidateSource.ArtifactMetadata,
    }), contextCandidate],
  }));
});

test('addArtifact accepts newly discovered context instead of preserving a stale workspace fallback', () => {
  const artifact = makeLocalServiceArtifact('service', 'http://localhost:3000');
  let state = artifactReducer(undefined, addArtifact({ sessionId: 'session-1', artifact }));
  state = artifactReducer(state, updateLocalServiceProjectMetadata({
    sessionId: 'session-1',
    artifactId: artifact.id,
    projectDirectory: '/Users/admin/project',
    projectCandidates: [{
      directory: '/Users/admin/project',
      source: ShareDeploymentCandidateSource.Workspace,
      confidence: 60,
    }],
  }));
  const enrichedArtifact = makeLocalServiceArtifact(
    'service',
    'http://localhost:3000',
    '/Users/admin/project/new-context-app',
  );
  enrichedArtifact.localService!.projectCandidates = [{
    directory: '/Users/admin/project/new-context-app',
    source: ShareDeploymentCandidateSource.ToolCdCommand,
    confidence: 94,
  }];
  state = artifactReducer(state, addArtifact({
    sessionId: 'session-1',
    artifact: enrichedArtifact,
  }));

  expect(state.artifactsBySession['session-1'][0].localService?.projectDirectory).toBe(
    '/Users/admin/project/new-context-app',
  );
});

test('addArtifact accepts a reordered local service context candidate list', () => {
  const artifact = makeLocalServiceArtifact(
    'service',
    'http://localhost:3000',
    '/Users/admin/project/app-a',
  );
  const appACandidate = {
    directory: '/Users/admin/project/app-a',
    source: ShareDeploymentCandidateSource.ToolCdCommand,
    confidence: 94,
    messageId: 'bash-a',
  };
  const appBCandidate = {
    directory: '/Users/admin/project/app-b',
    source: ShareDeploymentCandidateSource.ToolCdCommand,
    confidence: 93,
    messageId: 'bash-b',
  };
  artifact.localService!.projectCandidates = [appACandidate, appBCandidate];
  let state = artifactReducer(undefined, addArtifact({ sessionId: 'session-1', artifact }));
  state = artifactReducer(state, updateLocalServiceProjectMetadata({
    sessionId: 'session-1',
    artifactId: artifact.id,
    projectDirectory: '/Users/admin/project/resolved-app',
    projectCandidates: [{
      directory: '/Users/admin/project/resolved-app',
      source: ShareDeploymentCandidateSource.ArtifactMetadata,
      confidence: 60,
    }, appACandidate, appBCandidate],
  }));

  const reorderedArtifact = makeLocalServiceArtifact(
    'service',
    'http://localhost:3000',
    '/Users/admin/project/app-b',
  );
  reorderedArtifact.localService!.projectCandidates = [appBCandidate, appACandidate];
  state = artifactReducer(state, addArtifact({
    sessionId: 'session-1',
    artifact: reorderedArtifact,
  }));

  expect(state.artifactsBySession['session-1'][0].localService).toEqual(expect.objectContaining({
    projectDirectory: '/Users/admin/project/app-b',
    projectCandidates: [appBCandidate, appACandidate],
  }));
});

test('openArtifactPreviewTab resolves duplicate file cards to the display artifact', () => {
  let state = artifactReducer(undefined, addArtifact({
    sessionId: 'session-1',
    artifact: makeVideoArtifact(
      'video-first-reply',
      '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4',
      'message-first-reply',
    ),
  }));

  state = artifactReducer(state, addArtifact({
    sessionId: 'session-1',
    artifact: {
      ...makeVideoArtifact(
        'video-second-reply',
        '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4',
        'message-second-reply',
      ),
      createdAt: 2,
    },
  }));

  state = artifactReducer(state, openArtifactPreviewTab({
    sessionId: 'session-1',
    artifactId: 'video-first-reply',
  }));

  expect(state.selectedArtifactId).toBe('video-second-reply');
  expect(state.previewTabsBySession['session-1']).toEqual([
    expect.objectContaining({
      id: 'artifact:video-second-reply',
      artifactId: 'video-second-reply',
    }),
  ]);
});

test('addLinkedFileArtifact keeps one entry per opened file and refreshes it on reopen', () => {
  const linkedFile: Artifact = {
    id: 'artifact-linked-file-/users/admin/work/.cowork-temp/notes.md',
    messageId: '',
    sessionId: 'session-1',
    type: ArtifactTypeValue.Markdown,
    title: 'notes.md',
    content: 'first read',
    fileName: 'notes.md',
    filePath: '/Users/admin/work/.cowork-temp/notes.md',
    createdAt: 1,
  };

  let state = artifactReducer(undefined, addLinkedFileArtifact({ sessionId: 'session-1', artifact: linkedFile }));
  state = artifactReducer(state, openArtifactPreviewTab({ sessionId: 'session-1', artifactId: linkedFile.id }));
  state = artifactReducer(state, addLinkedFileArtifact({
    sessionId: 'session-1',
    artifact: { ...linkedFile, content: 'second read', createdAt: 2 },
  }));

  expect(state.artifactsBySession['session-1']).toEqual([
    expect.objectContaining({ id: linkedFile.id, content: 'second read' }),
  ]);
  expect(state.selectedArtifactId).toBe(linkedFile.id);
});

test('addArtifact keeps preview tab selected when local image replaces remote image', () => {
  let state = artifactReducer(undefined, addArtifact({
    sessionId: 'session-1',
    artifact: makeImageArtifact('image-remote', {
      content: 'https://example.com/generated-image.png',
    }),
  }));

  state = artifactReducer(state, openArtifactPreviewTab({
    sessionId: 'session-1',
    artifactId: 'image-remote',
  }));

  state = artifactReducer(state, addArtifact({
    sessionId: 'session-1',
    artifact: makeImageArtifact('image-local', {
      content: 'data:image/png;base64,abc123',
      filePath: '/Users/admin/project/generated-image.png',
      remoteUrl: 'https://example.com/generated-image.png',
    }),
  }));

  expect(state.artifactsBySession['session-1']).toHaveLength(1);
  expect(state.artifactsBySession['session-1'][0].id).toBe('image-local');
  expect(state.selectedArtifactId).toBe('image-local');
  expect(state.previewTabsBySession['session-1']).toEqual([
    expect.objectContaining({
      id: 'artifact:image-local',
      artifactId: 'image-local',
    }),
  ]);
});

test('selectSessionArtifacts hides duplicate generated videos from stale state', () => {
  const rootState = {
    artifact: {
      artifactsBySession: {
        'session-1': [
          makeVideoArtifact('video-a', '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4'),
          makeVideoArtifact('video-b', '/Users/admin/work/test0522/generated-video-20260522-171920-1.mp4'),
        ],
      },
      previewTabsBySession: {},
      activePreviewTabIdBySession: {},
      selectedArtifactId: null,
      isPanelOpen: false,
      panelWidth: 560,
    },
  } as unknown as RootState;

  expect(selectSessionArtifacts(rootState, 'session-1')).toHaveLength(1);
});
