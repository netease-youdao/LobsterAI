import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';
import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import {
  getPreviewCardDescriptor,
  PreviewCardDisplayKind,
  PreviewCardIconKind,
  PreviewCardOpenAction,
} from './previewCardPolicy';

const originalLanguage = i18nService.getLanguage();

const makeArtifact = (overrides: Partial<Artifact>): Artifact => ({
  id: 'artifact-1',
  messageId: 'message-1',
  sessionId: 'session-1',
  type: ArtifactTypeValue.Html,
  title: '欢迎页面',
  content: '',
  createdAt: 1,
  ...overrides,
});

beforeAll(() => {
  i18nService.setLanguage('zh', { persist: false });
});

afterAll(() => {
  i18nService.setLanguage(originalLanguage, { persist: false });
});

describe('preview card presentation policy', () => {
  test('presents an HTML artifact as a web page while keeping browser open behavior', () => {
    const descriptor = getPreviewCardDescriptor(makeArtifact({
      fileName: 'welcome.html',
      filePath: '/tmp/welcome.html',
    }));

    expect(descriptor).toMatchObject({
      displayKind: PreviewCardDisplayKind.WebPage,
      iconKind: PreviewCardIconKind.File,
      title: '欢迎页面',
      subtitle: '网页',
      iconFileName: 'welcome.html',
      defaultOpenAction: PreviewCardOpenAction.Browser,
    });
  });

  test('forces the HTML file icon when an inline web page has no extension', () => {
    const descriptor = getPreviewCardDescriptor(makeArtifact({
      title: '内联页面',
      fileName: undefined,
      filePath: undefined,
    }));

    expect(descriptor.iconKind).toBe(PreviewCardIconKind.File);
    expect(descriptor.iconFileName).toBe('page.html');
  });

  test('presents a local service separately with a globe icon', () => {
    const descriptor = getPreviewCardDescriptor(makeArtifact({
      type: ArtifactTypeValue.LocalService,
      title: '订单系统',
      url: 'http://localhost:4173',
      content: 'http://localhost:4173',
    }));

    expect(descriptor).toMatchObject({
      displayKind: PreviewCardDisplayKind.LocalService,
      iconKind: PreviewCardIconKind.Globe,
      title: '订单系统',
      subtitle: '本地服务',
      defaultOpenAction: PreviewCardOpenAction.Browser,
    });
  });

  test('keeps regular files on file icons and preview behavior', () => {
    const descriptor = getPreviewCardDescriptor(makeArtifact({
      type: ArtifactTypeValue.Document,
      title: '季度报告.pdf',
      fileName: '季度报告.pdf',
      filePath: '/tmp/季度报告.pdf',
    }));

    expect(descriptor).toMatchObject({
      displayKind: PreviewCardDisplayKind.Document,
      iconKind: PreviewCardIconKind.File,
      subtitle: '文档 · PDF',
      defaultOpenAction: PreviewCardOpenAction.Preview,
    });
  });
});
