import { Suspense } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import { officeDocumentView } from './officeEditors';
import { SheetRenderer } from './sheet/SheetRenderer';
import { PptxPreview } from './slides/PptxPreview';
import { DocxPreview } from './word/DocxPreview';

vi.mock('./sheet/SheetRenderer', () => ({ SheetRenderer: vi.fn(() => null) }));
vi.mock('./slides/PptxPreview', () => ({ PptxPreview: vi.fn(() => null) }));
vi.mock('./word/DocxPreview', () => ({ DocxPreview: vi.fn(() => null) }));

afterEach(() => vi.unstubAllGlobals());

describe('Office document access', () => {
  test.each([
    ['report.docx', DocxPreview],
    ['numbers.xlsx', SheetRenderer],
    ['deck.pptx', PptxPreview],
  ] as const)('keeps account-bound %s previews out of path-only editors', (fileName, preview) => {
    vi.stubGlobal('window', { electron: { artifact: { office: { word: {}, sheet: {}, slides: {} } } } });
    const artifact: Artifact = {
      id: 'library-item',
      messageId: 'message',
      sessionId: 'session',
      title: fileName,
      type: ArtifactTypeValue.Document,
      content: '',
      fileName,
      filePath: `/work/${fileName}`,
      fileAccess: { itemId: 'item', accountEpoch: 'epoch' },
      createdAt: 1,
    };

    const libraryView = officeDocumentView(artifact);
    expect(libraryView?.type).toBe(preview);
    expect(libraryView?.props).toMatchObject({ artifact });

    const sessionView = officeDocumentView({ ...artifact, fileAccess: undefined });
    expect(sessionView?.type).toBe(Suspense);
  });
});
