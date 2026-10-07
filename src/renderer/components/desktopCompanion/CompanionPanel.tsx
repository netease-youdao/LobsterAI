import {
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  ArrowUpIcon,
  FolderIcon,
  PaperClipIcon,
  PlusIcon,
  StopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type DesktopCompanionAttachment,
  type DesktopCompanionDraft,
  type DesktopCompanionState,
} from '../../../shared/desktopCompanion/constants';
import { hasCompanionHint } from '../../../shared/desktopCompanion/hintPolicy';
import { prepareCoworkPromptPayload } from '../../services/coworkPromptPayload';
import { i18nService } from '../../services/i18n';
import { CoworkSessionStatusValue } from '../../types/cowork';
import { companionPhase, companionReply } from './companionPresentation';
import { fileName, hasFiles, startCompanionTask } from './companionTasks';
import CompanionCharacter from './mascot/CompanionCharacter';
import { CompanionMood } from './mascot/companionMood';
import { useCompanionRecentSessions, useCompanionSession } from './useCompanionSession';

const t = (key: string) => i18nService.t(key);
const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const MAX_ATTACHMENTS = 20;
const MAX_PASTE_BYTES = 25 * 1024 * 1024;

interface Suggestion { label: string; prompt: string; contextual?: boolean }

function suggestionsFor(state: DesktopCompanionState): Suggestion[] {
  const generic: Suggestion[] = [
    { label: t('desktopCompanionSuggestReport'), prompt: t('desktopCompanionSuggestReportPrompt') },
    { label: t('desktopCompanionSuggestEmail'), prompt: t('desktopCompanionSuggestEmailPrompt') },
  ];
  const category = state.foreground?.category;
  if (!hasCompanionHint(category)) return generic;
  const name = capitalize(category);
  return [{ label: t(`desktopCompanionSuggest${name}`), prompt: t(`desktopCompanionPrompt${name}`), contextual: true }, ...generic];
}

