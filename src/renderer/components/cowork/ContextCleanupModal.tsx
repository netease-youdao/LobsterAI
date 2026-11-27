import { ExclamationTriangleIcon, SparklesIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  CleanupActionMode,
  CleanupCapabilityKind,
  CleanupDependencyKind,
} from '../../../shared/contextCleanup/constants';
import type {
  ContextCleanupApplyResult,
  ContextCleanupCandidate,
  ContextCleanupDependency,
  ContextCleanupScanResult,
} from '../../../shared/contextCleanup/types';
import {
  computeSelectedCleanupSavings,
  contextCleanupService,
  getDefaultSelectedCandidateKeys,
  groupCleanupCandidates,
  makeCleanupCandidateKey,
} from '../../services/contextCleanup';
import { i18nService } from '../../services/i18n';
import { formatTokenCount } from '../../utils/tokenFormat';
import Modal from '../common/Modal';

export interface ContextCleanupUndoState {
  closedCount: number;
  savedTokens: number;
  undoToken: string;
}

interface ContextCleanupModalProps {
  isOpen: boolean;
  scanResult: ContextCleanupScanResult | null;
  onClose: () => void;
  onApplied?: (result: ContextCleanupApplyResult) => void;
}

const GROUP_LABEL_KEYS: Record<CleanupCapabilityKind, string> = {
  [CleanupCapabilityKind.Skill]: 'contextCleanupGroupSkills',
  [CleanupCapabilityKind.McpServer]: 'contextCleanupGroupMcp',
  [CleanupCapabilityKind.DecisionModel]: 'contextCleanupGroupExperimental',
  [CleanupCapabilityKind.DshPlugin]: 'contextCleanupGroupPlugins',
};

function formatDependencyBadge(dep: ContextCleanupDependency): string {
  switch (dep.kind) {
    case CleanupDependencyKind.ScheduledTask:
      return i18nService.t('contextCleanupDepScheduledTask').replace('{name}', dep.label || '');
    case CleanupDependencyKind.EnabledAgentSkill:
      return i18nService.t('contextCleanupDepAgentSkill').replace('{name}', dep.label || '');
    case CleanupDependencyKind.CoreBuiltinSkill:
      return i18nService.t('contextCleanupDepCoreSkill');
    default:
      return '';
  }
}

function formatIdleLabel(candidate: ContextCleanupCandidate): string {
  if (candidate.idleDays === null) {
    return i18nService.t('contextCleanupNeverUsed');
  }
  return i18nService.t('contextCleanupIdleDays').replace('{days}', String(candidate.idleDays));
}

export const ContextCleanupUndoToast: React.FC<{
  undoState: ContextCleanupUndoState | null;
  onDismiss: () => void;
  onUndone?: () => void;
}> = ({ undoState, onDismiss, onUndone }) => {
  const [undoing, setUndoing] = useState(false);

  useEffect(() => {
    if (!undoState) return undefined;
    const timer = window.setTimeout(onDismiss, 8_000);
    return () => window.clearTimeout(timer);
  }, [undoState, onDismiss]);

  if (!undoState || typeof document === 'undefined') return null;

  const handleUndo = async () => {
    if (undoing) return;
    setUndoing(true);
    try {
      const res = await contextCleanupService.undo(undoState.undoToken);
      onDismiss();
      if (res.success) {
        onUndone?.();
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('contextCleanupToastUndone').replace('{count}', String(res.restoredCount)),
        }));
      }
    } finally {
      setUndoing(false);
    }
  };

  return createPortal(
    <div className="fixed bottom-6 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm text-foreground shadow-popover">
      <span>
        {i18nService.t('contextCleanupToastSuccess')
          .replace('{count}', String(undoState.closedCount))
          .replace('{tokens}', formatTokenCount(undoState.savedTokens))}
      </span>
      <button
        type="button"
        disabled={undoing}
        onClick={handleUndo}
        className="rounded-lg bg-action px-2.5 py-1 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:opacity-50"
      >
        {i18nService.t('contextCleanupToastUndo')}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={i18nService.t('close')}
        className="rounded p-0.5 text-secondary hover:bg-surface-raised hover:text-foreground"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>,
    document.body,
  );
};

