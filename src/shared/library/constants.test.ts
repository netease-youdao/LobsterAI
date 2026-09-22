import { describe, expect, test } from 'vitest';

import { remoteFileLocalLimit } from '../remote/files';
import {
  getLibraryArtifactTypeForExtension,
  getLibraryCategoryForExtension,
  LibraryArtifactType,
  LibraryCategory,
} from './constants';

describe('library type policy', () => {
  test.each([
    ['.html', LibraryCategory.Web],
    ['.pptx', LibraryCategory.Slides],
    ['.xlsx', LibraryCategory.Spreadsheet],
    ['.pdf', LibraryCategory.Document],
    ['.svg', LibraryCategory.Image],
    ['.mp4', LibraryCategory.Media],
    ['.tsx', LibraryCategory.Other],
  ])('maps %s to its library category', (extension, category) => {
    expect(getLibraryCategoryForExtension(extension)).toBe(category);
  });

  test('only accepts extensions supported by the current artifact preview pipeline', () => {
    expect(getLibraryArtifactTypeForExtension('.svg')).toBe(LibraryArtifactType.Svg);
    expect(getLibraryArtifactTypeForExtension('.bin')).toBeNull();
  });

  test.each(['.xls', '.xlsx', '.csv', '.tsv', '.CSV'])(
    'maps spreadsheet extension %s to the shareable document artifact type',
    extension => {
      expect(getLibraryArtifactTypeForExtension(extension)).toBe(LibraryArtifactType.Document);
    },
  );

  test.each('md txt csv json yaml yml xml js jsx ts tsx py java c cpp h hpp go rs sh sql css png jpg jpeg webp gif pdf docx xlsx pptx'.split(' '))(
    'can index the already-supported remote output format %s',
    extension => {
      expect(remoteFileLocalLimit(`output.${extension}`, true)).not.toBeNull();
      expect(getLibraryArtifactTypeForExtension(`.${extension}`)).not.toBeNull();
      expect(getLibraryArtifactTypeForExtension(`.${extension.toUpperCase()}`))
        .toBe(getLibraryArtifactTypeForExtension(`.${extension}`));
    },
  );

  test.each('json yaml yml xml js jsx ts tsx py java c cpp h hpp go rs sh sql css'.split(' '))(
    'displays %s as read-only source rather than active content',
    extension => {
      expect(getLibraryArtifactTypeForExtension(`.${extension}`)).toBe(LibraryArtifactType.Code);
      expect(getLibraryCategoryForExtension(`.${extension}`)).toBe(LibraryCategory.Other);
      expect(remoteFileLocalLimit(`output.${extension}`, true)).toBe(5 * 1024 * 1024);
    },
  );

  test('preserves Markdown preview and its existing output size limit', () => {
    expect(getLibraryArtifactTypeForExtension('.md')).toBe(LibraryArtifactType.Markdown);
    expect(remoteFileLocalLimit('report.md', true)).toBe(5 * 1024 * 1024);
  });

  test.each('html htm svg zip exe bin bmp avif log tsv xls mp3 wav m4a mp4 mov webm'.split(' '))(
    'does not broaden remote output support to %s',
    extension => {
      expect(remoteFileLocalLimit(`output.${extension}`, true)).toBeNull();
    },
  );
});
