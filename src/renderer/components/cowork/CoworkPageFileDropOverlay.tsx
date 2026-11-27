import { ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import React from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';

interface CoworkPageFileDropOverlayProps {
  visible: boolean;
}

const CoworkPageFileDropOverlay: React.FC<CoworkPageFileDropOverlayProps> = ({ visible }) => {
  if (!visible) return null;

  const overlay = (
    <div
      data-page-file-drop-overlay="true"
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-0 z-[9990] bg-background/70 p-4 backdrop-blur-[3px] animate-fade-in"
    >
      <div className="flex h-full w-full items-center justify-center rounded-2xl border-2 border-dashed border-primary/50 bg-primary/[0.04]">
        <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border border-border/80 bg-surface/95 px-8 py-6 text-center shadow-elevated animate-scale-in">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/15">
            <ArrowUpTrayIcon className="h-6 w-6 stroke-[1.75]" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <div className="text-base font-semibold leading-6 text-foreground">
              {i18nService.t('coworkPageDropFileTitle')}
            </div>
            <div className="text-xs leading-5 text-secondary">
              {i18nService.t('coworkPageDropFileDescription')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return overlay;
  }

  return createPortal(overlay, document.body);
};

export default CoworkPageFileDropOverlay;
