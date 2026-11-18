import { SignalSlashIcon, WifiIcon } from '@heroicons/react/24/outline';
import React from 'react';

import { ModelReconnectStatus } from '../../../common/coworkSystemMessages';

/**
 * Inline row for a model stream that dropped mid-reply (Codex style): the
 * reconnect attempt while the runtime retries, then how it ended. Styled like
 * an activity step line so it reads as part of the turn's process.
 */
const ModelReconnectStatusLine: React.FC<{ label: string; status: unknown }> = ({ label, status }) => {
  const isRetrying = status === ModelReconnectStatus.Retrying;
  const isFailed = status === ModelReconnectStatus.Failed;
  const Icon = isFailed ? SignalSlashIcon : WifiIcon;
  return (
    <div
      className="flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted"
      role={isRetrying ? 'status' : undefined}
      aria-live={isRetrying ? 'polite' : undefined}
      data-model-reconnect-status={typeof status === 'string' ? status : undefined}
    >
      <span className={`flex flex-shrink-0 ${isFailed ? 'text-red-500/80' : ''}`} aria-hidden="true">
        <Icon className="h-[1em] w-[1em]" />
      </span>
      {/* Separate elements so a settled row does not fade in from the shimmer. */}
      {isRetrying ? (
        <span key="live" className="shimmer-text min-w-0 truncate">{label}</span>
      ) : (
        <span key="settled" className="min-w-0 truncate">{label}</span>
      )}
    </div>
  );
};

export default ModelReconnectStatusLine;
