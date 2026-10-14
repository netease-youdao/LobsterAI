import { describe, expect, test } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '../types/artifact';
import {
  findLocalServiceArtifactForUrl,
  LocalFileLinkTargetKind,
  resolveLocalFileLinkTarget,
} from './artifactLinkOpen';

const context = { sessionId: 'session-1', cwd: '/Users/admin/claude-3-5-sonnet-ppt' };

const makeArtifact = (id: string, overrides: Partial<Artifact>): Artifact => ({
  id,
  messageId: 'final-reply',
  sessionId: 'session-1',
  type: ArtifactTypeValue.Document,
  title: id,
  content: '',
  createdAt: 1,
  ...overrides,
});

describe('resolveLocalFileLinkTarget', () => {
  test('opens the card the session already has for the linked file', () => {
    const deck = makeArtifact('deck', {
      fileName: 'Claude Sonnet 3.5 介绍.pptx',
      filePath: 'file:///Users/admin/claude-3-5-sonnet-ppt/Claude%20Sonnet%203.5%20介绍.pptx',
    });

    expect(resolveLocalFileLinkTarget(
      '/Users/admin/claude-3-5-sonnet-ppt/Claude Sonnet 3.5 介绍.pptx',
      [deck],
      context,
    )).toEqual({ kind: LocalFileLinkTargetKind.Existing, artifact: deck });
  });

  test('matches Windows paths regardless of separators and case', () => {
    const report = makeArtifact('report', { filePath: 'C:\\Users\\Admin\\Work\\Report.pdf' });

    expect(resolveLocalFileLinkTarget('c:/users/admin/work/report.pdf', [report], context))
      .toEqual({ kind: LocalFileLinkTargetKind.Existing, artifact: report });
  });

  test('builds a message-less artifact to load when no card covers the file', () => {
    const target = resolveLocalFileLinkTarget('./exports/preview.pdf', [], context);

    expect(target).toEqual({
      kind: LocalFileLinkTargetKind.Load,
      artifact: expect.objectContaining({
        messageId: '',
        sessionId: 'session-1',
        type: ArtifactTypeValue.Document,
        title: 'preview.pdf',
        fileName: 'preview.pdf',
        filePath: '/Users/admin/claude-3-5-sonnet-ppt/exports/preview.pdf',
      }),
    });
    expect(resolveLocalFileLinkTarget('exports/preview.pdf', [], context)?.artifact.id)
      .toBe(target?.artifact.id);
  });

  test.each([
    ['a folder', '/Users/admin/claude-3-5-sonnet-ppt'],
    ['a folder with a trailing slash', '/Users/admin/claude-3-5-sonnet-ppt/'],
    ['a dotfile', '/Users/admin/claude-3-5-sonnet-ppt/.env'],
    ['a script', '/Users/admin/claude-3-5-sonnet-ppt/build.js'],
    ['a code file cards do not preview', '/Users/admin/claude-3-5-sonnet-ppt/App.tsx'],
    ['an archive', '/Users/admin/claude-3-5-sonnet-ppt/slides.zip'],
  ])('leaves %s to the system', (_label, filePath) => {
    expect(resolveLocalFileLinkTarget(filePath, [], context)).toBeNull();
  });
});

describe('findLocalServiceArtifactForUrl', () => {
  const service = makeArtifact('service', {
    type: ArtifactTypeValue.LocalService,
    content: 'http://localhost:5173',
    url: 'http://localhost:5173',
  });

  test('finds the local service card on the same port', () => {
    expect(findLocalServiceArtifactForUrl('http://127.0.0.1:5173/admin', [service])).toBe(service);
  });

  test('ignores other ports and web links', () => {
    expect(findLocalServiceArtifactForUrl('http://localhost:3000', [service])).toBeNull();
    expect(findLocalServiceArtifactForUrl('https://example.com:5173', [service])).toBeNull();
    expect(findLocalServiceArtifactForUrl('mailto:someone@example.com', [service])).toBeNull();
  });
});
