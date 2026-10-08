import React, { lazy, Suspense } from 'react';

import { i18nService } from '@/services/i18n';
import { officeBridge } from '@/services/office/officeFormats';
import type { SlidesChatReference } from '@/services/office/slides/slidesEditorSession';
import type { Artifact } from '@/types/artifact';

import { CoworkSelectedTextSource } from '../../../../../shared/cowork/selectedText';
import { OfficeEditorId } from '../../../../../shared/office/core/officeEditor';
import { officeEditorForPath } from '../../../../../shared/office/editors';
import { type ArtifactSelectedTextContext, artifactSnippet } from '../../artifactSelectedText';
import { normalizeLocalFilePath } from '../documentFileContent';
import { SheetRenderer } from './sheet/SheetRenderer';
import { PptxPreview } from './slides/PptxPreview';
import { DocxPreview } from './word/DocxPreview';

const t = (key: string) => i18nService.t(key);
const WordFileEditor = lazy(() => import('./word/WordFileEditor'));
const SheetFileEditor = lazy(() => import('./sheet/SheetFileEditor'));
const SlidesFileEditor = lazy(() => import('./slides/SlidesFileEditor'));

/** Where an excerpt of a presentation comes from, e.g. "第 2 张幻灯片 · 标题 1 #2". */
const slidesReferenceTitle = (reference: SlidesChatReference): string => t('slidesChatReference')
  .replace('{slide}', String(reference.slide))
  .replace('{shape}', `${reference.shapeName} #${reference.shapeId}`.trim());

interface EditorProps {
  artifact: Artifact;
  filePath: string;
  /** The read-only preview, offered when the file cannot be edited. */
  preview: React.ReactNode;
  selectedTextContext?: ArtifactSelectedTextContext;
}

/** How the artifact panel shows one editor's files. */
interface OfficeEditorView {
  loading: string;
  /** Read-only rendering, used where the live editor is unavailable. */
  preview: (artifact: Artifact) => React.ReactElement;
  /** The live editor, loaded on first use. */
  editor: (props: EditorProps) => React.ReactElement;
}

/** The panel side of every editor in OFFICE_EDITORS. */
const OFFICE_EDITOR_VIEWS: Record<OfficeEditorId, OfficeEditorView> = {
  [OfficeEditorId.Word]: {
    loading: 'wordLoading',
    preview: artifact => <DocxPreview artifact={artifact} />,
    editor: ({ artifact, filePath, preview, selectedTextContext }) => (
      <WordFileEditor key={filePath} filePath={filePath} preview={preview}
        onAddToChat={selectedTextContext?.enabled
          ? text => selectedTextContext.onAddSelectedText(artifactSnippet(artifact, CoworkSelectedTextSource.ArtifactWord, text))
          : undefined} />
    ),
  },
  [OfficeEditorId.Sheet]: {
    loading: 'sheetLoading',
    preview: artifact => <SheetRenderer artifact={artifact} />,
    editor: ({ artifact, filePath, preview, selectedTextContext }) => (
      <SheetFileEditor key={filePath} filePath={filePath} preview={preview}
        onAddToChat={selectedTextContext?.enabled
          ? reference => selectedTextContext.onAddSelectedText(artifactSnippet(artifact, CoworkSelectedTextSource.ArtifactSheet, reference.text, reference.address))
          : undefined} />
    ),
  },
  [OfficeEditorId.Slides]: {
    loading: 'slidesLoading',
    preview: artifact => <PptxPreview artifact={artifact} />,
    editor: ({ artifact, filePath, preview, selectedTextContext }) => (
      <SlidesFileEditor key={filePath} filePath={filePath} preview={preview}
        onAddToChat={selectedTextContext?.enabled
          ? reference => selectedTextContext.onAddSelectedText(artifactSnippet(artifact, CoworkSelectedTextSource.ArtifactSlides, reference.text, slidesReferenceTitle(reference)))
          : undefined} />
    ),
  },
};

/**
 * An Office file in the artifact panel: its live editor where this window has one, otherwise the
 * read-only preview. Null for files no Office editor opens.
 */
export function officeDocumentView(artifact: Artifact, selectedTextContext?: ArtifactSelectedTextContext): React.ReactElement | null {
  const editor = officeEditorForPath(artifact.fileName || artifact.filePath || '');
  if (!editor) return null;
  const view = OFFICE_EDITOR_VIEWS[editor.id];
  if (!artifact.filePath || !officeBridge(editor.id)) return view.preview(artifact);
  return (
    <Suspense fallback={<div className="p-6 text-sm opacity-60">{t(view.loading)}</div>}>
      {view.editor({
        artifact,
        filePath: normalizeLocalFilePath(artifact.filePath),
        preview: view.preview({ ...artifact, content: '' }),
        selectedTextContext,
      })}
    </Suspense>
  );
}
