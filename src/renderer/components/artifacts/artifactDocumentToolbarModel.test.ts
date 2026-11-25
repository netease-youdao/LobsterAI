import { describe, expect, test } from 'vitest';

import { ArtifactTypeValue } from '@/types/artifact';

import {
  buildInlineArtifactDownload,
  canDownloadArtifact,
  resolveArtifactDocumentToolbarModel,
} from './artifactDocumentToolbarModel';

describe('canDownloadArtifact', () => {
  test('allows local non-service files and inline artifacts with content', () => {
    expect(canDownloadArtifact({
      filePath: '/workspace/posts/talk.md',
      type: ArtifactTypeValue.Markdown,
      content: '',
    })).toBe(true);
    expect(canDownloadArtifact({
      filePath: undefined,
      type: ArtifactTypeValue.Html,
      content: '<h1>Hello</h1>',
    })).toBe(true);
  });

  test('rejects local-service artifacts and empty inline artifacts', () => {
    expect(canDownloadArtifact({
      filePath: '/workspace/app',
      type: ArtifactTypeValue.LocalService,
      content: 'http://localhost:3000',
    })).toBe(false);
    expect(canDownloadArtifact({
      filePath: undefined,
      type: ArtifactTypeValue.Video,
      content: '',
    })).toBe(false);
    expect(canDownloadArtifact(null)).toBe(false);
  });
});

describe('buildInlineArtifactDownload', () => {
  test('derives extension and MIME type for inline text and code artifacts', () => {
    expect(buildInlineArtifactDownload({
      type: ArtifactTypeValue.Markdown,
      title: 'Meeting Notes',
      content: '# Notes',
    })).toEqual({
      fileName: 'Meeting Notes.md',
      mimeType: 'text/markdown;charset=utf-8',
      content: '# Notes',
      isDataUrl: false,
    });

    expect(buildInlineArtifactDownload({
      type: ArtifactTypeValue.Code,
      title: 'script',
      language: 'typescript',
      content: 'export const ok = true;',
    })).toEqual({
      fileName: 'script.ts',
      mimeType: 'text/plain;charset=utf-8',
      content: 'export const ok = true;',
      isDataUrl: false,
    });
  });

  test('preserves existing extensions and handles inline image data URLs', () => {
    expect(buildInlineArtifactDownload({
      type: ArtifactTypeValue.Html,
      title: 'Demo',
      fileName: 'report.html',
      content: '<p>Hi</p>',
    })?.fileName).toBe('report.html');

    expect(buildInlineArtifactDownload({
      type: ArtifactTypeValue.Image,
      title: 'chart',
      content: 'data:image/jpeg;base64,/9j/4AAQ',
    })).toEqual({
      fileName: 'chart.jpg',
      mimeType: 'image/jpeg',
      content: 'data:image/jpeg;base64,/9j/4AAQ',
      isDataUrl: true,
    });
  });

  test('sanitizes invalid filename characters', () => {
    expect(buildInlineArtifactDownload({
      type: ArtifactTypeValue.Svg,
      title: 'diagram: v1/2?',
      content: '<svg />',
    })?.fileName).toBe('diagram_ v1_2_.svg');
  });
});

describe('resolveArtifactDocumentToolbarModel', () => {
  test('exposes share, download, file list, and only copy/refresh/reveal in more menu for local markdown', () => {
    expect(resolveArtifactDocumentToolbarModel({
      artifact: { filePath: '/workspace/talk.md', type: ArtifactTypeValue.Markdown },
      canShare: true,
      canDownload: true,
      canCopy: true,
      canRefresh: true,
      hasCodeControls: false,
      hasZoomControls: false,
      canOpenFileList: true,
    })).toEqual({
      showShareButton: true,
      showDownloadButton: true,
      showCopyInMenu: true,
      showRefreshInMenu: true,
      showRevealInFolderInMenu: true,
      hasMenuActions: true,
      showMoreMenu: true,
      showFileListButton: true,
    });
  });

  test('omits duplicate copy from menu when inline code controls already render copy on the toolbar', () => {
    expect(resolveArtifactDocumentToolbarModel({
      artifact: { filePath: '/workspace/app.ts', type: ArtifactTypeValue.Code },
      canShare: false,
      canDownload: true,
      canCopy: true,
      canRefresh: true,
      hasCodeControls: true,
      hasZoomControls: false,
      canOpenFileList: true,
    })).toEqual({
      showShareButton: false,
      showDownloadButton: true,
      showCopyInMenu: false,
      showRefreshInMenu: true,
      showRevealInFolderInMenu: true,
      hasMenuActions: true,
      showMoreMenu: true,
      showFileListButton: true,
    });
  });

  test('keeps more menu visible when only office zoom controls are available', () => {
    expect(resolveArtifactDocumentToolbarModel({
      artifact: { filePath: undefined, type: ArtifactTypeValue.Document },
      canShare: false,
      canDownload: false,
      canCopy: false,
      canRefresh: false,
      hasCodeControls: false,
      hasZoomControls: true,
      canOpenFileList: false,
    })).toEqual({
      showShareButton: false,
      showDownloadButton: false,
      showCopyInMenu: false,
      showRefreshInMenu: false,
      showRevealInFolderInMenu: false,
      hasMenuActions: false,
      showMoreMenu: true,
      showFileListButton: false,
    });
  });
});
