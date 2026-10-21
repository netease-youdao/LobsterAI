import { describe, expect, test } from 'vitest';

import {
  CompanionDropAction,
  companionDropActions,
  companionDropCopyKeys,
  CompanionFileKind,
  companionFileKindFromMime,
  companionFileKindFromName,
  isCompanionDocumentKind,
} from './fileKinds';

const K = CompanionFileKind;
const D = CompanionDropAction;

describe('file kinds', () => {
  test('come from extensions, case-insensitively', () => {
    expect(companionFileKindFromName('季度汇报.DOCX')).toBe(K.Document);
    expect(companionFileKindFromName('data.csv')).toBe(K.Spreadsheet);
    expect(companionFileKindFromName('deck.key')).toBe(K.Presentation);
    expect(companionFileKindFromName('book.epub')).toBe(K.Document);
    expect(companionFileKindFromName('installer.dmg')).toBe(K.Other);
    expect(companionFileKindFromName('README')).toBe(K.Other);
  });

  test('come from MIME types while a drag is in flight', () => {
    expect(companionFileKindFromMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(K.Document);
    expect(companionFileKindFromMime('application/vnd.ms-excel')).toBe(K.Spreadsheet);
    expect(companionFileKindFromMime('application/pdf')).toBe(K.Pdf);
    expect(companionFileKindFromMime('image/png')).toBe(K.Image);
    expect(companionFileKindFromMime('')).toBe(K.Other);
  });

  test('only documents are worth a drop zone', () => {
    expect(isCompanionDocumentKind(K.Pdf)).toBe(true);
    expect(isCompanionDocumentKind(K.Other)).toBe(false);
    expect(isCompanionDocumentKind(K.Folder)).toBe(false);
  });
});

describe('drop targets', () => {
  test('fit the kind of file being dragged, ending with ask', () => {
    expect(companionDropActions([K.Document])).toEqual([D.Digest, D.Translate, D.Ask]);
    expect(companionDropActions([K.Spreadsheet])).toEqual([D.Analyze, D.Chart, D.Ask]);
    expect(companionDropActions([K.Presentation])).toEqual([D.Outline, D.Script, D.Ask]);
    expect(companionDropActions([K.Image])).toEqual([D.Ocr, D.Describe, D.Ask]);
    expect(companionDropActions([K.Folder])).toEqual([D.Organize, D.Digest, D.Ask]);
  });

  test('fall back to reading when the kind is unknown and to organising for a mix', () => {
    expect(companionDropActions([])).toEqual([D.Digest, D.Translate, D.Ask]);
    expect(companionDropActions([K.Other])).toEqual([D.Digest, D.Translate, D.Ask]);
    expect(companionDropActions([K.Document, K.Pdf])).toEqual([D.Digest, D.Translate, D.Ask]);
    expect(companionDropActions([K.Document, K.Image])).toEqual([D.Digest, D.Organize, D.Ask]);
  });

  test('map to copy keys', () => {
    expect(companionDropCopyKeys(D.Ocr)).toEqual({
      title: 'desktopCompanionDropOcr', detail: 'desktopCompanionDropOcrDetail', prompt: 'desktopCompanionDropOcrPrompt',
    });
  });
});
