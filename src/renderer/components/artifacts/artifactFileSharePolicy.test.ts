import { HtmlShareAccessMode, HtmlShareSourceType } from '@shared/htmlShare/constants';
import { describe, expect, test } from 'vitest';

import { type Artifact, ArtifactMediaOriginType, ArtifactTypeValue } from '@/types/artifact';

import {
  ArtifactFileShareRequestSource,
  buildArtifactFileShareLookupKey,
  buildArtifactFileShareRequest,
  getArtifactFileShareSourceType,
  isArtifactFileShareable,
} from './artifactFileSharePolicy';

const makeArtifact = (type: Artifact['type'], overrides: Partial<Artifact> = {}): Artifact => ({
  id: 'artifact-1',
  messageId: 'message-1',
  sessionId: 'session-1',
  type,
  title: 'Artifact title',
  content: '',
  createdAt: 1,
  ...overrides,
});

describe('artifactFileSharePolicy', () => {
  test.each([
    [ArtifactTypeValue.Html, HtmlShareSourceType.HtmlFile],
    [ArtifactTypeValue.Image, HtmlShareSourceType.ImageFile],
    [ArtifactTypeValue.Svg, HtmlShareSourceType.SvgFile],
    [ArtifactTypeValue.Document, HtmlShareSourceType.DocumentFile],
    [ArtifactTypeValue.Markdown, HtmlShareSourceType.MarkdownFile],
    [ArtifactTypeValue.Mermaid, HtmlShareSourceType.MermaidFile],
  ])('maps %s artifacts to %s', (artifactType, sourceType) => {
    expect(getArtifactFileShareSourceType(makeArtifact(artifactType))).toBe(sourceType);
  });

  test.each([
    {
      label: 'html file path',
      type: ArtifactTypeValue.Html,
      source: { filePath: '/tmp/index.html' },
      expected: true,
    },
    {
      label: 'html content',
      type: ArtifactTypeValue.Html,
      source: { content: '<h1>Hello</h1>' },
      expected: false,
    },
    {
      label: 'html remote URL',
      type: ArtifactTypeValue.Html,
      source: { remoteUrl: 'https://example.com/index.html' },
      expected: false,
    },
    {
      label: 'image file path',
      type: ArtifactTypeValue.Image,
      source: { filePath: '/tmp/image.png' },
      expected: true,
    },
    {
      label: 'image content',
      type: ArtifactTypeValue.Image,
      source: { content: 'data:image/png;base64,abc' },
      expected: true,
    },
    {
      label: 'image remote URL',
      type: ArtifactTypeValue.Image,
      source: { remoteUrl: 'https://example.com/image.png' },
      expected: true,
    },
    {
      label: 'svg file path',
      type: ArtifactTypeValue.Svg,
      source: { filePath: '/tmp/image.svg' },
      expected: true,
    },
    {
      label: 'svg content',
      type: ArtifactTypeValue.Svg,
      source: { content: '<svg />' },
      expected: true,
    },
    {
      label: 'svg remote URL',
      type: ArtifactTypeValue.Svg,
      source: { remoteUrl: 'https://example.com/image.svg' },
      expected: true,
    },
    {
      label: 'document file path',
      type: ArtifactTypeValue.Document,
      source: { filePath: '/tmp/report.pdf' },
      expected: true,
    },
    {
      label: 'document content',
      type: ArtifactTypeValue.Document,
      source: { content: 'Report contents' },
      expected: true,
    },
    {
      label: 'document remote URL',
      type: ArtifactTypeValue.Document,
      source: { remoteUrl: 'https://example.com/report.pdf' },
      expected: false,
    },
    {
      label: 'markdown file path',
      type: ArtifactTypeValue.Markdown,
      source: { filePath: '/tmp/readme.md' },
      expected: true,
    },
    {
      label: 'markdown content',
      type: ArtifactTypeValue.Markdown,
      source: { content: '# Readme' },
      expected: true,
    },
    {
      label: 'markdown remote URL',
      type: ArtifactTypeValue.Markdown,
      source: { remoteUrl: 'https://example.com/readme.md' },
      expected: false,
    },
    {
      label: 'mermaid file path',
      type: ArtifactTypeValue.Mermaid,
      source: { filePath: '/tmp/diagram.mmd' },
      expected: true,
    },
    {
      label: 'mermaid content',
      type: ArtifactTypeValue.Mermaid,
      source: { content: 'graph TD; A-->B' },
      expected: true,
    },
    {
      label: 'mermaid remote URL',
      type: ArtifactTypeValue.Mermaid,
      source: { remoteUrl: 'https://example.com/diagram.mmd' },
      expected: false,
    },
  ])('$label shareability is $expected', ({ type, source, expected }) => {
    expect(isArtifactFileShareable(makeArtifact(type, source))).toBe(expected);
  });

  test.each([
    ArtifactTypeValue.LocalService,
    ArtifactTypeValue.Code,
    ArtifactTypeValue.Text,
  ])('never shares unsupported %s artifacts', artifactType => {
    const artifact = makeArtifact(artifactType, {
      filePath: '/tmp/source.bin',
      content: 'content',
      remoteUrl: 'https://example.com/source.bin',
    });

    expect(getArtifactFileShareSourceType(artifact)).toBeNull();
    expect(isArtifactFileShareable(artifact)).toBe(false);
    expect(buildArtifactFileShareRequest(artifact, 'fallback-session', 'Share')).toBeNull();
  });

  test('does not share a local video without model-generation provenance', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Video, {
      filePath: '/tmp/local-video.mp4',
      source: 'file',
    });

    expect(getArtifactFileShareSourceType(artifact)).toBeNull();
    expect(isArtifactFileShareable(artifact)).toBe(false);
  });

  test('builds a generated video request without a local path or URL', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Video, {
      filePath: '/tmp/generated-video.mp4',
      remoteUrl: 'https://provider.example/video.mp4?token=temporary',
      mediaOrigin: {
        type: ArtifactMediaOriginType.GeneratedVideo,
        taskId: '123',
        outputIndex: 2,
      },
      source: 'tool',
    });

    expect(buildArtifactFileShareRequest(artifact, 'fallback-session', 'Share')).toEqual({
      source: ArtifactFileShareRequestSource.GeneratedVideo,
      sourceType: HtmlShareSourceType.GeneratedVideoFile,
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      lookupKey: 'generated_video_file:task:123:2',
      title: 'Artifact title',
      accessMode: HtmlShareAccessMode.Code,
      taskId: '123',
      outputIndex: 2,
    });
  });

  test('allows only tool-marked legacy HTTPS video results to enter source resolution', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Video, {
      remoteUrl: 'https://provider.example/video.mp4?token=temporary',
      legacyGeneratedVideoCandidate: true,
      source: 'tool',
    });
    const request = buildArtifactFileShareRequest(artifact, 'fallback-session', 'Share');

    expect(request?.source).toBe(ArtifactFileShareRequestSource.GeneratedVideo);
    expect(request?.taskId).toBeUndefined();
    expect(request?.legacyResultUrl).toBe(artifact.remoteUrl);
  });

  test('rejects missing and whitespace-only inline sources', () => {
    expect(isArtifactFileShareable(makeArtifact(ArtifactTypeValue.Image))).toBe(false);
    expect(
      isArtifactFileShareable(
        makeArtifact(ArtifactTypeValue.Image, {
          content: '   ',
          remoteUrl: '\n\t',
        }),
      ),
    ).toBe(false);
  });

  test('uses a stable file lookup key when a file path is available', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Image, {
      filePath: '/tmp/image.png',
      sessionId: '',
    });

    expect(
      buildArtifactFileShareLookupKey(artifact, HtmlShareSourceType.ImageFile, 'fallback-session'),
    ).toBe('image_file:file:/tmp/image.png');
  });

  test.each([
    ['file:///TMP/My%20Image.PNG', 'image_file:file:/tmp/my image.png'],
    ['C:\\Temp\\IMAGE.PNG', 'image_file:file:c:/temp/image.png'],
    ['/C:/Temp/IMAGE.PNG', 'image_file:file:c:/temp/image.png'],
  ])('normalizes equivalent file paths in lookup keys', (filePath, expected) => {
    const artifact = makeArtifact(ArtifactTypeValue.Image, { filePath });

    expect(buildArtifactFileShareLookupKey(artifact, HtmlShareSourceType.ImageFile)).toBe(expected);
  });

  test('uses artifact identity and the fallback session for an inline lookup key', () => {
    const artifact = makeArtifact(ArtifactTypeValue.Image, {
      content: 'data:image/png;base64,abc',
      sessionId: '',
    });

    expect(
      buildArtifactFileShareLookupKey(artifact, HtmlShareSourceType.ImageFile, 'fallback-session'),
    ).toBe('image_file:artifact:fallback-session:artifact-1');
  });

  test('builds an HTML file request', () => {
    const request = buildArtifactFileShareRequest(
      makeArtifact(ArtifactTypeValue.Html, {
        filePath: '/tmp/index.html',
        fileName: 'index.html',
      }),
      'fallback-session',
      'Share',
    );

    expect(request).toEqual({
      source: ArtifactFileShareRequestSource.HtmlFile,
      sourceType: HtmlShareSourceType.HtmlFile,
      sessionId: 'session-1',
      artifactId: 'artifact-1',
      lookupKey: 'html_file:file:/tmp/index.html',
      filePath: '/tmp/index.html',
      title: 'Artifact title',
      accessMode: HtmlShareAccessMode.Code,
    });
  });

  test('builds an artifact file request and preserves supported sources', () => {
    const request = buildArtifactFileShareRequest(
      makeArtifact(ArtifactTypeValue.Image, {
        sessionId: '',
        title: '',
        fileName: 'image.png',
        content: 'data:image/png;base64,abc',
        remoteUrl: 'https://example.com/image.png',
      }),
      'fallback-session',
      'Share',
    );

    expect(request).toEqual({
      source: ArtifactFileShareRequestSource.ArtifactFile,
      sourceType: HtmlShareSourceType.ImageFile,
      sessionId: 'fallback-session',
      artifactId: 'artifact-1',
      lookupKey: 'image_file:artifact:fallback-session:artifact-1',
      title: 'image.png',
      accessMode: HtmlShareAccessMode.Code,
      fileName: 'image.png',
      filePath: undefined,
      content: 'data:image/png;base64,abc',
      remoteUrl: 'https://example.com/image.png',
    });
  });

  test.each([ArtifactTypeValue.Document, ArtifactTypeValue.Markdown, ArtifactTypeValue.Mermaid])(
    'omits remote URLs from %s requests',
    artifactType => {
      const request = buildArtifactFileShareRequest(
        makeArtifact(artifactType, {
          content: 'inline content',
          remoteUrl: 'https://example.com/source',
        }),
        'fallback-session',
        'Share',
      );

      expect(request?.remoteUrl).toBeUndefined();
    },
  );
});
