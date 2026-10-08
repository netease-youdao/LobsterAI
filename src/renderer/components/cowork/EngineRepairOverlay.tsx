import { ArrowPathIcon } from '@heroicons/react/24/outline';
import React, { useLayoutEffect, useRef } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';

const EngineRepairOverlay: React.FC = () => {
  const isRepairing = useSelector((state: RootState) => state.cowork.isRepairingOpenClaw);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!isRepairing || !dialog) return;

    // The native modal covers portals too and makes the rest of the app inert.
    // Capture keyboard events before document-level app shortcuts can run.
    const blockKeyboard = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockKeyboard, true);
    dialog.showModal();

    return () => {
      window.removeEventListener('keydown', blockKeyboard, true);
      dialog.close();
    };
  }, [isRepairing]);

  if (!isRepairing) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby="openclaw-repair-title"
      aria-describedby="openclaw-repair-description"
      onCancel={(event) => event.preventDefault()}
      className="non-draggable fixed inset-0 m-0 h-full max-h-none w-full max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground outline-none backdrop:bg-black/40 backdrop:backdrop-blur-sm open:flex"
    >
      <div className="flex w-full max-w-md flex-col items-center rounded-2xl border border-border bg-surface p-6 text-center shadow-xl" role="status" aria-live="polite">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ArrowPathIcon className="h-6 w-6 animate-spin" aria-hidden="true" />
        </span>
        <h2 id="openclaw-repair-title" className="mt-3 text-base font-semibold">
          {i18nService.t('openClawRepairRunning')}
        </h2>
        <p id="openclaw-repair-description" className="mt-2 text-[13px] leading-5 text-secondary">
          {i18nService.t('coworkOpenClawErrorRepairHint')}
        </p>
      </div>
    </dialog>
  );
};

export default EngineRepairOverlay;
