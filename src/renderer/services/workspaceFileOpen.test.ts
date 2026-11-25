import { describe, expect, test } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '../types/artifact';
import {
  isLikelyBinaryText,
  resolveWorkspaceFileOpenTarget,
  WorkspaceFileOpenTargetKind,
} from './workspaceFileOpen';

const context = { sessionId: 'session-1', cwd: '/Users/alice/default-workspace' };

const makeArtifact = (id: string, overrides: Partial<Artifact>): Artifact => ({
  id,
  messageId: 'm1',
  sessionId: 'session-1',
  type: ArtifactTypeValue.Document,
  title: id,
  content: '',
  createdAt: 1,
  ...overrides,
});

describe('resolveWorkspaceFileOpenTarget', () => {
  test('reuses an existing session artifact when paths match', () => {
    const doc = makeArtifact('doc-1', {
      fileName: '示例文档.docx',
      filePath: '/Users/alice/default-workspace/示例文档.docx',
    });

    expect(resolveWorkspaceFileOpenTarget(
      '/Users/alice/default-workspace/示例文档.docx',
      [doc],
      context,
    )).toEqual({
      kind: WorkspaceFileOpenTargetKind.Existing,
      artifact: doc,
    });
  });

  test('resolves source code and config files as Code artifacts with language metadata', () => {
    const mjs = resolveWorkspaceFileOpenTarget('x-browser/open-headed.mjs', [], context);
    expect(mjs).toEqual({
      kind: WorkspaceFileOpenTargetKind.Load,
      artifact: expect.objectContaining({
        type: ArtifactTypeValue.Code,
        language: 'javascript',
        fileName: 'open-headed.mjs',
        filePath: '/Users/alice/default-workspace/x-browser/open-headed.mjs',
      }),
    });

    const py = resolveWorkspaceFileOpenTarget('/Users/alice/default-workspace/create_docx.py', [], context);
    expect(py).toEqual({
      kind: WorkspaceFileOpenTargetKind.Load,
      artifact: expect.objectContaining({
        type: ArtifactTypeValue.Code,
        language: 'python',
        fileName: 'create_docx.py',
      }),
    });

    const dockerfile = resolveWorkspaceFileOpenTarget('/Users/alice/default-workspace/Dockerfile', [], context);
    expect(dockerfile).toEqual({
      kind: WorkspaceFileOpenTargetKind.Load,
      artifact: expect.objectContaining({
        type: ArtifactTypeValue.Code,
        language: 'dockerfile',
      }),
    });

    const envLocal = resolveWorkspaceFileOpenTarget('/Users/alice/default-workspace/.env.local', [], context);
    expect(envLocal).toEqual({
      kind: WorkspaceFileOpenTargetKind.Load,
      artifact: expect.objectContaining({
        type: ArtifactTypeValue.Code,
        language: 'shell',
      }),
    });
  });

  test('resolves media, markdown, and office documents to their native artifact types', () => {
    expect(resolveWorkspaceFileOpenTarget('x-browser/first.png', [], context)).toMatchObject({
      kind: WorkspaceFileOpenTargetKind.Load,
      artifact: { type: ArtifactTypeValue.Image, fileName: 'first.png' },
    });
    expect(resolveWorkspaceFileOpenTarget('示例文档.docx', [], context)).toMatchObject({
      kind: WorkspaceFileOpenTargetKind.Load,
      artifact: { type: ArtifactTypeValue.Document, fileName: '示例文档.docx' },
    });
    expect(resolveWorkspaceFileOpenTarget('notes.md', [], context)).toMatchObject({
      kind: WorkspaceFileOpenTargetKind.Load,
      artifact: { type: ArtifactTypeValue.Markdown, fileName: 'notes.md' },
    });
  });

  test('sends known binary formats to System and unknown extensions to ProbeText', () => {
    expect(resolveWorkspaceFileOpenTarget('/Users/alice/default-workspace/archive.zip', [], context)).toEqual({
      kind: WorkspaceFileOpenTargetKind.System,
      filePath: '/Users/alice/default-workspace/archive.zip',
    });
    expect(resolveWorkspaceFileOpenTarget('/Users/alice/default-workspace/CUSTOM_NOTES', [], context)).toMatchObject({
      kind: WorkspaceFileOpenTargetKind.ProbeText,
      artifact: { type: ArtifactTypeValue.Code, fileName: 'CUSTOM_NOTES' },
    });
  });

  test('detects NUL bytes in binary samples', () => {
    expect(isLikelyBinaryText('const x = 1;\n')).toBe(false);
    expect(isLikelyBinaryText('abc\0def')).toBe(true);
  });
});
