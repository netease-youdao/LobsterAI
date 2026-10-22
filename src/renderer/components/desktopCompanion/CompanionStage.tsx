import { PaperClipIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import { CompanionAnalyticsAction, CompanionAnalyticsOutcome, CompanionAnalyticsSource, CompanionAnalyticsStage,
  companionTaskFailure, CompanionTaskFailureStage } from '../../../shared/desktopCompanion/analytics';
import {
  type DesktopCompanionStage,
  DesktopCompanionStageCommandType,
  DesktopCompanionStageKind,
  type DesktopCompanionState,
  DesktopCompanionTiming,
} from '../../../shared/desktopCompanion/constants';
import {
  CompanionDropAction,
  companionDropActions,
  companionDropCopyKeys,
  type CompanionFileKind,
} from '../../../shared/desktopCompanion/fileKinds';
import { COMPANION_WELCOME_TOPIC, companionHintCopyKeys } from '../../../shared/desktopCompanion/hintPolicy';
import { i18nService } from '../../services/i18n';
import { beginCompanionTask, reportCompanionAnalytics } from './analytics';
import { CompanionPhase, companionPhase } from './companionPresentation';
import { fileKindsFromDataTransfer, filesToAttachments, hasFiles, startCompanionTask } from './companionTasks';
import { useCompanionSession } from './useCompanionSession';
import { useMeasuredSurface } from './useMeasuredSurface';

const t = (key: string) => i18nService.t(key);

type HintStage = Extract<DesktopCompanionStage, { kind: typeof DesktopCompanionStageKind.Hint }>;
type DropStage = Extract<DesktopCompanionStage, { kind: typeof DesktopCompanionStageKind.Drop }>;
type TaskStage = Extract<DesktopCompanionStage, { kind: typeof DesktopCompanionStageKind.Task }>;

function HintBubble({ stage }: { stage: HintStage }) {
  const api = window.electron.desktopCompanion;
  const [hovering, setHovering] = useState(false);
  const keys = companionHintCopyKeys(stage.topic, stage.variant);
  useEffect(() => {
    if (hovering) return;
    const timer = setTimeout(() => {
      void api.stageCommand({ type: DesktopCompanionStageCommandType.HintTimeout });
    }, DesktopCompanionTiming.HintAutoDismissMs);
    return () => clearTimeout(timer);
  }, [api, hovering, stage.id]);
  const hover = (value: boolean) => {
    setHovering(value);
    void api.stageCommand({ type: DesktopCompanionStageCommandType.StageHover, hovering: value });
  };
  return (
    <div className="stage-bubble" role="status" onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
      <p className="bubble-message">{t(keys.message)}</p>
      <div className="bubble-actions">
        <button type="button" className="bubble-primary" onClick={() => { void api.stageCommand({ type: DesktopCompanionStageCommandType.HintAccept }); }}>
          {t(keys.action)}
        </button>
        <button type="button" className="bubble-text" onClick={() => { void api.stageCommand({ type: DesktopCompanionStageCommandType.HintDismiss }); }}>
          {t('desktopCompanionHintDismiss')}
        </button>
        {stage.topic !== COMPANION_WELCOME_TOPIC && (
          <button type="button" className="bubble-mute" onClick={() => { void api.stageCommand({ type: DesktopCompanionStageCommandType.HintMute }); }}>
            {t('desktopCompanionHintMute')}
          </button>
        )}
      </div>
    </div>
  );
}

/** How a task handed to the orb is doing; opens the corresponding task in the main window. */
function TaskStrip({ stage }: { stage: TaskStage }) {
  const api = window.electron.desktopCompanion;
  const [hovering, setHovering] = useState(false);
  const { session, pending } = useCompanionSession(stage.sessionId, true);
  const phase = companionPhase(session, pending);
  const running = phase.value === CompanionPhase.Running;
  const over = phase.value === CompanionPhase.Completed || phase.value === CompanionPhase.Error || phase.value === CompanionPhase.Paused;
  // Once the task is over the strip steps aside after a while; the orb keeps the news.
  useEffect(() => {
    if (!over || hovering) return;
    const timer = setTimeout(() => {
      void api.stageCommand({ type: DesktopCompanionStageCommandType.TaskDismiss });
    }, DesktopCompanionTiming.HintAutoDismissMs);
    return () => clearTimeout(timer);
  }, [api, hovering, over]);
  const hover = (value: boolean) => {
    setHovering(value);
    void api.stageCommand({ type: DesktopCompanionStageCommandType.StageHover, hovering: value });
  };
  return (
    <div className="stage-task" role="status" onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
      <span className="task-status" data-phase={phase.value}>{t(phase.key)}</span>
      <span className="task-title" title={session?.title}>{session?.title || t('desktopCompanionLoading')}</span>
      {running && (
        <button type="button" className="bubble-text" onClick={() => { void window.electron.cowork.stopSession(stage.sessionId); }}>
          {t('desktopCompanionStop')}
        </button>
      )}
      <button type="button" className="bubble-primary" onClick={() => { void api.stageCommand({ type: DesktopCompanionStageCommandType.TaskOpen }); }}>
        {t(pending ? 'desktopCompanionTaskHandle' : 'desktopCompanionTaskView')}
      </button>
      <button type="button" className="task-close" title={t('desktopCompanionHide')} aria-label={t('desktopCompanionHide')}
        onClick={() => { void api.stageCommand({ type: DesktopCompanionStageCommandType.TaskDismiss }); }}><XMarkIcon /></button>
    </div>
  );
}

const StartStatus = { Idle: 'idle', Starting: 'starting', Failed: 'failed' } as const;
type StartStatus = typeof StartStatus[keyof typeof StartStatus];

function DropZone({ stage }: { stage: DropStage }) {
  const api = window.electron.desktopCompanion;
  const depth = useRef(0);
  const received = useRef(false);
  const dismissTimer = useRef<ReturnType<typeof setTimeout>>();
  const [hoverKinds, setHoverKinds] = useState<CompanionFileKind[]>([]);
  const [active, setActive] = useState<CompanionDropAction | null>(null);
  const [status, setStatus] = useState<StartStatus>(StartStatus.Idle);
  const kinds = stage.kinds.length ? stage.kinds : hoverKinds;
  const actions = companionDropActions(kinds);
  const first = stage.files[0];
  useEffect(() => () => clearTimeout(dismissTimer.current), []);

  const run = async (event: React.DragEvent, action: CompanionDropAction) => {
    event.preventDefault();
    event.stopPropagation();
    if (received.current || !hasFiles(event.dataTransfer)) return;
    received.current = true;
    depth.current = 0;
    setActive(null);
    setStatus(StartStatus.Starting);
    const analytics = { action: CompanionAnalyticsAction.FileDrop, source: CompanionAnalyticsSource.FileDrop, dropAction: action };
    reportCompanionAnalytics({ ...analytics, stage: CompanionAnalyticsStage.Submit });
    let outcome: CompanionAnalyticsOutcome = CompanionAnalyticsOutcome.Failed;
    let attachmentCount = 0;
    let finishTask: ReturnType<typeof beginCompanionTask> | undefined;
    let failureStage: CompanionTaskFailureStage = CompanionTaskFailureStage.Prepare;
    // Keep the strip steady while the drop is being resolved, even after mouse-up.
    void api.stageCommand({ type: DesktopCompanionStageCommandType.StageHover, hovering: true });
    try {
      const attachments = await filesToAttachments(Array.from(event.dataTransfer.files));
      attachmentCount = attachments.length;
      if (!attachments.length) { void api.stageCommand({ type: DesktopCompanionStageCommandType.DropCancel }); return; }
      if (action === CompanionDropAction.Ask) {
        await api.stageCommand({ type: DesktopCompanionStageCommandType.DropAsk, attachments });
        outcome = CompanionAnalyticsOutcome.Success;
        return;
      }
      finishTask = beginCompanionTask(CompanionAnalyticsSource.FileDrop);
      const result = await startCompanionTask({ prompt: t(companionDropCopyKeys(action).prompt), attachments }, stage => { failureStage = stage; });
      if ('sessionId' in result) {
        finishTask(true);
        outcome = CompanionAnalyticsOutcome.Success;
        void api.stageCommand({ type: DesktopCompanionStageCommandType.DropStarted, sessionId: result.sessionId });
        return;
      }
      finishTask(false, result.failure);
    } catch (error) {
      finishTask?.(false, companionTaskFailure(error, failureStage));
      console.error('[DesktopCompanion] Failed to handle file drop', error);
    } finally {
      finishTask?.(false);
      reportCompanionAnalytics({ ...analytics, stage: CompanionAnalyticsStage.Result, outcome, attachmentCount });
    }
    setStatus(StartStatus.Failed);
    dismissTimer.current = setTimeout(() => { void api.stageCommand({ type: DesktopCompanionStageCommandType.DropCancel }); }, 2_400);
  };

  const hint = status === StartStatus.Starting
    ? t('desktopCompanionDropStarting')
    : status === StartStatus.Failed ? t('desktopCompanionDropFailed') : t('desktopCompanionDropTitle');

  return (
    <div
      className="stage-drop"
      data-status={status}
      aria-busy={status === StartStatus.Starting}
      onDragEnter={event => {
        if (received.current || !hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        depth.current += 1;
        if (depth.current === 1) {
          setHoverKinds(fileKindsFromDataTransfer(event.dataTransfer));
          void api.stageCommand({ type: DesktopCompanionStageCommandType.StageHover, hovering: true });
        }
      }}
      onDragOver={event => { if (hasFiles(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={() => {
        if (received.current) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setActive(null);
          void api.stageCommand({ type: DesktopCompanionStageCommandType.StageHover, hovering: false });
        }
      }}
      // The neutral area attaches files for a question; only a named action runs a task.
      onDrop={event => { void run(event, CompanionDropAction.Ask); }}
    >
      <header className="drop-header">
        <span className="drop-file" title={stage.files.map(file => file.name).join('\n')}>
          <PaperClipIcon aria-hidden="true" />
          <span className="drop-file-name">{first?.name ?? t('desktopCompanionDropTitleIdle')}</span>
          {stage.files.length > 1 && <span className="drop-file-more">+{stage.files.length - 1}</span>}
        </span>
        <span className="drop-hint" role="status">{hint}</span>
      </header>
      <div className="drop-actions" role="group" aria-label={t('desktopCompanionDropTitleIdle')}>
        {actions.map(action => {
          const keys = companionDropCopyKeys(action);
          return (
            <div
              key={action}
              className="drop-action"
              data-active={active === action}
              title={t(keys.detail)}
              onDragEnter={event => { if (!received.current && hasFiles(event.dataTransfer)) setActive(action); }}
              onDragOver={event => {
                if (received.current || !hasFiles(event.dataTransfer)) return;
                event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setActive(action);
              }}
              onDragLeave={() => setActive(current => current === action ? null : current)}
              onDrop={event => { void run(event, action); }}
            >
              {t(keys.title)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function CompanionStage({ state }: { state: DesktopCompanionState }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const stage = state.stage;
  useMeasuredSurface(cardRef, stage.kind !== DesktopCompanionStageKind.None, stage.kind === DesktopCompanionStageKind.None ? '' : stage.id);
  if (stage.kind === DesktopCompanionStageKind.None) return null;
  return (
    <div className="stage-surface" data-side={state.stageSide} data-kind={stage.kind}>
      <div className="stage-card" ref={cardRef} key={stage.id}>
        {stage.kind === DesktopCompanionStageKind.Hint && <HintBubble stage={stage} />}
        {stage.kind === DesktopCompanionStageKind.Drop && <DropZone stage={stage} />}
        {stage.kind === DesktopCompanionStageKind.Task && <TaskStrip stage={stage} />}
      </div>
    </div>
  );
}
