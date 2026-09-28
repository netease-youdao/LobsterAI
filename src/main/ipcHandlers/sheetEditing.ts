import path from 'node:path';

import { app, type BrowserWindow } from 'electron';

import { SHEET_AGENT_TIMEOUT_MS, SheetAgentTool } from '../../shared/artifactPreview/sheetAgent';
import { SHEET_PACKAGE_LIMITS, SheetFileIpc, type SheetPackageInfo } from '../../shared/artifactPreview/sheetEditing';
import { OfficeAgentBridge } from '../libs/officeAgentBridge';
import { OfficeFileStore } from '../libs/officeFileStore';
import { inspectSheetPackage } from '../libs/sheetPackage';
import { registerOfficeFileHandlers } from './officeFileHandlers';

let unsafeEdits: () => boolean = () => false;
export const hasUnsafeSheetEdits = (): boolean => unsafeEdits();

/** Registers the Excel file and agent channels; returns the agent tool bridge. */
export function registerSheetEditingHandlers(getMainWindow: () => BrowserWindow | null): OfficeAgentBridge {
  const store = new OfficeFileStore<SheetPackageInfo>({
    extension: '.xlsx',
    maxFileBytes: SHEET_PACKAGE_LIMITS.maxFileBytes,
    inspect: inspectSheetPackage,
    logTag: '[SheetFiles]',
  }, path.join(app.getPath('userData'), 'sheet-drafts'));
  const agent = new OfficeAgentBridge({
    getWindow: getMainWindow,
    tools: Object.values(SheetAgentTool),
    requestChannel: SheetFileIpc.AgentRequest,
    timeoutMs: SHEET_AGENT_TIMEOUT_MS,
    editorName: 'Excel',
    logTag: '[SheetAgent]',
  });
  unsafeEdits = registerOfficeFileHandlers({
    channels: SheetFileIpc, store, agent, getMainWindow, editorName: 'Excel', logTag: '[SheetFiles]',
  }).hasUnsafeEdits;
  return agent;
}
