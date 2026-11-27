import { SparklesIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useState } from 'react';

import type { ContextCleanupApplyResult, ContextCleanupScanResult } from '../../../shared/contextCleanup/types';
import { contextCleanupService } from '../../services/contextCleanup';
import { i18nService } from '../../services/i18n';
import { formatTokenCount } from '../../utils/tokenFormat';
import ContextCleanupModal, {
  type ContextCleanupUndoState,
  ContextCleanupUndoToast,
} from './ContextCleanupModal';

interface ContextCleanupBannerProps {
  className?: string;
}

const ContextCleanupBanner: React.FC<ContextCleanupBannerProps> = ({ className = '' }) => {
  const [scanResult, setScanResult] = useState<ContextCleanupScanResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [undoState, setUndoState] = useState<ContextCleanupUndoState | null>(null);

  const refreshScan = useCallback(async () => {
    const result = await contextCleanupService.scan();
    setScanResult(result);
  }, []);

  useEffect(() => {
    let active = true;
    void contextCleanupService.scan().then((result) => {
      if (active) setScanResult(result);
    });
    return () => { active = false; };
  }, []);

  const handleDismiss = async () => {
    await contextCleanupService.dismiss();
    setScanResult((prev) => (prev ? { ...prev, shouldShowBanner: false } : prev));
  };

  const handleApplied = (result: ContextCleanupApplyResult) => {
    if (result.closedCount > 0 && result.undoToken) {
      setUndoState({
        closedCount: result.closedCount,
        savedTokens: result.savedTokens,
        undoToken: result.undoToken,
      });
    }
    void refreshScan();
  };

  const recommendedCount = scanResult
    ? scanResult.candidates.filter(c => c.defaultSelected).length
    : 0;

  return (
    <>
      {scanResult?.shouldShowBanner && recommendedCount > 0 && (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised/70 px-4 py-2.5 text-xs ${className}`}
        >
          <div className="flex min-w-0 items-center gap-2 text-foreground">
            <SparklesIcon className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
            <span className="leading-5">
              {i18nService.t('contextCleanupBannerText')
                .replace('{count}', String(recommendedCount))
                .replace('{days}', String(scanResult.idleDaysThreshold))
                .replace('{tokens}', formatTokenCount(scanResult.recommendedSavableTokens))}
            </span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded-lg bg-action px-3 py-1 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
            >
              {i18nService.t('contextCleanupBannerAction')}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label={i18nService.t('contextCleanupDismiss')}
              className="rounded-lg px-2 py-1 text-xs text-secondary transition-colors hover:bg-surface hover:text-foreground"
            >
              {i18nService.t('contextCleanupDismiss')}
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label={i18nService.t('close')}
              className="rounded p-0.5 text-secondary hover:bg-surface hover:text-foreground"
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <ContextCleanupModal
        isOpen={modalOpen}
        scanResult={scanResult}
        onClose={() => setModalOpen(false)}
        onApplied={handleApplied}
      />

      <ContextCleanupUndoToast
        undoState={undoState}
        onDismiss={() => setUndoState(null)}
        onUndone={() => void refreshScan()}
      />
    </>
  );
};

export default ContextCleanupBanner;
