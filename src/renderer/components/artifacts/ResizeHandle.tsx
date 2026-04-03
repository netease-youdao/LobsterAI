import React, { useCallback, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { setPanelWidth, selectArtifactPanelWidth } from '../../store/slices/artifactSlice';

const MIN_WIDTH = 300;
const MAX_WIDTH = 800;

const ResizeHandle: React.FC = () => {
  const dispatch = useDispatch();
  const currentWidth = useSelector(selectArtifactPanelWidth);
  const isDragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    isDragging.current = true;
    startX.current = e.clientX;
    startWidth.current = currentWidth;
    e.currentTarget.setPointerCapture?.(e.pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!isDragging.current) return;
      // Dragging left increases panel width
      const delta = startX.current - moveEvent.clientX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta));
      dispatch(setPanelWidth(newWidth));
    };

    const handlePointerUp = () => {
      isDragging.current = false;
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [dispatch, currentWidth]);

  return (
    <div
      className="group relative w-3 cursor-col-resize select-none touch-none flex-shrink-0"
      onPointerDown={handlePointerDown}
      aria-label="Resize artifact panel"
      role="separator"
      aria-orientation="vertical"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent group-hover:bg-blue-400/60 group-active:bg-blue-500/70 dark:group-hover:bg-blue-500/60 dark:group-active:bg-blue-400/70 transition-colors" />
    </div>
  );
};

export default ResizeHandle;
