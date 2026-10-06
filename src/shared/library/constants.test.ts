import { describe, expect, test } from 'vitest';

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
    expect(getLibraryArtifactTypeForExtension('.json')).toBeNull();
  });

  test.each(['.xls', '.xlsx', '.csv', '.tsv', '.CSV'])(
    'maps spreadsheet extension %s to the shareable document artifact type',
    extension => {
      expect(getLibraryArtifactTypeForExtension(extension)).toBe(LibraryArtifactType.Document);
    },
  );
});
