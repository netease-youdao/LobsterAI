import { useState, useCallback, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';

type BannerTier = 'warning' | 'danger' | 'error';

interface ContextWarningBannerProps {
  sessionId: string;
  turnCount: number;
  hasContextOverflow?: boolean;
  onMigrateSession?: () => void;
}

function getBannerTier(turnCount: number, hasContextOverflow: boolean): BannerTier | null {
  if (hasContextOverflow) return 'error';
  if (turnCount >= 50) return 'danger';
  if (turnCount >= 30) return 'warning';
  return null;
}

const tierStyles: Record<BannerTier, string> = {
  warning: 'bg-yellow-50 dark:bg-yellow-900/30 border-yellow-300 dark:border-yellow-700 text-yellow-800 dark:text-yellow-200',
  danger: 'bg-orange-50 dark:bg-orange-900/30 border-orange-300 dark:border-orange-700 text-orange-800 dark:text-orange-200',
  error: 'bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-700 text-red-800 dark:text-red-200',
};

const tierIconStyles: Record<BannerTier, string> = {
  warning: 'text-yellow-500 dark:text-yellow-400',
  danger: 'text-orange-500 dark:text-orange-400',
  error: 'text-red-500 dark:text-red-400',
};

function getMessageKey(tier: BannerTier): string {
  switch (tier) {
    case 'warning': return 'cowork.contextWarning.long';
    case 'danger': return 'cowork.contextWarning.veryLong';
    case 'error': return 'cowork.contextWarning.overflow';
  }
}

// Track which sessions have been dismissed, persisted across re-renders
const dismissedSessions = new Set<string>();

export default function ContextWarningBanner({ sessionId, turnCount, hasContextOverflow = false, onMigrateSession }: ContextWarningBannerProps) {
  const [dismissed, setDismissed] = useState(() => dismissedSessions.has(sessionId));
  const isOptimizingContext = useSelector((state: RootState) => state.cowork.isOptimizingContext);

  // Reset dismissed state when switching to a different session
  useEffect(() => {
    setDismissed(dismissedSessions.has(sessionId));
  }, [sessionId]);

  const tier = getBannerTier(turnCount, hasContextOverflow);

  const handleDismiss = useCallback(() => {
    dismissedSessions.add(sessionId);
    setDismissed(true);
  }, [sessionId]);

  // Show optimization indicator (transient, independent of dismiss state)
  if (isOptimizingContext) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm border-b bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-700 text-blue-800 dark:text-blue-200">
        <svg className="w-4 h-4 flex-shrink-0 animate-spin text-blue-500 dark:text-blue-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
        <span className="flex-1">{i18nService.t('cowork.contextWarning.optimizingContext')}</span>
      </div>
    );
  }

  if (!tier || dismissed) return null;

  const messageKey = getMessageKey(tier);
  const message = i18nService.t(messageKey).replace('{turnCount}', String(turnCount));

  return (
    <div className={`flex items-center gap-2 px-3 py-2 text-sm border-b ${tierStyles[tier]}`}>
      <ExclamationTriangleIcon className={`w-4 h-4 flex-shrink-0 ${tierIconStyles[tier]}`} />
      <span className="flex-1">{message}</span>
      {onMigrateSession && (
        <button
          onClick={onMigrateSession}
          className="flex-shrink-0 px-2 py-0.5 text-xs font-medium rounded bg-white/50 dark:bg-black/20 hover:bg-white/80 dark:hover:bg-black/40 transition-colors border border-current/20"
        >
          {i18nService.t('cowork.contextWarning.newSessionWithContext')}
        </button>
      )}
      <button
        onClick={handleDismiss}
        className="flex-shrink-0 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
        aria-label={i18nService.t('cowork.contextWarning.dismiss')}
      >
        <XMarkIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}