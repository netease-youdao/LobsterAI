import React, { useEffect, useRef, useState } from 'react';

import {
  type CompanionGaze,
  DesktopCompanionDock,
  DesktopCompanionDragPhase,
  DesktopCompanionFileDragPhase,
  DesktopCompanionPointerPhase,
  DesktopCompanionStageCommandType,
  DesktopCompanionStageKind,
  type DesktopCompanionState,
} from '../../../shared/desktopCompanion/constants';
import { getCompanionSkin } from '../../../shared/desktopCompanion/skins';
import { i18nService } from '../../services/i18n';
import { CoworkSessionStatusValue } from '../../types/cowork';
import { fileKindsFromDataTransfer, filesToAttachments, hasFiles } from './companionTasks';
import CompanionCharacter from './mascot/CompanionCharacter';
import { CompanionMood, companionMood, companionMoodLabelKey, moodNeedsAttention } from './mascot/companionMood';
import { useCompanionSession } from './useCompanionSession';

const CHARACTER_SIZE = 64;
const DRAG_THRESHOLD = 5;

export default function CompanionOrb({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const pointer = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const dragDepth = useRef(0);
  const [hovering, setHovering] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [moving, setMoving] = useState(false);
  const [gaze, setGaze] = useState<CompanionGaze>({ x: 0, y: 0 });
  const [unseenResult, setUnseenResult] = useState(false);
  const { session, pending } = useCompanionSession(state.sessionId, state.panelVisible);
  const status = session?.status ?? null;
  const previousStatus = useRef(status);

  // A finished task the user has not looked at yet keeps the "done" face.
  useEffect(() => {
    if (previousStatus.current === CoworkSessionStatusValue.Running && status === CoworkSessionStatusValue.Completed && !state.panelVisible) {
      setUnseenResult(true);
    }
    previousStatus.current = status;
  }, [status, state.panelVisible]);
  useEffect(() => { if (state.panelVisible) setUnseenResult(false); }, [state.panelVisible]);
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
    hovering,
  });
  const attention = moodNeedsAttention(mood);
  useEffect(() => { api.orbAttention(attention); }, [api, attention]);

  // Tucked into an edge, the character leans out and looks into the screen.
  const effectiveGaze = state.peeking
    ? { x: state.dock === DesktopCompanionDock.Right ? -1 : 1, y: -0.25 }
    : gaze;

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
      data-dock={state.dock}
      data-peeking={state.peeking}
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
        onMouseEnter={() => { setHovering(true); api.orbPointer(DesktopCompanionPointerPhase.Enter); }}
        onMouseLeave={() => { setHovering(false); api.orbPointer(DesktopCompanionPointerPhase.Leave); }}
        onContextMenu={event => { event.preventDefault(); void api.showContextMenu(); }}
      >
        <CompanionCharacter skin={state.preferences.skin} mood={mood} size={CHARACTER_SIZE} gaze={effectiveGaze} />
        {mood === CompanionMood.Working && getCompanionSkin(state.preferences.skin).asset && <span className="orb-ring" aria-hidden="true" />}
      </button>
    </div>
  );
}
