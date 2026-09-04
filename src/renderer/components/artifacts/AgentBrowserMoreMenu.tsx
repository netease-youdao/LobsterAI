import {
  ArrowPathIcon,
  MinusIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { AgentBrowserZoom } from '@shared/browserWebAccess/constants';
import React from 'react';

import { i18nService } from '@/services/i18n';

interface AgentBrowserMoreMenuProps {
  hasPage: boolean;
  disabled: boolean;
  actionPending: boolean;
  zoomFactor: number;
  onCaptureScreenshot: () => void;
  onOpenBlankPage: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onZoomIn: () => void;
  onClearCookies: () => void;
  onClearCache: () => void;
}

const AgentBrowserMoreMenu: React.FC<AgentBrowserMoreMenuProps> = ({
  hasPage,
  disabled,
  actionPending,
  zoomFactor,
  onCaptureScreenshot,
  onOpenBlankPage,
  onZoomOut,
  onResetZoom,
  onZoomIn,
  onClearCookies,
  onClearCache,
}) => {
  const pageActionDisabled = disabled || actionPending || !hasPage;
  const generalActionDisabled = disabled || actionPending;

  return (
    <div className="w-56 rounded-lg border border-border bg-surface-raised p-2 text-sm text-foreground shadow-xl">
      <button
        type="button"
        onClick={onCaptureScreenshot}
        disabled={pageActionDisabled}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35"
      >
        {actionPending ? <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" /> : null}
        {i18nService.t('artifactBrowserScreenshot')}
      </button>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        onClick={onOpenBlankPage}
        disabled={generalActionDisabled}
        className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35"
      >
        {i18nService.t('artifactBrowserBlankPage')}
      </button>
      <div className="my-1 border-t border-border" />
      <div className="flex h-9 items-center gap-2 px-2">
        <span className="min-w-0 flex-1 text-xs text-secondary">
          {i18nService.t('artifactBrowserZoom')}
        </span>
        <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border bg-background">
          <button
            type="button"
            onClick={onZoomOut}
            disabled={pageActionDisabled || zoomFactor <= AgentBrowserZoom.Min}
            className="inline-flex h-full w-7 items-center justify-center text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
            title={i18nService.t('artifactBrowserZoomOut')}
          >
            <MinusIcon className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onResetZoom}
            disabled={pageActionDisabled}
            className="h-full min-w-[54px] border-x border-border px-2 text-center text-xs text-foreground transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35"
            title={i18nService.t('artifactBrowserResetZoom')}
          >
            {Math.round(zoomFactor * 100)}%
          </button>
          <button
            type="button"
            onClick={onZoomIn}
            disabled={pageActionDisabled || zoomFactor >= AgentBrowserZoom.Max}
            className="inline-flex h-full w-7 items-center justify-center text-secondary transition-colors hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
            title={i18nService.t('artifactBrowserZoomIn')}
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="my-1 border-t border-border" />
      <button
        type="button"
        onClick={onClearCookies}
        disabled={generalActionDisabled}
        className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35"
      >
        {i18nService.t('artifactBrowserClearCookies')}
      </button>
      <button
        type="button"
        onClick={onClearCache}
        disabled={generalActionDisabled}
        className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-35"
      >
        {i18nService.t('artifactBrowserClearCache')}
      </button>
    </div>
  );
};

export default AgentBrowserMoreMenu;
