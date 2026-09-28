import './sheetEditor.css';

import { CheckIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { OfficeSaveState } from '@/services/officeDocument';
import type { SheetSelectionReference } from '@/services/sheet/sheetChatReference';
import { acquireSheetEditor, type SheetEditorSession } from '@/services/sheet/sheetEditorSession';
import { StructureRefusal } from '@/services/sheet/sheetStructureSupport';
import { SheetExportIssue } from '@/services/sheet/xlsxExport';
import { openLocalPathWithToast, revealLocalPathWithToast } from '@/utils/localFileActions';

import { OfficeFileError, type OfficeResult } from '../../../../../shared/artifactPreview/officeEditing';
import { SheetHiddenContent, SheetReadOnlyReason } from '../../../../../shared/artifactPreview/sheetEditing';
import { useRegisterOfficePreviewZoomControls } from '../OfficePreviewActionsContext';
import { SheetToolbar } from './SheetToolbar';

const t = (key: string) => i18nService.t(key);
const SAVE_LABEL = {
  [OfficeSaveState.Loading]: 'sheetLoading', [OfficeSaveState.Saved]: 'sheetSaved',
  [OfficeSaveState.Pending]: 'sheetPending', [OfficeSaveState.Saving]: 'sheetSaving',
  [OfficeSaveState.Conflict]: 'sheetConflict', [OfficeSaveState.Error]: 'sheetSaveFailed',
};
const READ_ONLY_LABEL: Record<SheetReadOnlyReason, string> = {
  [SheetReadOnlyReason.Protection]: 'sheetReadOnlyProtection',
  [SheetReadOnlyReason.PivotTables]: 'sheetReadOnlyPivotTables',
  [SheetReadOnlyReason.ArrayFormulas]: 'sheetReadOnlyArrayFormulas',
  [SheetReadOnlyReason.ExternalLinks]: 'sheetReadOnlyExternalLinks',
  [SheetReadOnlyReason.DataConnections]: 'sheetReadOnlyDataConnections',
  [SheetReadOnlyReason.Signature]: 'sheetReadOnlySignature',
  [SheetReadOnlyReason.Macros]: 'sheetReadOnlyMacros',
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
const ZOOM = { min: 0.25, max: 4, step: 0.1 } as const;
const ConflictChoice = { Mine: 'mine', Disk: 'disk' } as const;
type ConflictChoice = typeof ConflictChoice[keyof typeof ConflictChoice];

function errorLabel(code?: OfficeFileError): string {
  if (code === OfficeFileError.TooLarge) return t('sheetTooLarge');
  if (code === OfficeFileError.Unsupported) return t('sheetUnsupported');
  return t('sheetAccessFailed');
}

const list = (keys: string[]) => keys.map(key => t(key)).join(t('sheetListSeparator'));

type AddToChat = (reference: SheetSelectionReference) => void;

function ActiveSheetEditor({ session, onAddToChat }: { session: SheetEditorSession; onAddToChat?: AddToChat }): React.ReactElement {
  const document = session.document;
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
  useSyncExternalStore(session.subscribe, session.getVersion);
  const host = useRef<HTMLDivElement>(null);
  const [choice, setChoice] = useState<ConflictChoice | null>(null);
  const [resolving, setResolving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const readOnly = state.readOnlyReasons.length > 0;
  useEffect(() => {
    if (!host.current) return;
    const unmount = session.mount(host.current);
    void document.refresh();
    return unmount;
  }, [session, document]);
  // The grid's "Add to chat" reaches the task chat beside it; the latest callback is used.
  const addToChat = useRef(onAddToChat);
  addToChat.current = onAddToChat;
  const chatAvailable = Boolean(onAddToChat);
  useEffect(() => {
    session.setChatHandler(chatAvailable ? reference => addToChat.current?.(reference) : undefined);
    return () => session.setChatHandler(undefined);
  }, [session, chatAvailable]);
  useEffect(() => {
    const onFocus = () => { void document.refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [document]);
  const refusedAt = session.lastRefusal;
  useEffect(() => {
    if (!refusedAt) return undefined;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), REFUSAL_NOTICE_MS + 50);
    return () => clearTimeout(timer);
  }, [refusedAt]);
  const zoom = session.workbook?.getActiveSheet().getZoom() ?? 1;
  const zoomControls = useMemo(() => {
    const setZoom = (value: number) => {
      session.workbook?.getActiveSheet().zoom(Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(value * 100) / 100)));
    };
    return {
      zoomFactor: zoom,
      onZoomOut: () => setZoom(zoom - ZOOM.step),
      onZoomIn: () => setZoom(zoom + ZOOM.step),
      onResetZoom: () => setZoom(1),
    };
  }, [session, zoom]);
  useRegisterOfficePreviewZoomControls(zoomControls);

  const resolve = async (next: ConflictChoice) => {
    if (choice !== next) { setChoice(next); return; }
    setResolving(true);
    try { await document.resolveConflict(next === ConflictChoice.Mine); }
    finally { setResolving(false); setChoice(null); }
  };
  // Values this build does not know (from a main process of another version) are left out.
  const hidden = [
    ...document.packageInfo.hidden,
    ...(session.hiddenDrawings ? [SheetHiddenContent.Drawings] : []),
    ...(session.hiddenHyperlinks ? [SheetHiddenContent.Hyperlinks] : []),
  ].filter(item => HIDDEN_LABEL[item]);

  return (
    <section className="lobster-sheet-editor" aria-label={t('sheetEditor')}
      onKeyDownCapture={event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault(); event.stopPropagation(); void document.flush();
        }
      }}>
      <div className="lobster-sheet-statusbar">
        {readOnly ? (
          <span className="text-xs" role="status">{t('sheetReadOnlyStatus')}</span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs" role="status" aria-live="polite">
            {state.status === OfficeSaveState.Saved && <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />}
            {t(SAVE_LABEL[state.status])}
            {state.status !== OfficeSaveState.Saved && state.draftSafe && <span className="opacity-60">· {t('sheetDraftSafe')}</span>}
          </span>
        )}
        {!readOnly && (
          <button type="button" disabled={resolving || state.status === OfficeSaveState.Saving || !document.dirty}
            onClick={() => { void document.flush(); }}>{t('save')}</button>
        )}
      </div>
      {state.needsResolution && (
        <div className="lobster-sheet-notice" role="alert">
          <p>{t(state.restored ? 'sheetRecovered' : 'sheetConflictHelp')}</p>
          {choice && <p className="font-medium">{t(choice === ConflictChoice.Mine ? 'sheetConfirmMine' : 'sheetConfirmDisk')}</p>}
          <div className="flex flex-wrap gap-2 mt-2">
            <button type="button" disabled={resolving} onClick={() => { void resolve(ConflictChoice.Mine); }}>{t('sheetKeepMine')}</button>
            <button type="button" disabled={resolving} onClick={() => { void resolve(ConflictChoice.Disk); }}>{t('sheetUseDisk')}</button>
            {choice && <button type="button" onClick={() => setChoice(null)}>{t('cancel')}</button>}
          </div>
        </div>
      )}
      {state.status === OfficeSaveState.Error && (
        <div className="lobster-sheet-notice" role="alert">
          <p>
            {state.issue ? t(ISSUE_LABEL[state.issue] ?? 'sheetIssueStructure') : errorLabel(state.errorCode)}
            {' '}{t(state.draftSafe ? 'sheetDraftRetained' : 'sheetDraftUnsafe')}
          </p>
          <button type="button" onClick={() => { void (document.dirty ? document.flush() : document.refresh()); }}>{t('retry')}</button>
        </div>
      )}
      {readOnly && (
        <div className="lobster-sheet-notice" role="status">
          <p>{t('sheetReadOnly').replace('{reasons}', list(state.readOnlyReasons.map(reason => READ_ONLY_LABEL[reason])))}</p>
          <button type="button" className="mt-2" onClick={() => { void openLocalPathWithToast(document.file.filePath); }}>{t('sheetOpenExternal')}</button>
        </div>
      )}
      {!readOnly && refusedAt > 0 && now - refusedAt < REFUSAL_NOTICE_MS && (
        <div className="lobster-sheet-notice" role="status">
          <p>{t(REFUSAL_LABEL[session.lastRefusalReason] ?? 'sheetRefused')}</p>
        </div>
      )}
      {!readOnly && <SheetToolbar session={session} disabled={state.needsResolution || !state.ready} />}
      <div className="lobster-sheet-mount" ref={host} />
      <div className="lobster-sheet-footer">
        <span>{hidden.length ? t('sheetHiddenContent').replace('{items}', list(hidden.map(item => HIDDEN_LABEL[item]))) : ''}</span>
        {state.originalCopyPath && <button type="button" onClick={() => { void revealLocalPathWithToast(state.originalCopyPath!); }}>{t('sheetOriginalCopy')}</button>}
      </div>
    </section>
  );
}

export default function SheetFileEditor({ filePath, preview, onAddToChat }: {
  filePath: string; preview: React.ReactNode; onAddToChat?: AddToChat;
}): React.ReactElement {
  const [result, setResult] = useState<OfficeResult<SheetEditorSession>>();
  const [previewing, setPreviewing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    setPreviewing(false);
    void acquireSheetEditor(filePath).then(opened => { if (!cancelled) setResult(opened); });
    return () => { cancelled = true; };
  }, [filePath, attempt]);
  if (result?.success) return <ActiveSheetEditor key={result.value.document.file.sessionId} session={result.value} onAddToChat={onAddToChat} />;
  if (!result) return <div className="p-6 text-sm opacity-60" role="status">{t('sheetLoading')}</div>;
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="lobster-sheet-notice" role="status">
        <p>{errorLabel(result.code)}</p>
        <div className="flex gap-2 mt-2">
          <button type="button" onClick={() => setPreviewing(true)}>{t('sheetPreview')}</button>
          <button type="button" onClick={() => { void openLocalPathWithToast(filePath); }}>{t('sheetOpenExternal')}</button>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('retry')}</button>
        </div>
      </div>
      {previewing && <div className="flex-1 min-h-0">{preview}</div>}
    </div>
  );
}
