import {
  CheckIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';
import React, { useMemo, useState } from 'react';

import { i18nService } from '../../services/i18n';
import {
  foldTerminalLines,
  INSTALL_TERMINAL_MAX_LINES,
  type PluginInstallRun,
  stripAnsiCodes,
} from './pluginInstallViewModel';

interface DshInstallTerminalBlockProps {
  run: PluginInstallRun;
  cancelled?: boolean;
  attemptBadge?: string | null;
}

export const DshInstallTerminalBlock: React.FC<DshInstallTerminalBlockProps> = ({
  run,
  cancelled = false,
  attemptBadge = null,
}) => {
  const t = (key: string) => i18nService.t(key);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const running = run.exitCode === undefined;
  const succeeded = run.exitCode === 0;
  const cleanOutput = useMemo(() => stripAnsiCodes(run.output), [run.output]);
  const folded = useMemo(
    () => foldTerminalLines(run.output, INSTALL_TERMINAL_MAX_LINES),
    [run.output],
  );

  const statusLabel = running
    ? t('dshPluginsTerminalRunning')
    : succeeded
      ? t('dshPluginsTerminalDone')
      : cancelled
        ? t('dshPluginsTerminalCancelled')
        : t('dshPluginsTerminalFailed');

  const statusBadgeClass = running
    ? 'bg-primary/10 text-primary'
    : succeeded
      ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : cancelled
        ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
        : 'bg-red-500/15 text-red-700 dark:text-red-300';

  const handleCopy = async () => {
    const payload = [run.command ? `$ ${run.command}` : '', cleanOutput.trim()]
      .filter(Boolean)
      .join('\n');
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Ignore clipboard failures in restricted environments.
    }
  };

  return (
    <div className="space-y-1">
      {attemptBadge && (
        <span className="inline-block rounded-md bg-surface-raised px-1.5 py-0.5 text-[11px] text-secondary">
          {attemptBadge}
        </span>
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-background/80">
        {/* Command header */}
        <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-raised/60 px-3 py-1.5">
          <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground" title={run.command}>
            <span className="mr-1.5 select-none text-secondary">$</span>
            {run.command}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass}`}>
              {running && (
                <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              )}
              {statusLabel}
              {!running && !succeeded && run.exitCode !== null && run.exitCode !== undefined && (
                <span className="opacity-80">
                  ({run.exitCode})
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-surface hover:text-foreground"
              aria-label={copied ? t('dshPluginsTerminalCopied') : t('dshPluginsTerminalCopy')}
            >
              {copied ? (
                <CheckIcon className="h-3 w-3 text-emerald-500" />
              ) : (
                <ClipboardDocumentIcon className="h-3 w-3" />
              )}
              <span>{copied ? t('dshPluginsTerminalCopied') : t('dshPluginsTerminalCopy')}</span>
            </button>
          </div>
        </div>

        {/* Output body */}
        <div className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-[18px] text-secondary">
          {folded.totalLines === 0 ? (
            <div className="italic opacity-70">
              {running ? t('dshPluginsTerminalRunning') : t('dshPluginsTerminalNoOutput')}
            </div>
          ) : expanded || folded.hiddenCount === 0 ? (
            <>
              <pre className="whitespace-pre-wrap break-all">{cleanOutput.replace(/\n$/, '')}</pre>
              {folded.hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="mt-1.5 inline-flex items-center rounded bg-surface-raised px-2 py-0.5 text-[11px] font-sans text-secondary transition-colors hover:text-foreground"
                >
                  {t('dshPluginsTerminalCollapse')}
                </button>
              )}
            </>
          ) : (
            <div className="space-y-1">
              <pre className="whitespace-pre-wrap break-all">{folded.head.join('\n')}</pre>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="inline-flex items-center rounded bg-surface-raised px-2 py-0.5 text-[11px] font-sans text-secondary transition-colors hover:text-foreground"
              >
                {t('dshPluginsTerminalExpand').replace('{n}', String(folded.hiddenCount))}
              </button>
              <pre className="whitespace-pre-wrap break-all">{folded.tail.join('\n')}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
