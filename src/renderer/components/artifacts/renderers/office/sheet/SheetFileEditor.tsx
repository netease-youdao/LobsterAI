import './sheetEditor.css';

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import type { SheetSelectionReference } from '@/services/office/sheet/sheetChatReference';
import { acquireSheetEditor, type SheetEditorSession } from '@/services/office/sheet/sheetEditorSession';
import { StructureRefusal } from '@/services/office/sheet/sheetStructureSupport';
import { SheetExportIssue } from '@/services/office/sheet/xlsxExport';

import { SheetHiddenContent, SheetReadOnlyReason } from '../../../../../../shared/office/sheet/sheetFile';
import {
type OfficeEditorLabels,   OfficeEditorLoader, OfficeEditorShell, officeList, useOfficeDocumentState, useOfficeEditorMount,
} from '../common/OfficeEditorShell';
import { useRegisterOfficePreviewZoomControls } from '../common/OfficePreviewActionsContext';
import { clampOfficeZoom, OfficeZoom } from '../common/OfficeZoomControls';
import { SheetToolbar } from './SheetToolbar';

const t = (key: string) => i18nService.t(key);
const SHEET_LABELS: OfficeEditorLabels<SheetReadOnlyReason> = {
  editor: 'sheetEditor',
  loading: 'sheetLoading',
  tooLarge: 'sheetTooLarge',
  unsupported: 'sheetUnsupported',
  accessFailed: 'sheetAccessFailed',
  inUse: 'sheetInUse',
  readOnly: 'sheetReadOnly',
  readOnlyReasons: {
    [SheetReadOnlyReason.Protection]: 'sheetReadOnlyProtection',
    [SheetReadOnlyReason.PivotTables]: 'sheetReadOnlyPivotTables',
    [SheetReadOnlyReason.ArrayFormulas]: 'sheetReadOnlyArrayFormulas',
    [SheetReadOnlyReason.ExternalLinks]: 'sheetReadOnlyExternalLinks',
    [SheetReadOnlyReason.DataConnections]: 'sheetReadOnlyDataConnections',
    [SheetReadOnlyReason.Signature]: 'sheetReadOnlySignature',
    [SheetReadOnlyReason.Macros]: 'sheetReadOnlyMacros',
  },
};
const HIDDEN_LABEL: Record<SheetHiddenContent, string> = {
  [SheetHiddenContent.Hyperlinks]: 'sheetHiddenHyperlinks',
  [SheetHiddenContent.ChartSheets]: 'sheetHiddenChartSheets',
  [SheetHiddenContent.Drawings]: 'sheetHiddenDrawings',
};
const ISSUE_LABEL: Record<string, string> = {
  [SheetExportIssue.Structure]: 'sheetIssueStructure',
  [SheetExportIssue.TableHeader]: 'sheetIssueTableHeader',
  [SheetExportIssue.Formula]: 'sheetIssueFormula',
};
const REFUSAL_LABEL: Record<StructureRefusal, string> = {
  [StructureRefusal.Unsupported]: 'sheetRefused',
  [StructureRefusal.FormControls]: 'sheetRefusedFormControls',
  [StructureRefusal.UnsupportedContent]: 'sheetRefusedUnsupportedContent',
  [StructureRefusal.ThreeDimensionalReferences]: 'sheetRefusedThreeDimensional',
  [StructureRefusal.TableColumns]: 'sheetRefusedTableColumns',
  [StructureRefusal.TableColumnInUse]: 'sheetRefusedTableColumnInUse',
  [StructureRefusal.TableRows]: 'sheetRefusedTableRows',
  [StructureRefusal.CopyWithContent]: 'sheetRefusedCopyWithContent',
  [StructureRefusal.TableInUse]: 'sheetRefusedTableInUse',
  [StructureRefusal.SortAttachments]: 'sheetRefusedSortAttachments',
  [StructureRefusal.ImageEdit]: 'sheetRefusedImageEdit',
  [StructureRefusal.ChartData]: 'sheetRefusedChartData',
  [StructureRefusal.ImageFormat]: 'sheetRefusedImageFormat',
};
/** How long the "not supported here" notice stays after an operation was refused. */
const REFUSAL_NOTICE_MS = 8000;

