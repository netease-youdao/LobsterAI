import './sheetEditor.css';

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { OfficeSaveState } from '@/services/office/core/officeDocument';
import type { SheetSelectionReference } from '@/services/office/sheet/sheetChatReference';
import { acquireSheetEditor, type SheetEditorSession } from '@/services/office/sheet/sheetEditorSession';
import { StructureRefusal } from '@/services/office/sheet/sheetStructureSupport';
import { formatFormulaPreview, shouldAutoExpandFormulaBar } from '@/services/office/sheet/sheetToolbarLayout';
import { SheetExportIssue } from '@/services/office/sheet/xlsxExport';

import { SheetHiddenContent, SheetReadOnlyReason } from '../../../../../../shared/office/sheet/sheetFile';
import {
  type OfficeEditorLabels, OfficeEditorLoader, OfficeEditorShell, officeList, useOfficeDocumentState, useOfficeEditorMount,
} from '../common/OfficeEditorShell';
import {
  useOfficePreviewActions,
  useRegisterOfficeOwnsDocumentToolbar,
  useRegisterOfficePreviewZoomControls,
} from '../common/OfficePreviewActionsContext';
import { clampOfficeZoom, OfficeZoom } from '../common/OfficeZoomControls';
import { SheetHeaderBar } from './SheetHeaderBar';
import { SheetTabBar } from './SheetTabBar';
import { SheetToolbar } from './SheetToolbar';

const t = (key: string) => i18nService.t(key);
const SLOW_SAVE_NOTICE_MS = 800;
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

function ActiveSheetEditor({
  session,
  filePath,
  onAddToChat,
}: {
  session: SheetEditorSession;
  filePath: string;
  onAddToChat?: AddToChat;
}): React.ReactElement {
  const { document } = session;
  const state = useOfficeDocumentState(document);
  useSyncExternalStore(session.subscribe, session.getVersion);

  // Claim the host ArtifactDocumentToolbar so Excel renders one unified top bar without an empty row.
  useRegisterOfficeOwnsDocumentToolbar(true);
  const previewActions = useOfficePreviewActions();

  // Read-first default: formatting toolbar and formula bar stay collapsed until opened or needed.
  const [isFormatBarOpen, setIsFormatBarOpen] = useState(false);
  const [isFormulaBarOpen, setIsFormulaBarOpen] = useState(false);
  const [showSlowSaving, setShowSlowSaving] = useState(false);

  const host = useRef<HTMLDivElement>(null);
  useOfficeEditorMount(session, host);
  const [now, setNow] = useState(() => Date.now());
  const readOnly = state.readOnlyReasons.length > 0;
  const toolbarDisabled = state.needsResolution || !state.ready;

  useEffect(() => {
    if (readOnly || state.status !== OfficeSaveState.Saving) {
      setShowSlowSaving(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShowSlowSaving(true), SLOW_SAVE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [readOnly, state.status]);

  // Trigger a layout sync when toggling the formula bar so Univer's canvas matches the updated viewport.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isFormulaBarOpen, isFormatBarOpen]);

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

  const formulaPreview = formatFormulaPreview(session.activeFormula());

  const handleMountKeyDownCapture = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isFormulaBarOpen) return;
    if (shouldAutoExpandFormulaBar({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      isComposing: Boolean(event.nativeEvent.isComposing),
      readOnly,
      editing: session.isCellEditing(),
      editorText: session.currentCellEditorText(),
    })) {
      setIsFormulaBarOpen(true);
    }
  }, [isFormulaBarOpen, readOnly, session]);

  // Values this build does not know (from a main process of another version) are left out.
  const hidden = [
    ...document.packageInfo.hidden,
    ...(session.hiddenDrawings ? [SheetHiddenContent.Drawings] : []),
    ...(session.hiddenHyperlinks ? [SheetHiddenContent.Hyperlinks] : []),
  ].filter(item => HIDDEN_LABEL[item]);
  const hiddenContentNotice = hidden.length
    ? t('sheetHiddenContent').replace('{items}', officeList(hidden.map(item => HIDDEN_LABEL[item])))
    : undefined;

  return (
    <OfficeEditorShell
      document={document}
      state={state}
      labels={SHEET_LABELS}
      className={isFormulaBarOpen ? 'lobster-sheet-editor' : 'lobster-sheet-editor lobster-sheet-formula-hidden'}
      keepToolbarWhenReadOnly
      hideFooter
      issueLabel={issue => t(ISSUE_LABEL[issue] ?? 'sheetIssueStructure')}
      notices={!readOnly && refusedAt > 0 && now - refusedAt < REFUSAL_NOTICE_MS && (
        <div className="lobster-office-notice" role="status">
          <p>{t(REFUSAL_LABEL[session.lastRefusalReason] ?? 'sheetRefused')}</p>
        </div>
      )}
      toolbar={(
        <div className="lobster-sheet-chrome">
          <SheetHeaderBar
            session={session}
            isFormatBarOpen={isFormatBarOpen}
            onToggleFormatBar={() => setIsFormatBarOpen(open => !open)}
            isFormulaBarOpen={isFormulaBarOpen}
            onToggleFormulaBar={() => setIsFormulaBarOpen(open => !open)}
            formulaPreview={formulaPreview}
            disabled={toolbarDisabled}
            readOnly={readOnly}
            showSlowSaving={showSlowSaving}
            filePath={filePath}
            zoomControls={zoomControls}
            documentActions={previewActions?.documentActions}
          />
          {isFormatBarOpen && !readOnly && <SheetToolbar session={session} disabled={toolbarDisabled} />}
        </div>
      )}
    >
      <div className="lobster-sheet-mount" ref={host} onKeyDownCapture={handleMountKeyDownCapture} />
      <SheetTabBar
        session={session}
        disabled={toolbarDisabled}
        readOnly={readOnly}
        hiddenContentNotice={hiddenContentNotice}
      />
    </OfficeEditorShell>
  );
}

export default function SheetFileEditor({ filePath, preview, onAddToChat }: {
  filePath: string; preview: React.ReactNode; onAddToChat?: AddToChat;
}): React.ReactElement {
  return (
    <OfficeEditorLoader filePath={filePath} acquire={acquireSheetEditor} labels={SHEET_LABELS} preview={preview}>
      {session => <ActiveSheetEditor session={session} filePath={filePath} onAddToChat={onAddToChat} />}
    </OfficeEditorLoader>
  );
}
