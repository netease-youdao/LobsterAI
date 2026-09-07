import type { PublishingSubscriptionRecoveryMode } from '@shared/publishing/constants';
import { type MouseEvent, useEffect, useRef } from 'react';

import { i18nService } from '@/services/i18n';

import { getPublishingSubscriptionRecoveryLabelKey } from './publishingSubscriptionRecoveryPolicy';

interface PublishingSubscriptionRecoveryButtonProps {
  recoveryMode: PublishingSubscriptionRecoveryMode;
  onClick: () => void;
  compact?: boolean;
  exposureKey?: string;
  onExposure?: () => void;
  onAcceptedClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

const PublishingSubscriptionRecoveryButton = ({
  recoveryMode,
  onClick,
  compact = false,
  exposureKey,
  onExposure,
  onAcceptedClick,
}: PublishingSubscriptionRecoveryButtonProps) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const reportedExposureKeyRef = useRef<string>();
  const label = i18nService.t(getPublishingSubscriptionRecoveryLabelKey(recoveryMode));

  useEffect(() => {
    if (!onExposure || !exposureKey || reportedExposureKeyRef.current === exposureKey) {
      return undefined;
    }
    const report = (): void => {
      if (reportedExposureKeyRef.current === exposureKey) return;
      reportedExposureKeyRef.current = exposureKey;
      onExposure();
    };
    if (!compact || typeof IntersectionObserver === 'undefined') {
      const frameId = window.requestAnimationFrame(report);
      return () => window.cancelAnimationFrame(frameId);
    }
    const element = buttonRef.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        report();
        observer.disconnect();
      }
    }, { threshold: 0.25 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact, exposureKey, onExposure]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={event => {
        event.preventDefault();
        event.stopPropagation();
        if (
          onExposure
          && exposureKey
          && reportedExposureKeyRef.current !== exposureKey
        ) {
          reportedExposureKeyRef.current = exposureKey;
          onExposure();
        }
        onAcceptedClick?.(event);
        onClick();
      }}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg bg-black font-medium text-white transition-colors hover:bg-neutral-800 active:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:bg-white dark:text-black dark:hover:bg-neutral-200 dark:active:bg-neutral-300 dark:focus-visible:ring-white/60 ${
        compact ? 'h-7 px-2.5 text-xs' : 'h-10 min-w-[112px] px-4 text-sm'
      }`}
    >
      {label}
    </button>
  );
};

export default PublishingSubscriptionRecoveryButton;
