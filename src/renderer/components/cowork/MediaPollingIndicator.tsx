import Lottie from 'lottie-react';
import React from 'react';

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
  const pollCount = group.pollCount > 1 ? group.pollCount : undefined;
  const isVideo = group.toolName.includes('video');

  const label = group.isComplete
    ? i18nService.t(mediaTaskLabelKey({ status: group.lastStatus }))
    : isVideo
      ? i18nService.t('mediaGeneratingVideo')
      : i18nService.t('mediaGeneratingImage');

  const statusQueryText = pollCount == null
    ? ''
    : i18nService.t('mediaStatusQueryCount').replace('{count}', String(pollCount));

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
          </div>
        </div>
      </div>
    </div>
  );
};

export default MediaPollingIndicator;