export default function CompanionPanel({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const [draft, setDraft] = useState(state.draft);
  const draftRef = useRef(draft);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [addingFiles, setAddingFiles] = useState(false);
  const addingFilesRef = useRef(false);
  const [dropActive, setDropActive] = useState(false);
  const [defaultFolder, setDefaultFolder] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { session, pending, failed, loading, refresh } = useCompanionSession(state.sessionId, state.panelVisible);
  const recent = useCompanionRecentSessions(state.panelVisible);
  const running = session?.status === CoworkSessionStatusValue.Running;
  const phase = companionPhase(session, pending);
  const reply = companionReply(session);
  const locked = sending || addingFiles;
  const folder = session?.cwd || draft.workingDirectory || defaultFolder;

  // Drafts can change from other surfaces (a hint, a drop, a selection).
  useEffect(() => {
    draftRef.current = state.draft;
    setDraft(state.draft);
  }, [state.draft]);

  const patchDraft = useCallback((patch: Partial<DesktopCompanionDraft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    void window.electron.desktopCompanion.setDraft(next).catch(() => setError(i18nService.t('desktopCompanionRequestFailed')));
  }, []);

  useEffect(() => {
    let active = true;
    void window.electron.cowork.getConfig().then(result => {
      if (active && result.success && result.config?.workingDirectory) setDefaultFolder(result.config.workingDirectory);
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!state.panelVisible) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [state.panelVisible, state.sessionId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        void window.electron.desktopCompanion.hidePanel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const chooseFolder = async () => {
    try {
      const result = await window.electron.dialog.selectDirectory();
      if (result.success && result.path) patchDraft({ workingDirectory: result.path });
    } catch {
      setError(t('desktopCompanionRequestFailed'));
    }
  };

  const appendPaths = async (paths: string[], names = new Map<string, string>()) => {
    const additions: DesktopCompanionAttachment[] = [];
    for (const filePath of paths) {
      const stat = await window.electron.dialog.statFile(filePath);
      if (!stat.success || (!stat.isDirectory && !stat.isFile)) throw new Error(t('desktopCompanionAttachmentFailed'));
      additions.push({
        path: filePath,
        name: names.get(filePath) || fileName(filePath),
        isDirectory: stat.isDirectory,
        isImage: !stat.isDirectory && /\.(png|jpe?g|webp|gif|bmp)$/i.test(filePath),
      });
    }
    const files = [...new Map([...draftRef.current.attachments, ...additions].map(file => [file.path, file])).values()];
    if (files.length > MAX_ATTACHMENTS) setError(t('desktopCompanionAttachmentLimit'));
    patchDraft({ attachments: files.slice(0, MAX_ATTACHMENTS) });
  };

  const withFiles = async (operation: () => Promise<void>) => {
    if (sendingRef.current || addingFilesRef.current) return;
    addingFilesRef.current = true;
    setAddingFiles(true);
    setError('');
    try { await operation(); } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('desktopCompanionAttachmentFailed'));
    } finally {
      addingFilesRef.current = false;
      setAddingFiles(false);
    }
  };

  const addFiles = () => withFiles(async () => {
    const result = await window.electron.dialog.selectFiles();
    if (result.success) await appendPaths(result.paths);
  });

  const receiveFiles = (files: File[]) => withFiles(async () => {
    const paths: string[] = [];
    const names = new Map<string, string>();
    for (const file of files) {
      const nativePath = window.electron.dialog.getPathForFile?.(file);
      if (nativePath) { paths.push(nativePath); names.set(nativePath, file.name); continue; }
      // Pasted screenshots have no path; save them next to the task first.
      if (file.size > MAX_PASTE_BYTES) throw new Error(t('desktopCompanionFileTooLarge'));
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(t('desktopCompanionAttachmentFailed')));
        reader.readAsDataURL(file);
      });
      const result = await window.electron.dialog.saveInlineFile({
        dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        fileName: file.name,
        mimeType: file.type,
        cwd: folder || undefined,
      });
      if (!result.success || !result.path) throw new Error(result.error || t('desktopCompanionAttachmentFailed'));
      paths.push(result.path);
      names.set(result.path, file.name);
    }
    await appendPaths(paths, names);
  });

  const send = async () => {
    if (sendingRef.current || addingFilesRef.current || running || pending || loading || (state.sessionId && !session)) return;
    const snapshot = draftRef.current;
    if (!snapshot.prompt.trim()) { setError(t('desktopCompanionEmptyPrompt')); inputRef.current?.focus(); return; }
    sendingRef.current = true;
    setSending(true);
    setError('');
    try {
      let sessionId: string;
      if (session) {
        const prepared = await prepareCoworkPromptPayload({
          basePrompt: snapshot.prompt.trim(),
          attachments: snapshot.attachments,
          selectedTextSnippets: [],
          modelSupportsImage: false,
          fileLabel: t('file'),
          folderLabel: t('folder'),
        });
        if (!prepared.success) { setError(t('desktopCompanionImageFailed')); return; }
        const result = await window.electron.cowork.continueSession({
          sessionId: session.id,
          prompt: prepared.payload.finalPrompt,
          imageAttachments: prepared.payload.imageAttachments,
          mediaReferences: prepared.payload.mediaReferences,
        });
        if (!result.success || !result.session) { setError(result.error || t('desktopCompanionRequestFailed')); return; }
        sessionId = result.session.id;
      } else {
        const result = await startCompanionTask({ prompt: snapshot.prompt, attachments: snapshot.attachments, workingDirectory: snapshot.workingDirectory });
        if ('error' in result) { setError(result.error); return; }
        sessionId = result.sessionId;
      }
      // Only clear a draft after the session API accepts the request.
      patchDraft({ prompt: '', attachments: [] });
      await api.selectSession(sessionId);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('desktopCompanionRequestFailed'));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const openMain = (sessionId = state.sessionId) => {
    void api.openMain(sessionId).catch(() => setError(t('desktopCompanionRequestFailed')));
  };
  const backToList = () => {
    setError('');
    void api.selectSession(null).catch(() => setError(t('desktopCompanionRequestFailed')));
    inputRef.current?.focus();
  };

  const mood = running ? CompanionMood.Working : pending ? CompanionMood.Attention : CompanionMood.Happy;
  const tasks = recent.slice(0, 4);

  return (
    <main
      className="companion-panel"
      aria-label={t('desktopCompanionTitle')}
      onDragOver={event => {
        if (!hasFiles(event.dataTransfer) || locked) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
      onDrop={event => {
        event.preventDefault();
        setDropActive(false);
        if (!locked && event.dataTransfer.files.length) void receiveFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="panel-header">
        {state.sessionId
          ? <button type="button" className="panel-icon" title={t('desktopCompanionBackToTasks')} aria-label={t('desktopCompanionBackToTasks')} disabled={locked} onClick={backToList}><ArrowLeftIcon /></button>
          : <CompanionCharacter skin={state.preferences.skin} mood={mood} size={26} showBadge={false} />}
        <h1 className="panel-title">{state.sessionId ? session?.title || t('desktopCompanionLoading') : t('desktopCompanionGreeting')}</h1>
        {!state.sessionId && <button type="button" className="panel-icon" title={t('desktopCompanionNew')} aria-label={t('desktopCompanionNew')} disabled={locked} onClick={backToList}><PlusIcon /></button>}
        <button type="button" className="panel-icon" title={t('desktopCompanionOpenMain')} aria-label={t('desktopCompanionOpenMain')} onClick={() => openMain()}><ArrowTopRightOnSquareIcon /></button>
        <button type="button" className="panel-icon" title={t('desktopCompanionHide')} aria-label={t('desktopCompanionHide')} onClick={() => { void api.hidePanel(); }}><XMarkIcon /></button>
      </header>

      {state.sessionId && (
        <section className="panel-task" aria-busy={running || loading}>
          <div className="task-heading">
            <span className="task-status" data-phase={phase.value}>{t(phase.key)}</span>
            {running && session && (
              <button type="button" className="panel-link" disabled={locked} onClick={() => {
                void window.electron.cowork.stopSession(session.id).then(result => {
                  if (!result.success) setError(result.error || t('desktopCompanionRequestFailed'));
                  refresh();
                }).catch(() => setError(t('desktopCompanionRequestFailed')));
              }}><StopIcon />{t('desktopCompanionStop')}</button>
            )}
          </div>
          {pending ? <p className="task-message">{t('desktopCompanionWaitingHint')}</p>
            : failed ? <p role="alert" className="task-message">{t('desktopCompanionSessionMissing')}</p>
              : <p className="task-reply">{reply || t(loading ? 'desktopCompanionLoading' : running ? 'desktopCompanionKeepRunning' : 'desktopCompanionNoReply')}</p>}
          <button type="button" className="task-open" onClick={() => openMain()}>
            {t(pending ? 'desktopCompanionOpenMain' : 'desktopCompanionViewResult')}<ArrowTopRightOnSquareIcon />
          </button>
        </section>
      )}

      <form className="panel-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        <textarea
          ref={inputRef}
          aria-label={t('desktopCompanionPlaceholder')}
          placeholder={t(state.sessionId ? 'desktopCompanionContinuePlaceholder' : 'desktopCompanionPlaceholder')}
          value={draft.prompt}
          maxLength={64_000}
          disabled={sending}
          onChange={event => patchDraft({ prompt: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          onPaste={event => {
            if (event.clipboardData.files.length) { event.preventDefault(); void receiveFiles(Array.from(event.clipboardData.files)); }
          }}
        />
        {draft.attachments.length > 0 && (
          <div className="panel-attachments">
            {draft.attachments.map(file => (
              <span className="attachment-chip" key={file.path} title={file.path}>
                {file.isDirectory ? <FolderIcon /> : <PaperClipIcon />}<span>{file.name}</span>
                <button type="button" disabled={locked} title={t('desktopCompanionRemoveFile')} aria-label={`${t('desktopCompanionRemoveFile')}: ${file.name}`}
                  onClick={() => patchDraft({ attachments: draft.attachments.filter(item => item.path !== file.path) })}><XMarkIcon /></button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button type="button" className="composer-pill" disabled={locked} onClick={() => { void addFiles(); }}><PaperClipIcon />{t('desktopCompanionAddFiles')}</button>
          <button type="button" className="composer-pill" disabled={locked || !!state.sessionId} title={folder || t('desktopCompanionFolderHint')} onClick={() => { void chooseFolder(); }}>
            <FolderIcon /><span>{folder ? fileName(folder) : t('desktopCompanionChooseFolder')}</span>
          </button>
          <button
            type="submit"
            className="composer-send"
            aria-label={t(sending ? 'desktopCompanionSending' : state.sessionId ? 'desktopCompanionContinue' : 'desktopCompanionSend')}
            title={t(sending ? 'desktopCompanionSending' : state.sessionId ? 'desktopCompanionContinue' : 'desktopCompanionSend')}
            disabled={locked || running || pending || loading || !draft.prompt.trim() || !!(state.sessionId && !session)}
          ><ArrowUpIcon /></button>
        </div>
      </form>
      {error && <div className="panel-error" role="alert"><span>{error}</span><button type="button" onClick={() => openMain()}>{t('desktopCompanionOpenMain')}</button></div>}

      {!state.sessionId && (
        <>
          <div className="panel-suggestions" aria-label={t('desktopCompanionTry')}>
            {suggestionsFor(state).map(item => (
              <button type="button" key={item.label} className="suggestion" data-contextual={item.contextual === true} disabled={locked}
                onClick={() => { patchDraft({ prompt: item.prompt }); inputRef.current?.focus(); }}>
                {item.label}
              </button>
            ))}
          </div>
          <section className="panel-tasks">
            <h2>{t('desktopCompanionTasks')}</h2>
            {tasks.length === 0 && <p className="tasks-empty">{t('desktopCompanionTasksEmpty')}</p>}
            {tasks.map(item => {
              const itemPhase = companionPhase(item, false);
              return (
                <button type="button" key={item.id} className="task-row" disabled={locked} onClick={() => { void api.selectSession(item.id); }}>
                  <span className="task-dot" data-phase={itemPhase.value} />
                  <span className="task-name">{item.title}</span>
                  <span className="task-meta">{t(itemPhase.key)}</span>
                </button>
              );
            })}
          </section>
        </>
      )}

      <footer className="panel-footer">
        <span>{state.preferences.shortcut ? t('desktopCompanionShortcutTip').replace('{shortcut}', state.preferences.shortcut) : ''}</span>
        <button type="button" onClick={() => openMain(null)}>{t('desktopCompanionOpenApp')}<ArrowTopRightOnSquareIcon /></button>
      </footer>
      {dropActive && <div className="panel-drop"><PaperClipIcon /><strong>{t('desktopCompanionDrop')}</strong></div>}
    </main>
  );
}
