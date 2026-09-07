import { useEffect, useRef } from 'react';

import {
  type PublishingRecoveryAnalyticsContext,
  resetPublishingRecoveryCtaExposure,
} from './publishingAnalytics';

interface VisibleRecoveryExposure {
  context: PublishingRecoveryAnalyticsContext;
  visible: boolean;
}

export const usePublishingRecoveryExposureLifecycle = (
  context: PublishingRecoveryAnalyticsContext | null | undefined,
  visible: boolean,
): void => {
  const previousRef = useRef<VisibleRecoveryExposure>();

  useEffect(() => {
    const previous = previousRef.current;
    if (
      previous?.visible
      && (
        !visible
        || !context
        || previous.context.exposureId !== context.exposureId
      )
    ) {
      resetPublishingRecoveryCtaExposure(previous.context);
    }
    previousRef.current = context ? { context, visible } : undefined;
  }, [context, visible]);
};
