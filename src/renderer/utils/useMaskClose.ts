import { useRef } from 'react';
import type { MouseEventHandler } from 'react';

/**
 * Returns props to spread on a modal mask element so that clicking the mask
 * closes the modal, while dragging from inside the modal onto the mask does not.
 */
export function useMaskClose(onClose: () => void): {
  onMouseDown: MouseEventHandler;
  onClick: MouseEventHandler;
} {
  const mouseDownOnMask = useRef(false);

  return {
    onMouseDown: (e) => { mouseDownOnMask.current = e.target === e.currentTarget; },
    onClick: (e) => { if (e.target === e.currentTarget && mouseDownOnMask.current) onClose(); },
  };
}
