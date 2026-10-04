import { SHEET_EDITOR } from '../../../shared/office/editors';
import { SHEET_PACKAGE_LIMITS, type SheetPackageInfo } from '../../../shared/office/sheet/sheetFile';
import type { MainOfficeFormat } from '../officeEditing';
import { inspectSheetPackage } from './sheetPackage';

export const SHEET_FORMAT: MainOfficeFormat<SheetPackageInfo> = {
  spec: SHEET_EDITOR,
  limits: SHEET_PACKAGE_LIMITS,
  inspect: inspectSheetPackage,
  fileLogTag: '[SheetFiles]',
  agentLogTag: '[SheetAgent]',
};
