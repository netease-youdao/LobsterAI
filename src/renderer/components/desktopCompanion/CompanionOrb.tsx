import { SpeakerWaveIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

import {
  type CompanionGaze,
  DesktopCompanionDragPhase,
  DesktopCompanionFileDragPhase,
  DesktopCompanionStageCommandType,
  DesktopCompanionStageKind,
  type DesktopCompanionState,
} from '../../../shared/desktopCompanion/constants';
import { isSpeechActive, LanguageTool } from '../../../shared/desktopCompanion/languageTools';
import { getCompanionSkin } from '../../../shared/desktopCompanion/skins';
import { i18nService } from '../../services/i18n';
import { CoworkSessionStatusValue } from '../../types/cowork';
import { fileKindsFromDataTransfer, filesToAttachments, hasFiles } from './companionTasks';
import CompanionCharacter from './mascot/CompanionCharacter';
import { CompanionMood, companionMood, companionMoodLabelKey, moodCanRest } from './mascot/companionMood';
import { useCompanionSession } from './useCompanionSession';

const CHARACTER_SIZE = 64;
const DRAG_THRESHOLD = 5;
/** How long the character stays fully present after the last interaction or news. */
const REST_DELAY_MS = 4_000;

export default function CompanionOrb({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const pointer = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const dragDepth = useRef(0);
  const [hovering, setHovering] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [moving, setMoving] = useState(false);
  const [gaze, setGaze] = useState<CompanionGaze>({ x: 0, y: 0 });
  const [unseenResult, setUnseenResult] = useState(false);
  const [rested, setRested] = useState(false);
  const { session, pending } = useCompanionSession(state.sessionId, state.panelVisible);
  const status = session?.status ?? null;
  const previousStatus = useRef(status);

  // A finished task keeps the "done" face until its result is opened or another task is followed.
  useEffect(() => {
    if (previousStatus.current === CoworkSessionStatusValue.Running && status === CoworkSessionStatusValue.Completed) {
      setUnseenResult(true);
    }
    previousStatus.current = status;
  }, [status]);
  useEffect(() => { setUnseenResult(false); }, [state.sessionId]);
  useEffect(() => api.onGaze(setGaze), [api]);

  const mood = companionMood({
    status,
    waiting: pending,
    unseenResult,
    snoozed: !!state.snooze,
    fileDragActive: state.fileDragActive,
    dropHover,
    dropStage: state.stage.kind === DesktopCompanionStageKind.Drop,
    hintShowing: state.stage.kind === DesktopCompanionStageKind.Hint,
  });
  const speaking = isSpeechActive(state.speechStatus);

  // News about the followed task brings its status strip back next to the orb.
  const taskNews = state.sessionId && (mood === CompanionMood.Done || mood === CompanionMood.Attention || mood === CompanionMood.Error)
    ? `${state.sessionId}:${mood}`
    : '';
  useEffect(() => { if (taskNews) api.taskUpdated(); }, [api, taskNews]);

  // Left alone with nothing to report, the character fades back instead of hiding off screen.
  const canRest = moodCanRest(mood) && !hovering && !moving && !state.panelVisible && !speaking;
  useEffect(() => {
    if (!canRest) return;
    const timer = setTimeout(() => setRested(true), REST_DELAY_MS);
    return () => { clearTimeout(timer); setRested(false); };
  }, [canRest]);

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>, canceled = false) => {
    const start = pointer.current;
    pointer.current = null;
    setMoving(false);
    if (!start) return;
    api.drag(start.dragging ? DesktopCompanionDragPhase.End : DesktopCompanionDragPhase.Cancel);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!canceled && !start.dragging) void api.togglePanel();
  };

  const leaveFileDrag = () => {
    dragDepth.current = 0;
    setDropHover(false);
  };

  return (
    <div
      className="orb-surface"
      data-resting={canRest && rested}
      onDragEnter={event => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current += 1;
        if (dragDepth.current === 1) {
          setDropHover(true);
          api.orbFileDrag(DesktopCompanionFileDragPhase.Enter, fileKindsFromDataTransfer(event.dataTransfer));
        }
      }}
      onDragOver={event => {
        if (!hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          leaveFileDrag();
          api.orbFileDrag(DesktopCompanionFileDragPhase.Leave, []);
        }
      }}
      onDrop={event => {
        event.preventDefault();
        leaveFileDrag();
        api.orbFileDrag(DesktopCompanionFileDragPhase.Drop, []);
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        // Dropping on the character itself means "ask about these".
        void filesToAttachments(files).then(attachments => {
          if (attachments.length) void api.stageCommand({ type: DesktopCompanionStageCommandType.DropAsk, attachments });
        });
      }}
    >
      <button
        type="button"
        className="orb-button"
        data-moving={moving}
        aria-label={i18nService.t(companionMoodLabelKey(mood))}
        title={i18nService.t(companionMoodLabelKey(mood))}
        onPointerDown={event => {
          if (event.button !== 0) return;
          pointer.current = { x: event.screenX, y: event.screenY, dragging: false };
          event.currentTarget.setPointerCapture(event.pointerId);
          api.drag(DesktopCompanionDragPhase.Start);
        }}
        onPointerMove={event => {
          const start = pointer.current;
          if (!start) return;
          if (!start.dragging && Math.hypot(event.screenX - start.x, event.screenY - start.y) > DRAG_THRESHOLD) {
            start.dragging = true;
            setMoving(true);
          }
          if (start.dragging) api.drag(DesktopCompanionDragPhase.Move);
        }}
        onPointerUp={event => finishDrag(event)}
        onPointerCancel={event => finishDrag(event, true)}
        onClick={event => { if (event.detail === 0) void api.togglePanel(); }}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onContextMenu={event => { event.preventDefault(); void api.showContextMenu(); }}
      >
        <CompanionCharacter skin={state.preferences.skin} mood={mood} size={CHARACTER_SIZE} gaze={gaze} />
        {mood === CompanionMood.Working && getCompanionSkin(state.preferences.skin).asset && <span className="orb-ring" aria-hidden="true" />}
      </button>
      {speaking && <button type="button" className="orb-speech"
        aria-label={i18nService.t('desktopToolsPlayback')} title={i18nService.t('desktopToolsPlayback')}
        onClick={() => { void api.openLanguageTool({ tool: LanguageTool.Tts }); }}><SpeakerWaveIcon /></button>}
    </div>
  );
}
