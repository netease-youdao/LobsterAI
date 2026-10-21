import Lottie from 'lottie-react';
import React, { useEffect, useState } from 'react';

import { MediaTaskStatus } from '../../../shared/media/constants';
import mediaGeneratingAnimation from '../../assets/lottie/media-generating.json';
import { i18nService } from '../../services/i18n';
import { mediaTaskLabelKey } from './MediaTaskCard';
import type { ToolGroupItem } from './messageDisplayUtils';

export type MediaPollingGroup = {
  type: 'media_polling_group';
  toolName: string;
  taskId: string;
  upstreamTaskId?: string;
  lastStatus?: string | null;
  pollCount: number;
  polls: ToolGroupItem[];
  isComplete: boolean;
};

const MediaPollingIndicator: React.FC<{
  group: MediaPollingGroup;
  isLastInSequence?: boolean;
}> = ({ group, isLastInSequence = true }) => {
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const pollCount = group.pollCount > 1 ? group.pollCount : undefined;
  const collapsedPollCount = group.polls.length;
  const isVideo = group.toolName.includes('video');

  const canCancel = !group.isComplete && group.taskId
    && (group.lastStatus === 'queued' || (group.lastStatus == null && collapsedPollCount <= 1));

  const label = group.isComplete
    ? i18nService.t(mediaTaskLabelKey({ status: group.lastStatus }))
    : isVideo
      ? i18nService.t('mediaGeneratingVideo')
      : i18nService.t('mediaGeneratingImage');

  const statusQueryText = pollCount == null
    ? ''
    : i18nService.t('mediaStatusQueryCount').replace('{count}', String(pollCount));

  useEffect(() => {
    if (!cancelError) return;
    const timer = setTimeout(() => setCancelError(null), 3000);
    return () => clearTimeout(timer);
  }, [cancelError]);

  const handleCancel = async () => {
    if (!group.taskId || cancelling) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const result = await window.electron.cowork.cancelMediaTask(group.taskId);
      if (!result.success) {
        setCancelError(result.message || 'Cancel failed');
      }
    } catch {
      setCancelError('Cancel failed');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="relative py-1">
      {!isLastInSequence && (
        <div className="absolute left-[3.5px] top-[14px] bottom-[-8px] w-px bg-border" />
      )}
      <div className="w-full flex items-start gap-2 relative z-10">
        <span className="mt-0.5 w-[36px] h-[36px] flex-shrink-0 flex items-center justify-center">
          {group.isComplete ? (
            <span className={`w-2 h-2 rounded-full ${group.lastStatus === MediaTaskStatus.Succeeded ? 'bg-green-500' : 'bg-amber-500'}`} />
          ) : (
            <Lottie
              animationData={mediaGeneratingAnimation}
              loop
              autoplay
              style={{ width: 36, height: 36 }}
            />
          )}
        </span>
        <div className="flex-1 min-w-0 py-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-secondary">{label}</span>
            <span className="text-xs text-muted break-all">
              taskid:{group.upstreamTaskId || group.taskId}{statusQueryText ? `  ${statusQueryText}` : ''}
            </span>
            {canCancel && (
              <button
                className="px-2 py-0.5 text-xs rounded border border-red-300 text-red-500 hover:bg-red-50 dark:hover:bg-red-950 disabled:opacity-50"
                onClick={handleCancel}
                disabled={cancelling}
              >
                {cancelling ? '...' : i18nService.t('mediaTaskCancel') || 'Cancel'}
              </button>
            )}
            {cancelError && (
              <span className="text-xs text-red-500">{cancelError}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MediaPollingIndicator;
