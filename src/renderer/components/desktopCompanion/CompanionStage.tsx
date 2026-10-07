import {
  ChartBarIcon,
  ChartPieIcon,
  ChatBubbleLeftRightIcon,
  DocumentMagnifyingGlassIcon,
  DocumentTextIcon,
  FolderOpenIcon,
  LanguageIcon,
  ListBulletIcon,
  MicrophoneIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline';
import React, { type ComponentType, type SVGProps, useEffect, useRef, useState } from 'react';

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
import { fileKindsFromDataTransfer, filesToAttachments, hasFiles, startCompanionTask } from './companionTasks';
import CompanionCharacter from './mascot/CompanionCharacter';
import { CompanionMood } from './mascot/companionMood';
import { useMeasuredSurface } from './useMeasuredSurface';

const t = (key: string) => i18nService.t(key);

const DROP_ICONS: Record<CompanionDropAction, ComponentType<SVGProps<SVGSVGElement>>> = {
  [CompanionDropAction.Digest]: DocumentTextIcon,
  [CompanionDropAction.Translate]: LanguageIcon,
  [CompanionDropAction.Analyze]: ChartBarIcon,
  [CompanionDropAction.Chart]: ChartPieIcon,
  [CompanionDropAction.Outline]: ListBulletIcon,
  [CompanionDropAction.Script]: MicrophoneIcon,
  [CompanionDropAction.Ocr]: DocumentMagnifyingGlassIcon,
  [CompanionDropAction.Describe]: PhotoIcon,
  [CompanionDropAction.Organize]: FolderOpenIcon,
  [CompanionDropAction.Ask]: ChatBubbleLeftRightIcon,
};

type HintStage = Extract<DesktopCompanionStage, { kind: typeof DesktopCompanionStageKind.Hint }>;
type DropStage = Extract<DesktopCompanionStage, { kind: typeof DesktopCompanionStageKind.Drop }>;

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

const StartStatus = { Idle: 'idle', Starting: 'starting', Failed: 'failed' } as const;
type StartStatus = typeof StartStatus[keyof typeof StartStatus];

function DropZone({ stage, skin }: { stage: DropStage; skin: string }) {
  const api = window.electron.desktopCompanion;
  const depth = useRef(0);
  const [hoverKinds, setHoverKinds] = useState<CompanionFileKind[]>([]);
  const [active, setActive] = useState<CompanionDropAction | null>(null);
  const [status, setStatus] = useState<StartStatus>(StartStatus.Idle);
  const kinds = stage.kinds.length ? stage.kinds : hoverKinds;
  const actions = companionDropActions(kinds);
  const first = stage.files[0];

  const run = async (event: React.DragEvent, action: CompanionDropAction) => {
    event.preventDefault();
    event.stopPropagation();
    depth.current = 0;
    setActive(null);
    const attachments = await filesToAttachments(Array.from(event.dataTransfer.files));
    if (!attachments.length) { void api.stageCommand({ type: DesktopCompanionStageCommandType.DropCancel }); return; }
    if (action === CompanionDropAction.Ask) {
      void api.stageCommand({ type: DesktopCompanionStageCommandType.DropAsk, attachments });
      return;
    }
    setStatus(StartStatus.Starting);
    const result = await startCompanionTask({ prompt: t(companionDropCopyKeys(action).prompt), attachments });
    if ('sessionId' in result) {
      void api.stageCommand({ type: DesktopCompanionStageCommandType.DropStarted, sessionId: result.sessionId });
      return;
    }
    setStatus(StartStatus.Failed);
    setTimeout(() => { void api.stageCommand({ type: DesktopCompanionStageCommandType.DropCancel }); }, 2_400);
  };

  const title = status === StartStatus.Starting
    ? t('desktopCompanionDropStarting')
    : status === StartStatus.Failed ? t('desktopCompanionDropFailed') : first ? t('desktopCompanionDropTitle') : t('desktopCompanionDropTitleIdle');

  return (
    <div
      className="stage-drop"
      data-status={status}
      onDragEnter={event => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        depth.current += 1;
        if (depth.current === 1) {
          setHoverKinds(fileKindsFromDataTransfer(event.dataTransfer));
          void api.stageCommand({ type: DesktopCompanionStageCommandType.StageHover, hovering: true });
        }
      }}
      onDragOver={event => { if (hasFiles(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setActive(null);
          void api.stageCommand({ type: DesktopCompanionStageCommandType.StageHover, hovering: false });
        }
      }}
      // Dropping between the tiles still does the most likely thing.
      onDrop={event => { void run(event, actions[0]); }}
    >
      <header className="drop-header">
        <CompanionCharacter skin={skin} mood={CompanionMood.Catch} size={24} showBadge={false} />
        <strong>{title}</strong>
        {first && (
          <span className="drop-file" title={stage.files.map(file => file.name).join('\n')}>
            <span className="drop-file-name">{first.name}</span>
            {stage.files.length > 1 && <span className="drop-file-more">+{stage.files.length - 1}</span>}
          </span>
        )}
      </header>
      <div className="drop-tiles">
        {actions.map(action => {
          const Icon = DROP_ICONS[action];
          const keys = companionDropCopyKeys(action);
          return (
            <div
              key={action}
              className="drop-tile"
              data-active={active === action}
              data-ask={action === CompanionDropAction.Ask}
              onDragEnter={() => setActive(action)}
              onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setActive(action); }}
              onDrop={event => { void run(event, action); }}
            >
              <Icon />
              <strong>{t(keys.title)}</strong>
              <span>{t(keys.detail)}</span>
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
        {stage.kind === DesktopCompanionStageKind.Hint
          ? <HintBubble stage={stage} />
          : <DropZone stage={stage} skin={state.preferences.skin} />}
      </div>
    </div>
  );
}
