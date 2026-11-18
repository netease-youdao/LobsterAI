import {
  ArrowDownTrayIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { showToast } from '../../utils/localFileActions';
import PlanModeIcon from '../icons/PlanModeIcon';
import MarkdownContent from '../MarkdownContent';
import {
  bucketLength,
  getMessageLineCount,
  reportConversationBlockAction,
} from './conversationAnalytics';
import type { ImagePreviewSource } from './ImagePreviewModal';
import { MessageActionButton, MessageCopyButton } from './MessageActionButton';

interface ProposedPlanBlockProps {
  content: string;
  resolveLocalFilePath?: (href: string, text: string) => string | null;
  onImageClick: (image: ImagePreviewSource) => void;
  showConfirmationActions?: boolean;
  onConfirmExecution?: () => void;
  onAdjustPlan?: () => void;
  forceExpanded?: boolean;
}

const ACTION_FEEDBACK_DURATION_MS = 1500;

// The plan sits inside a card, so its headings step down one level to stay
// below the conversation's own markdown headings.
const PLAN_MARKDOWN_CLASS = [
  'prose dark:prose-invert max-w-none',
  '[&_h1]:!text-[length:var(--lobster-text-markdownH3)]',
  '[&_h2]:!text-[length:var(--lobster-text-markdownH3)]',
  '[&_h3]:!text-[length:var(--lobster-text-markdownH4)]',
].join(' ');

const getPlanAnalyticsParams = (content: string) => ({
  planLength: content.length,
  planLengthBucket: bucketLength(content.length),
  planLineCount: getMessageLineCount(content),
});

const ProposedPlanBlock: React.FC<ProposedPlanBlockProps> = ({
  content,
  resolveLocalFilePath,
  onImageClick,
  showConfirmationActions = false,
  onConfirmExecution,
  onAdjustPlan,
  forceExpanded = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const downloadTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (downloadTimerRef.current !== null) window.clearTimeout(downloadTimerRef.current);
  }, []);

  const handleDownload = useCallback(() => {
    const analyticsParams = getPlanAnalyticsParams(content);
    let objectUrl: string | null = null;
    let anchor: HTMLAnchorElement | null = null;
    try {
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      objectUrl = URL.createObjectURL(blob);
      anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `lobsterai-plan-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      setIsDownloaded(true);
      if (downloadTimerRef.current !== null) window.clearTimeout(downloadTimerRef.current);
      downloadTimerRef.current = window.setTimeout(
        () => setIsDownloaded(false),
        ACTION_FEEDBACK_DURATION_MS,
      );
      window.electron?.log?.fromRenderer?.(
        'debug',
        'ProposedPlanBlock',
        'Downloaded the proposed plan as a Markdown file.',
      );
      reportConversationBlockAction({
        actionType: 'plan_download',
        blockType: 'proposed_plan',
        params: {
          result: 'success',
          ...analyticsParams,
        },
      });
    } catch (error) {
      console.warn('[ProposedPlanBlock] failed to download the proposed plan:', error);
      window.electron?.log?.fromRenderer?.(
        'warn',
        'ProposedPlanBlock',
        'Failed to download the proposed plan as a Markdown file.',
      );
      reportConversationBlockAction({
        actionType: 'plan_download',
        blockType: 'proposed_plan',
        params: {
          result: 'failed',
          ...analyticsParams,
        },
      });
      showToast(i18nService.t('coworkProposedPlanDownloadFailed'));
    } finally {
      anchor?.remove();
      if (objectUrl) {
        const objectUrlToRevoke = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(objectUrlToRevoke), 0);
      }
    }
  }, [content]);

  const handleToggleExpanded = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setIsExpanded(value => {
      const nextExpanded = !value;
      reportConversationBlockAction({
        actionType: nextExpanded ? 'plan_expand' : 'plan_collapse',
        blockType: 'proposed_plan',
        params: getPlanAnalyticsParams(content),
      });
      return nextExpanded;
    });
  }, [content]);

  const handleConfirmExecution = useCallback(() => {
    reportConversationBlockAction({
      actionType: 'plan_confirm_execute',
      blockType: 'proposed_plan',
      params: getPlanAnalyticsParams(content),
    });
    onConfirmExecution?.();
  }, [content, onConfirmExecution]);

  const handleAdjustPlan = useCallback(() => {
    reportConversationBlockAction({
      actionType: 'plan_adjust',
      blockType: 'proposed_plan',
      params: getPlanAnalyticsParams(content),
    });
    onAdjustPlan?.();
  }, [content, onAdjustPlan]);

  const contentExpanded = isExpanded || forceExpanded;
  const toggleLabel = i18nService.t(
    contentExpanded ? 'coworkProposedPlanCollapse' : 'coworkProposedPlanExpand',
  );

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-background"
      aria-label={i18nService.t('coworkProposedPlanTitle')}
    >
      <header
        className="flex h-10 items-center justify-between gap-3 bg-surface-raised/40 pl-4 pr-1.5 sm:pl-5"
        data-cowork-search-exclude="true"
      >
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <PlanModeIcon className="h-4 w-4 shrink-0 text-secondary" />
          <span className="truncate">{i18nService.t('coworkProposedPlanTitle')}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <MessageActionButton
            label={i18nService.t('coworkProposedPlanDownload')}
            onClick={(event) => {
              event.stopPropagation();
              handleDownload();
            }}
          >
            {isDownloaded ? (
              <CheckIcon className="h-4 w-4 text-success" />
            ) : (
              <ArrowDownTrayIcon className="h-4 w-4" />
            )}
          </MessageActionButton>
          <MessageCopyButton
            content={content}
            onCopy={(result) => reportConversationBlockAction({
              actionType: 'plan_copy',
              blockType: 'proposed_plan',
              params: {
                result,
                ...getPlanAnalyticsParams(content),
              },
            })}
          />
          <MessageActionButton
            label={toggleLabel}
            onClick={forceExpanded ? event => event.stopPropagation() : handleToggleExpanded}
            expanded={contentExpanded}
          >
            {contentExpanded ? (
              <ChevronUpIcon className="h-4 w-4" />
            ) : (
              <ChevronDownIcon className="h-4 w-4" />
            )}
          </MessageActionButton>
        </div>
      </header>
      {contentExpanded && (
        <div className="border-t border-border px-4 py-4 sm:px-5">
          <MarkdownContent
            content={content}
            className={PLAN_MARKDOWN_CLASS}
            resolveLocalFilePath={resolveLocalFilePath}
            forceExpanded={forceExpanded}
            onImageClick={onImageClick}
          />
        </div>
      )}
      {showConfirmationActions && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-raised/40 px-4 py-2.5 sm:px-5"
          data-cowork-search-exclude="true"
        >
          <div className="text-sm text-secondary">
            {i18nService.t('coworkPlanConfirmationReady')}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleAdjustPlan}
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-[0.98]"
            >
              {i18nService.t('coworkPlanAdjust')}
            </button>
            <button
              type="button"
              onClick={handleConfirmExecution}
              className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-[0.98]"
            >
              {i18nService.t('coworkPlanConfirmExecute')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
};

export default ProposedPlanBlock;
