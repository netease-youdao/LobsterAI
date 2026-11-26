import { describe, expect, test } from 'vitest';

import { getLibraryArtifactTypeForExtension, LibraryArtifactType } from '../library/constants';
import { isConversationArtifactFileName, PREVIEWABLE_ARTIFACT_TYPES } from './displayPolicy';

describe('conversation artifact display policy', () => {
  test('shows the generated Word document without its helper script', () => {
    expect(['make_docx.js', '工作简报.docx'].filter(isConversationArtifactFileName))
      .toEqual(['工作简报.docx']);
  });

  test.each([
    'report.docx', 'slides.pptx', 'table.xlsx', 'legacy.xls', 'table.csv', 'table.tsv',
    'report.pdf', 'note.md', 'note.txt', 'output.log', 'page.html', 'page.htm',
    'diagram.svg', 'diagram.mermaid', 'diagram.mmd', 'image.png', 'image.jpg',
    'image.jpeg', 'image.gif', 'image.webp', 'image.bmp', 'image.avif',
    'video.mp4', 'video.webm', 'video.mov',
    ' 工作简报.DOCX ', 'D:\\agent\\工作简报.docx', '/workspace/out/工作简报.docx',
  ])('preserves the desktop conversation card for %s', name => {
    expect(isConversationArtifactFileName(name)).toBe(true);
  });

  test.each('json yaml yml xml js jsx ts tsx py java c cpp h hpp go rs sh sql css'.split(' '))(
    'keeps %s available to the library without a generated-file card', extension => {
      expect(getLibraryArtifactTypeForExtension(`.${extension}`)).toBe(LibraryArtifactType.Code);
      expect(isConversationArtifactFileName(`result.${extension}`)).toBe(false);
    },
  );

  test.each(['', 'README', 'result.exe', 'archive.zip', 'folder.docx/README', 'folder.docx\\README'])(
    'does not infer a document card from %s', name => {
      expect(isConversationArtifactFileName(name)).toBe(false);
    },
  );

  test('preserves local service cards and excludes source cards', () => {
    expect(PREVIEWABLE_ARTIFACT_TYPES.has('local-service')).toBe(true);
    expect(PREVIEWABLE_ARTIFACT_TYPES.has(LibraryArtifactType.Code)).toBe(false);
  });
});
