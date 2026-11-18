import { OfficeEditorId } from '../core/officeEditor';
import { type OfficeFileBridge, officeFileChannels, type OfficePackageInfo, type OfficePackageLimits } from '../core/officeFile';

export const SheetFileIpc = officeFileChannels(OfficeEditorId.Sheet);

/** Content the editor cannot keep consistent while cells change; such workbooks open read only. */
export const SheetReadOnlyReason = {
  Protection: 'protection',
  PivotTables: 'pivot-tables',
  ArrayFormulas: 'array-formulas',
  ExternalLinks: 'external-links',
  DataConnections: 'data-connections',
  Signature: 'signature',
  Macros: 'macros',
} as const;
export type SheetReadOnlyReason = typeof SheetReadOnlyReason[keyof typeof SheetReadOnlyReason];

/** Content saved back untouched but not shown by the editor. */
export const SheetHiddenContent = {
  /** Links the grid cannot show (on numbers or formulas, or to names); found by the renderer. */
  Hyperlinks: 'hyperlinks',
  ChartSheets: 'chart-sheets',
  /** Shapes, groups and pictures the editor cannot draw; found by the renderer when it loads the file. */
  Drawings: 'drawings',
} as const;
export type SheetHiddenContent = typeof SheetHiddenContent[keyof typeof SheetHiddenContent];

export interface SheetPackageInfo extends OfficePackageInfo<SheetReadOnlyReason> {
  hidden: SheetHiddenContent[];
}

export const SHEET_PACKAGE_LIMITS: OfficePackageLimits = {
  maxFileBytes: 20 * 1024 * 1024,
  maxExpandedBytes: 200 * 1024 * 1024,
  maxPartBytes: 100 * 1024 * 1024,
  maxParts: 4096,
};

/** Workbooks with more stored cells than this open in the read-only preview. */
export const SHEET_MAX_CELLS = 500_000;

export type SheetFileBridge = OfficeFileBridge<SheetPackageInfo>;
