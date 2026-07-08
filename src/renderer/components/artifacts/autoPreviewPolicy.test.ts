import { describe, expect, test } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import {
  ArtifactAutoPreviewCategory,
  ArtifactAutoPreviewOpenTarget,
  getAutoPreviewCategory,
  getAutoPreviewOpenTarget,
  selectAutoPreviewArtifact,
} from './autoPreviewPolicy';

const makeArtifact = (
  id: string,
  type: Artifact['type'],
  overrides: Partial<Artifact> = {},
): Artifact => ({
  id,
  messageId: overrides.messageId ?? 'message-1',
  sessionId: 'session-1',
  type,
  title: overrides.title ?? id,
  content: overrides.content ?? '',
  createdAt: overrides.createdAt ?? 1,
  ...overrides,
});

describe('autoPreviewPolicy', () => {
  test.each([
    {
      label: 'local service',
      artifact: makeArtifact('service', ArtifactTypeValue.LocalService, {
        content: 'http://localhost:3000',
        url: 'http://localhost:3000',
      }),
      category: ArtifactAutoPreviewCategory.LocalService,
      openTarget: ArtifactAutoPreviewOpenTarget.LocalServiceBrowser,
    },
    {
      label: 'html file',
      artifact: makeArtifact('html', ArtifactTypeValue.Html, {
        filePath: '/Users/admin/project/index.html',
      }),
      category: ArtifactAutoPreviewCategory.Html,
      openTarget: ArtifactAutoPreviewOpenTarget.HtmlBrowser,
    },
    {
      label: 'inline html',
      artifact: makeArtifact('inline-html', ArtifactTypeValue.Html, {
        content: '<html><body>Hello</body></html>',
      }),
      category: ArtifactAutoPreviewCategory.Html,
      openTarget: ArtifactAutoPreviewOpenTarget.PreviewTab,
    },
    {
      label: 'video',
      artifact: makeArtifact('video', ArtifactTypeValue.Video, {
        filePath: '/Users/admin/project/video.mp4',
      }),
      category: ArtifactAutoPreviewCategory.Video,
      openTarget: ArtifactAutoPreviewOpenTarget.PreviewTab,
    },
    {
      label: 'image',
      artifact: makeArtifact('image', ArtifactTypeValue.Image, {
        content: 'data:image/png;base64,abc123',
      }),
      category: ArtifactAutoPreviewCategory.Image,
      openTarget: ArtifactAutoPreviewOpenTarget.PreviewTab,
    },
    {
      label: 'svg image',
      artifact: makeArtifact('svg', ArtifactTypeValue.Svg, {
        filePath: '/Users/admin/project/vector.svg',
      }),
      category: ArtifactAutoPreviewCategory.Image,
      openTarget: ArtifactAutoPreviewOpenTarget.PreviewTab,
    },
    {
      label: 'document',
      artifact: makeArtifact('document', ArtifactTypeValue.Document, {
        filePath: '/Users/admin/project/report.pdf',
      }),
      category: ArtifactAutoPreviewCategory.Document,
      openTarget: ArtifactAutoPreviewOpenTarget.PreviewTab,
    },
    {
      label: 'markdown document',
      artifact: makeArtifact('markdown', ArtifactTypeValue.Markdown, {
        filePath: '/Users/admin/project/notes.md',
      }),
      category: ArtifactAutoPreviewCategory.Document,
      openTarget: ArtifactAutoPreviewOpenTarget.PreviewTab,
    },
  ])('classifies and routes $label preview', ({ artifact, category, openTarget }) => {
    expect(getAutoPreviewCategory(artifact)).toBe(category);
    expect(getAutoPreviewOpenTarget(artifact)).toBe(openTarget);
    expect(selectAutoPreviewArtifact([artifact])?.id).toBe(artifact.id);
  });

  test('selects by priority before display order', () => {
    const selected = selectAutoPreviewArtifact([
      makeArtifact('image', ArtifactTypeValue.Image),
      makeArtifact('video', ArtifactTypeValue.Video),
      makeArtifact('html', ArtifactTypeValue.Html),
      makeArtifact('document', ArtifactTypeValue.Document),
      makeArtifact('service', ArtifactTypeValue.LocalService, {
        content: 'http://localhost:3000',
        url: 'http://localhost:3000',
      }),
    ]);

    expect(selected?.id).toBe('service');
  });

  test('prefers documents over html, video, and image previews', () => {
    const selected = selectAutoPreviewArtifact([
      makeArtifact('image', ArtifactTypeValue.Image),
      makeArtifact('video', ArtifactTypeValue.Video),
      makeArtifact('html', ArtifactTypeValue.Html, {
        filePath: '/Users/admin/project/index.html',
      }),
      makeArtifact('presentation', ArtifactTypeValue.Document, {
        fileName: 'slides.pptx',
        filePath: '/Users/admin/project/slides.pptx',
      }),
    ]);

    expect(selected?.id).toBe('presentation');
  });

  test('prefers html over video and image previews when there is no document', () => {
    const selected = selectAutoPreviewArtifact([
      makeArtifact('image', ArtifactTypeValue.Image),
      makeArtifact('video', ArtifactTypeValue.Video),
      makeArtifact('html', ArtifactTypeValue.Html, {
        filePath: '/Users/admin/project/index.html',
      }),
    ]);

    expect(selected?.id).toBe('html');
  });

  test('selects the first artifact for the same category', () => {
    const selected = selectAutoPreviewArtifact([
      makeArtifact('video-first', ArtifactTypeValue.Video),
      makeArtifact('video-second', ArtifactTypeValue.Video),
    ]);

    expect(selected?.id).toBe('video-first');
  });

  test('maps svg to image and markdown to document', () => {
    expect(getAutoPreviewCategory(makeArtifact('svg', ArtifactTypeValue.Svg))).toBe(
      ArtifactAutoPreviewCategory.Image,
    );
    expect(getAutoPreviewCategory(makeArtifact('markdown', ArtifactTypeValue.Markdown))).toBe(
      ArtifactAutoPreviewCategory.Document,
    );
  });

  test('returns null when there are no automatic preview candidates', () => {
    const artifacts = [
      makeArtifact('code', ArtifactTypeValue.Code),
      makeArtifact('text', ArtifactTypeValue.Text),
      makeArtifact('mermaid', ArtifactTypeValue.Mermaid),
    ];
    const selected = selectAutoPreviewArtifact(artifacts);

    expect(selected).toBeNull();
    expect(artifacts.map(getAutoPreviewOpenTarget)).toEqual([null, null, null]);
  });

  test('uses display dedupe before selecting', () => {
    const selected = selectAutoPreviewArtifact([
      makeArtifact('video-old', ArtifactTypeValue.Video, {
        filePath: '/Users/admin/work/output.mp4',
        createdAt: 1,
      }),
      makeArtifact('video-new', ArtifactTypeValue.Video, {
        filePath: '/Users/admin/work/output.mp4',
        createdAt: 2,
      }),
    ]);

    expect(selected?.id).toBe('video-new');
  });
});