type AddToChat = (reference: SheetSelectionReference) => void;

function ActiveSheetEditor({ session, onAddToChat }: { session: SheetEditorSession; onAddToChat?: AddToChat }): React.ReactElement {
  const { document } = session;
  const state = useOfficeDocumentState(document);
  useSyncExternalStore(session.subscribe, session.getVersion);
  const host = useRef<HTMLDivElement>(null);
  useOfficeEditorMount(session, host);
  const [now, setNow] = useState(() => Date.now());
  const readOnly = state.readOnlyReasons.length > 0;
  // The grid's "Add to chat" reaches the task chat beside it; the latest callback is used.
  const addToChat = useRef(onAddToChat);
  addToChat.current = onAddToChat;
  const chatAvailable = Boolean(onAddToChat);
  useEffect(() => {
    session.setChatHandler(chatAvailable ? reference => addToChat.current?.(reference) : undefined);
    return () => session.setChatHandler(undefined);
  }, [session, chatAvailable]);
  const refusedAt = session.lastRefusal;
  useEffect(() => {
    if (!refusedAt) return undefined;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), REFUSAL_NOTICE_MS + 50);
    return () => clearTimeout(timer);
  }, [refusedAt]);
  const zoom = session.workbook?.getActiveSheet().getZoom() ?? 1;
  const zoomControls = useMemo(() => {
    const setZoom = (value: number) => { session.workbook?.getActiveSheet().zoom(clampOfficeZoom(value)); };
    return {
      zoomFactor: zoom,
      onZoomOut: () => setZoom(zoom - OfficeZoom.Step),
      onZoomIn: () => setZoom(zoom + OfficeZoom.Step),
      onResetZoom: () => setZoom(OfficeZoom.Default),
    };
  }, [session, zoom]);
  useRegisterOfficePreviewZoomControls(zoomControls);
  // Values this build does not know (from a main process of another version) are left out.
  const hidden = [
    ...document.packageInfo.hidden,
    ...(session.hiddenDrawings ? [SheetHiddenContent.Drawings] : []),
    ...(session.hiddenHyperlinks ? [SheetHiddenContent.Hyperlinks] : []),
  ].filter(item => HIDDEN_LABEL[item]);

  return (
    <OfficeEditorShell document={document} state={state} labels={SHEET_LABELS} className="lobster-sheet-editor"
      issueLabel={issue => t(ISSUE_LABEL[issue] ?? 'sheetIssueStructure')}
      notices={!readOnly && refusedAt > 0 && now - refusedAt < REFUSAL_NOTICE_MS && (
        <div className="lobster-office-notice" role="status">
          <p>{t(REFUSAL_LABEL[session.lastRefusalReason] ?? 'sheetRefused')}</p>
        </div>
      )}
      toolbar={<SheetToolbar session={session} disabled={state.needsResolution || !state.ready} />}
      footerStart={<span>{hidden.length ? t('sheetHiddenContent').replace('{items}', officeList(hidden.map(item => HIDDEN_LABEL[item]))) : ''}</span>}>
      <div className="lobster-sheet-mount" ref={host} />
    </OfficeEditorShell>
  );
}

export default function SheetFileEditor({ filePath, preview, onAddToChat }: {
  filePath: string; preview: React.ReactNode; onAddToChat?: AddToChat;
}): React.ReactElement {
  return (
    <OfficeEditorLoader filePath={filePath} acquire={acquireSheetEditor} labels={SHEET_LABELS} preview={preview}>
      {session => <ActiveSheetEditor session={session} onAddToChat={onAddToChat} />}
    </OfficeEditorLoader>
  );
}
