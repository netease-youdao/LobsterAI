import React, { useEffect, useRef, useState } from 'react';

import {
  DesktopCompanionDragPhase,
  DesktopCompanionFileDragPhase,
  DesktopCompanionSize,
  DesktopCompanionStageCommandType,
  DesktopCompanionStageKind,
  type DesktopCompanionState,
  DesktopCompanionTiming,
} from '../../../shared/desktopCompanion/constants';
import { CompanionSkinKind, getCompanionSkin } from '../../../shared/desktopCompanion/skins';
import { i18nService } from '../../services/i18n';
import { CoworkSessionStatusValue } from '../../types/cowork';
import { fileKindsFromDataTransfer, filesToAttachments, hasFiles } from './companionTasks';
import CompanionCharacter from './mascot/CompanionCharacter';
import { CompanionMood, companionMood, companionMoodLabelKey } from './mascot/companionMood';
import { useCompanionSession } from './useCompanionSession';

const CHARACTER_SIZE = 64;
const DRAG_THRESHOLD = 5;

export default function CompanionOrb({ state }: { state: DesktopCompanionState }) {
  const api = window.electron.desktopCompanion;
  const pointer = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const dragDepth = useRef(0);
  const dropTimer = useRef<ReturnType<typeof setTimeout>>();
  const [dropHover, setDropHover] = useState(false);
  const [moving, setMoving] = useState(false);
  const expanded = state.panelVisible || state.result.visible;
  const { session, pending } = useCompanionSession(state.sessionId, state.panelVisible);
  const status = session?.status ?? null;
  const taskRecord = state.result.recentTasks.find(task => task.sessionId === state.sessionId);
  const unseenResult = !!taskRecord && status === CoworkSessionStatusValue.Completed
    && (session?.updatedAt ?? 0) > taskRecord.viewedAt;

  const mood = companionMood({
    status,
    waiting: pending,
    unseenResult,
    snoozed: !!state.snooze,
    dropHover,
    dropStage: state.stage.kind === DesktopCompanionStageKind.Drop,
    hintShowing: state.stage.kind === DesktopCompanionStageKind.Hint,
  });
  const skinKind = getCompanionSkin(state.preferences.skin).kind;
  const label = i18nService.t(state.result.visible ? 'desktopCompanionCloseResults'
    : state.panelVisible ? 'desktopCompanionClosePanel' : companionMoodLabelKey(mood));
  const canDrop = state.preferences.enabled && state.preferences.dragAssist && !state.snooze;

  useEffect(() => {
    if (!canDrop) {
      clearTimeout(dropTimer.current);
      dragDepth.current = 0;
      setDropHover(false);
    }
    return () => clearTimeout(dropTimer.current);
  }, [canDrop]);

  // News brings compact task bubbles back without expanding them or taking focus.
  const taskNews = state.sessionId && (mood === CompanionMood.Done || mood === CompanionMood.Attention || mood === CompanionMood.Error)
    ? `${state.sessionId}:${mood}`
    : '';
  useEffect(() => { if (taskNews) api.taskUpdated(); }, [api, taskNews]);

  const toggle = async (fromPointer = false) => {
    try {
      await api.toggleOrb(fromPointer);
    } catch (error) { console.warn('[DesktopCompanion] Failed to toggle task entry', error); }
  };

  const finishDrag = (event: React.PointerEvent<HTMLButtonElement>, canceled = false) => {
    const start = pointer.current;
    pointer.current = null;
    setMoving(false);
    if (!start) return;
    api.drag(start.dragging ? DesktopCompanionDragPhase.End : DesktopCompanionDragPhase.Cancel);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!canceled && !start.dragging) void toggle(true);
  };

  const leaveFileDrag = () => {
    clearTimeout(dropTimer.current);
    dragDepth.current = 0;
    setDropHover(false);
  };

  return (
    <div
      className="orb-surface"
      onDragEnter={event => {
        if (!canDrop || !hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        dragDepth.current += 1;
        if (dragDepth.current === 1) {
          setDropHover(true);
          const kinds = fileKindsFromDataTransfer(event.dataTransfer);
          dropTimer.current = setTimeout(() => {
            api.orbFileDrag(DesktopCompanionFileDragPhase.Enter, kinds);
          }, DesktopCompanionTiming.DropExpandDelayMs);
        }
      }}
      onDragOver={event => {
        if (!canDrop || !hasFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        if (!canDrop) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) {
          leaveFileDrag();
          api.orbFileDrag(DesktopCompanionFileDragPhase.Leave, []);
        }
      }}
      onDrop={event => {
        if (!canDrop || !hasFiles(event.dataTransfer)) return;
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
        data-kind={skinKind}
        data-moving={moving}
        data-drop-hover={dropHover}
        style={skinKind === CompanionSkinKind.Brand ? { width: DesktopCompanionSize.BrandMark + 8, height: DesktopCompanionSize.BrandMark + 8 } : undefined}
        aria-expanded={expanded}
        aria-label={label}
        title={label}
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
        onClick={event => { if (event.detail === 0) void toggle(); }}
        onContextMenu={event => { event.preventDefault(); void api.showContextMenu(); }}
      >
        <CompanionCharacter skin={state.preferences.skin} mood={mood} size={skinKind === CompanionSkinKind.Brand ? DesktopCompanionSize.BrandMark : CHARACTER_SIZE} />
      </button>
    </div>
  );
}
