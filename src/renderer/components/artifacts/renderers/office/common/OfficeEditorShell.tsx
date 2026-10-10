import './officeEditor.css';

import { CheckIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';
import { type OfficeDocument, type OfficeDocumentState, OfficeSaveState } from '@/services/office/core/officeDocument';
import type { OfficeEditorSession } from '@/services/office/core/officeEditorSession';
import { openLocalPathWithToast, revealLocalPathWithToast } from '@/utils/localFileActions';

import { OfficeFileError, type OfficePackageInfo, type OfficeResult } from '../../../../../../shared/office/core/officeFile';

const t = (key: string) => i18nService.t(key);

/** The i18n keys of what differs between editors: their names, limits and read-only reasons. */
export interface OfficeEditorLabels<TReason extends string = string> {
  /** The editor's accessible name. */
  editor: string;
  loading: string;
  tooLarge: string;
  unsupported: string;
  accessFailed: string;
  /** Another program, such as Excel or WPS, holds the file open; shown on opening and while edits wait. */
  inUse: string;
  /** The read-only notice; `{reasons}` lists the reasons. */
  readOnly: string;
  readOnlyReasons: Record<TReason, string>;
}

const SAVE_LABEL: Record<Exclude<OfficeSaveState, typeof OfficeSaveState.Loading>, string> = {
  [OfficeSaveState.Saved]: 'officeSaved',
  [OfficeSaveState.Pending]: 'officePending',
  [OfficeSaveState.Saving]: 'officeSaving',
  [OfficeSaveState.Conflict]: 'officeConflict',
  [OfficeSaveState.Error]: 'officeSaveFailed',
};
const ConflictChoice = { Mine: 'mine', Disk: 'disk' } as const;
type ConflictChoice = typeof ConflictChoice[keyof typeof ConflictChoice];

/** Translated items joined the way the interface language lists things. */
export const officeList = (keys: string[]): string => keys.map(key => t(key)).join(t('officeListSeparator'));

export function officeErrorLabel(labels: OfficeEditorLabels, code?: OfficeFileError): string {
  if (code === OfficeFileError.TooLarge) return t(labels.tooLarge);
  if (code === OfficeFileError.Unsupported) return t(labels.unsupported);
  if (code === OfficeFileError.InUse) return `${t(labels.inUse)} ${t('officeInUseRetry')}`;
  return t(labels.accessFailed);
}

/** A document's save state, rendered as it changes. */
export function useOfficeDocumentState<TInfo extends OfficePackageInfo>(document: OfficeDocument<TInfo>): OfficeDocumentState<TInfo['readOnly'][number]> {
  return useSyncExternalStore(document.subscribe, document.getSnapshot);
}

/**
 * Shows the session's editor in `host` while the view is mounted. What is on disk is checked when
 * the editor appears and whenever the window regains focus.
 */
export function useOfficeEditorMount(session: OfficeEditorSession<OfficePackageInfo>, host: React.RefObject<HTMLElement>): void {
  const { document } = session;
  useEffect(() => {
    if (!host.current) return undefined;
    const unmount = session.mount(host.current);
    void document.refresh();
    return unmount;
  }, [session, document, host]);
  useEffect(() => {
    const onFocus = () => { void document.refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [document]);
}

/**
 * Opens a file's live editor. While it opens a status shows; when it cannot, the reason comes with
 * the read-only preview, the system app and a retry.
 */
export function OfficeEditorLoader<TSession extends OfficeEditorSession<OfficePackageInfo>>({ filePath, acquire, labels, preview, children }: {
  filePath: string;
  acquire: (filePath: string) => Promise<OfficeResult<TSession>>;
  labels: OfficeEditorLabels;
  preview: React.ReactNode;
  children: (session: TSession) => React.ReactElement;
}): React.ReactElement {
  const [result, setResult] = useState<OfficeResult<TSession>>();
  const [previewing, setPreviewing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    setPreviewing(false);
    void acquire(filePath).then(opened => { if (!cancelled) setResult(opened); });
    return () => { cancelled = true; };
  }, [acquire, filePath, attempt]);
  if (result?.success) return <React.Fragment key={result.value.document.file.sessionId}>{children(result.value)}</React.Fragment>;
  if (!result) return <div className="p-6 text-sm opacity-60" role="status">{t(labels.loading)}</div>;
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="lobster-office-notice" role="status">
        <p>{officeErrorLabel(labels, result.code)}</p>
        <div className="flex gap-2 mt-2">
          <button type="button" onClick={() => setPreviewing(true)}>{t('officePreview')}</button>
          <button type="button" onClick={() => { void openLocalPathWithToast(filePath); }}>{t('officeOpenExternal')}</button>
          <button type="button" onClick={() => setAttempt(value => value + 1)}>{t('retry')}</button>
        </div>
      </div>
      {previewing && <div className="flex-1 min-h-0">{preview}</div>}
    </div>
  );
}

/**
 * The frame every editor shares: save status, recovery and conflict choices, save errors and the
 * read-only notice around the format's toolbar and content.
 */
export function OfficeEditorShell<TInfo extends OfficePackageInfo>({
  document, state, labels, className, issueLabel, onKeyDown, toolbar, notices, footerStart, footerEnd, children,
}: {
  document: OfficeDocument<TInfo>;
  state: OfficeDocumentState<TInfo['readOnly'][number]>;
  labels: OfficeEditorLabels<TInfo['readOnly'][number]>;
  /** The format's class next to `lobster-office-editor`. */
  className: string;
  /** Why the format writer refused to save, for an export issue the document reports. */
  issueLabel?: (issue: string) => string;
  /** Format shortcuts; Cmd/Ctrl+S saves in every editor. */
  onKeyDown?: (event: React.KeyboardEvent) => void;
  /** Shown only while the file can be edited. */
  toolbar?: React.ReactNode;
  notices?: React.ReactNode;
  footerStart?: React.ReactNode;
  footerEnd?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  const [choice, setChoice] = useState<ConflictChoice | null>(null);
  const [resolving, setResolving] = useState(false);
  const readOnly = state.readOnlyReasons.length > 0;
  const resolve = async (next: ConflictChoice) => {
    if (choice !== next) { setChoice(next); return; }
    setResolving(true);
    try { await document.resolveConflict(next === ConflictChoice.Mine); } finally { setResolving(false); setChoice(null); }
  };
  const saveLabel = state.status === OfficeSaveState.Loading ? labels.loading : SAVE_LABEL[state.status];

  return (
    <section className={`lobster-office-editor ${className}`} aria-label={t(labels.editor)}
      onKeyDownCapture={event => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
          event.preventDefault(); event.stopPropagation(); void document.flush();
          return;
        }
        onKeyDown?.(event);
      }}>
      <div className="lobster-office-statusbar">
        {readOnly ? (
          <span className="text-xs" role="status">{t('officeReadOnlyStatus')}</span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs" role="status" aria-live="polite">
            {state.status === OfficeSaveState.Saved && <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />}
            {t(saveLabel)}
            {state.status !== OfficeSaveState.Saved && state.draftSafe && <span className="opacity-60">· {t('officeDraftSafe')}</span>}
          </span>
        )}
        {!readOnly && (
          <button type="button" disabled={resolving || state.status === OfficeSaveState.Saving || !document.dirty}
            onClick={() => { void document.flush(); }}>{t('save')}</button>
        )}
      </div>
      {state.needsResolution && (
        <div className="lobster-office-notice" role="alert">
          <p>{t(state.restored ? 'officeRecovered' : 'officeConflictHelp')}</p>
          {choice && <p className="font-medium">{t(choice === ConflictChoice.Mine ? 'officeConfirmMine' : 'officeConfirmDisk')}</p>}
          <div className="flex flex-wrap gap-2 mt-2">
            <button type="button" disabled={resolving} onClick={() => { void resolve(ConflictChoice.Mine); }}>{t('officeKeepMine')}</button>
            <button type="button" disabled={resolving} onClick={() => { void resolve(ConflictChoice.Disk); }}>{t('officeUseDisk')}</button>
            {choice && <button type="button" onClick={() => setChoice(null)}>{t('cancel')}</button>}
          </div>
        </div>
      )}
      {state.status === OfficeSaveState.Error && (
        <div className="lobster-office-notice" role="alert">
          <p>
            {state.issue && issueLabel ? issueLabel(state.issue) : officeErrorLabel(labels, state.errorCode)}
            {' '}{t(state.draftSafe ? 'officeDraftRetained' : 'officeDraftUnsafe')}
          </p>
          <button type="button" onClick={() => { void (document.dirty ? document.flush() : document.refresh()); }}>{t('retry')}</button>
        </div>
      )}
      {state.inUse && !readOnly && (
        <div className="lobster-office-notice" role="status">
          {/* While a version choice is pending, closing the file there saves nothing by itself. */}
          <p>{t(labels.inUse)}{state.needsResolution ? '' : ` ${t('officeInUseNotice')}`}</p>
        </div>
      )}
      {readOnly && (
        <div className="lobster-office-notice" role="status">
          <p>{t(labels.readOnly).replace('{reasons}', officeList(state.readOnlyReasons.map(reason => labels.readOnlyReasons[reason]).filter(Boolean)))}</p>
          <button type="button" className="mt-2" onClick={() => { void openLocalPathWithToast(document.file.filePath); }}>{t('officeOpenExternal')}</button>
        </div>
      )}
      {notices}
      {!readOnly && toolbar}
      {children}
      <div className="lobster-office-footer">
        {footerStart ?? <span />}
        {state.originalCopyPath && (
          <button type="button" onClick={() => { void revealLocalPathWithToast(state.originalCopyPath!); }}>{t('officeOriginalCopy')}</button>
        )}
        {footerEnd}
      </div>
    </section>
  );
}
