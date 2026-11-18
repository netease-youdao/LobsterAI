import path from 'node:path';

import { ipcMain } from 'electron';

import { OfficeFileError } from '../../../shared/office/core/officeFile';
import { WORD_EDITOR } from '../../../shared/office/editors';
import { WORD_PACKAGE_LIMITS, WordFileIpc, type WordPackageInfo } from '../../../shared/office/word/wordFile';
import type { MainOfficeFormat } from '../officeEditing';
import { defaultWordFontDirectories, WordFontCatalog } from './fonts/fontCatalog';
import { inspectWordPackage } from './wordPackage';

export const WORD_FORMAT: MainOfficeFormat<WordPackageInfo> = {
  spec: WORD_EDITOR,
  limits: WORD_PACKAGE_LIMITS,
  inspect: inspectWordPackage,
  fileLogTag: '[WordFiles]',
  agentLogTag: '[WordAgent]',
  registerExtraHandlers: ({ allowed, userDataPath }) => {
    // Installed fonts are read in place for layout only; they are never copied into documents.
    const fonts = new WordFontCatalog({
      directories: defaultWordFontDirectories(),
      cachePath: path.join(userDataPath, 'word-fonts', 'catalog.json'),
    });
    const forbidden = { success: false, code: OfficeFileError.Forbidden } as const;
    ipcMain.handle(WordFileIpc.ResolveFonts, async (event, families: unknown) => {
      if (!allowed(event)) return forbidden;
      if (!Array.isArray(families) || families.some(family => typeof family !== 'string')) {
        return { success: false, code: OfficeFileError.InvalidFile };
      }
      try {
        return { success: true, value: { faces: await fonts.resolve(families as string[]) } };
      } catch (error) {
        console.error('[WordFonts] Could not resolve installed fonts:', error);
        return { success: false, code: OfficeFileError.Io };
      }
    });
    ipcMain.handle(WordFileIpc.ReadFont, async (event, faceId: unknown) => {
      if (!allowed(event)) return forbidden;
      if (typeof faceId !== 'string') return { success: false, code: OfficeFileError.InvalidFile };
      try {
        return { success: true, value: new Uint8Array(await fonts.readFace(faceId)) };
      } catch (error) {
        console.warn('[WordFonts] Could not read installed font face:', error);
        return { success: false, code: OfficeFileError.Io };
      }
    });
  },
};