const ContextCleanupModal: React.FC<ContextCleanupModalProps> = ({
  isOpen,
  scanResult,
  onClose,
  onApplied,
}) => {
  const candidates = useMemo(() => scanResult?.candidates ?? [], [scanResult]);
  const groups = useMemo(() => groupCleanupCandidates(candidates), [candidates]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => getDefaultSelectedCandidateKeys(candidates));
  const [isApplying, setIsApplying] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (isOpen) {
      setSelectedKeys(getDefaultSelectedCandidateKeys(candidates));
      setErrorMessage('');
    }
  }, [isOpen, candidates]);

  const { selectedCount, savedTokens, targetItems } = useMemo(
    () => computeSelectedCleanupSavings(candidates, selectedKeys),
    [candidates, selectedKeys],
  );

  const toggleItem = (candidate: ContextCleanupCandidate) => {
    if (candidate.actionMode !== CleanupActionMode.Toggle) return;
    const key = makeCleanupCandidateKey(candidate.kind, candidate.id);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSelectRecommended = () => {
    setSelectedKeys(getDefaultSelectedCandidateKeys(candidates));
  };

  const handleClearSelection = () => {
    setSelectedKeys(new Set());
  };

  const handleApply = async () => {
    if (isApplying || targetItems.length === 0) return;
    setIsApplying(true);
    setErrorMessage('');
    try {
      const result = await contextCleanupService.apply(targetItems);
      if (!result.success && result.closedCount === 0) {
        setErrorMessage(result.error || i18nService.t('contextCleanupApplyFailed'));
        return;
      }
      onApplied?.(result);
      onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : i18nService.t('contextCleanupApplyFailed'));
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      onEscape={onClose}
      className="flex max-h-[82vh] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-popover"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SparklesIcon className="h-5 w-5 text-primary" aria-hidden="true" />
            <h2 className="text-base font-semibold text-foreground">
              {i18nService.t('contextCleanupModalTitle')}
            </h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('contextCleanupModalSubtitle')
              .replace('{days}', String(scanResult?.idleDaysThreshold ?? 30))}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={i18nService.t('close')}
          className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Summary Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-raised/60 px-5 py-2.5 text-xs">
        <span className="font-medium text-foreground tabular-nums">
          {i18nService.t('contextCleanupModalSummary')
            .replace('{selected}', String(selectedCount))
            .replace('{tokens}', formatTokenCount(savedTokens))}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSelectRecommended}
            className="text-xs font-medium text-primary hover:underline"
          >
            {i18nService.t('contextCleanupSelectSafe')}
          </button>
          <span className="text-border">·</span>
          <button
            type="button"
            onClick={handleClearSelection}
            className="text-xs text-secondary hover:text-foreground"
          >
            {i18nService.t('contextCleanupClearSelection')}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {groups.length === 0 ? (
          <div className="py-10 text-center text-sm text-secondary">
            {i18nService.t('contextCleanupEmpty')}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.kind} className="space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-secondary">
                <span>
                  {i18nService.t(GROUP_LABEL_KEYS[group.kind])} ({group.items.length})
                </span>
                {group.totalTokens > 0 && (
                  <span className="tabular-nums">
                    {`~${formatTokenCount(group.totalTokens)} tokens`}
                  </span>
                )}
              </div>
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
                {group.items.map((candidate) => {
                  const key = makeCleanupCandidateKey(candidate.kind, candidate.id);
                  const isToggleable = candidate.actionMode === CleanupActionMode.Toggle;
                  const checked = isToggleable && selectedKeys.has(key);
                  return (
                    <label
                      key={key}
                      className={`flex items-start gap-3 px-3.5 py-2.5 text-left transition-colors ${
                        isToggleable ? 'cursor-pointer hover:bg-surface-raised/60' : 'cursor-default'
                      }`}
                    >
                      {isToggleable ? (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleItem(candidate)}
                          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary/40"
                        />
                      ) : (
                        <span className="mt-0.5 h-4 w-4 flex-shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {candidate.name}
                          </span>
                          <span className="flex-shrink-0 text-xs font-medium text-secondary tabular-nums">
                            {candidate.estimatedTokensUnknown
                              ? i18nService.t('contextCleanupTokensUnknown')
                              : `~${formatTokenCount(candidate.estimatedTokens)} tok`}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-secondary">
                          <span>{formatIdleLabel(candidate)}</span>
                          {!isToggleable && (
                            <span className="rounded bg-surface-raised px-1.5 py-0.5 text-secondary">
                              {i18nService.t('contextCleanupManageInPluginsHint')}
                            </span>
                          )}
                          {candidate.dependencies.map((dep, idx) => (
                            <span
                              key={`${dep.kind}-${idx}`}
                              className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300"
                            >
                              <ExclamationTriangleIcon className="h-3 w-3 flex-shrink-0" />
                              <span>{formatDependencyBadge(dep)}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </section>
          ))
        )}

        {errorMessage && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            {errorMessage}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3.5">
        <p className="text-[11px] text-secondary">
          {i18nService.t('contextCleanupSafeNote')}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            disabled={isApplying || selectedCount === 0}
            onClick={handleApply}
            className="rounded-xl bg-action px-4 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isApplying
              ? i18nService.t('contextCleanupApplying')
              : i18nService.t('contextCleanupModalConfirm').replace('{count}', String(selectedCount))}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ContextCleanupModal;
