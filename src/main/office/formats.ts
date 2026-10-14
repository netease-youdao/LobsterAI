import type { MainOfficeFormat } from './officeEditing';
import { SHEET_FORMAT } from './sheet/sheetFormat';
import { SLIDES_FORMAT } from './slides/slidesFormat';
import { WORD_FORMAT } from './word/wordFormat';

/** The main-process side of every editor in OFFICE_EDITORS, in the same order. */
export const MAIN_OFFICE_FORMATS: readonly MainOfficeFormat[] = [WORD_FORMAT, SHEET_FORMAT, SLIDES_FORMAT];
