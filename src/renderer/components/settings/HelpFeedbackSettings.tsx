import { ArrowUpRightIcon, CheckIcon, ChevronRightIcon } from '@heroicons/react/20/solid';
import React from 'react';

import { i18nService } from '../../services/i18n';
import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_ITEM_TITLE_TEXT } from './settingsTypography';

interface HelpFeedbackSettingsProps {
  contactEmail: string;
  userManualUrl: string;
  userCommunityUrl: string;
  emailCopied: boolean;
  onOpenFeedback: () => void;
  onCopyContactEmail: () => void | Promise<void>;
  onOpenUserManual: () => void;
  onOpenUserCommunity: () => void;
}

const rowClassName = 'flex w-full items-center gap-4 px-4 py-3.5 text-left';
const actionRowClassName = `${rowClassName} group transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-surface-raised focus:outline-none focus-visible:bg-surface-raised`;
const trailingIconClassName = 'h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-foreground';

const RowText: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <div className="min-w-0 flex-1">
    <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>{title}</div>
    <div className={`mt-0.5 truncate ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{description}</div>
  </div>
);

const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-2.5">
    <h4 className="px-1 text-xs font-semibold uppercase tracking-wider text-secondary">{title}</h4>
    <div className="divide-y divide-border rounded-xl border border-border bg-surface">{children}</div>
  </section>
);

const ActionRow: React.FC<{
  title: string;
  description: string;
  external?: string;
  onClick: () => void;
}> = ({ title, description, external, onClick }) => (
  <button type="button" title={external} onClick={onClick} className={actionRowClassName}>
    <RowText title={title} description={description} />
    {external
      ? <ArrowUpRightIcon className={trailingIconClassName} aria-hidden="true" />
      : <ChevronRightIcon className={trailingIconClassName} aria-hidden="true" />}
  </button>
);

const HelpFeedbackSettings: React.FC<HelpFeedbackSettingsProps> = ({
  contactEmail,
  userManualUrl,
  userCommunityUrl,
  emailCopied,
  onOpenFeedback,
  onCopyContactEmail,
  onOpenUserManual,
  onOpenUserCommunity,
}) => (
  <div className="space-y-8">
    <Group title={i18nService.t('helpGroupResources')}>
      <ActionRow
        title={i18nService.t('aboutUserManual')}
        description={i18nService.t('helpUserManualDescription')}
        external={userManualUrl}
        onClick={onOpenUserManual}
      />
      <ActionRow
        title={i18nService.t('aboutUserCommunity')}
        description={i18nService.t('helpUserCommunityDescription')}
        external={userCommunityUrl}
        onClick={onOpenUserCommunity}
      />
    </Group>

    <Group title={i18nService.t('helpGroupContact')}>
      <ActionRow
        title={i18nService.t('feedbackTitle')}
        description={i18nService.t('feedbackSubtitle')}
        onClick={onOpenFeedback}
      />
      <div className={rowClassName}>
        <RowText title={i18nService.t('aboutContactEmail')} description={i18nService.t('helpContactEmailDescription')} />
        <span className={`min-w-0 shrink truncate select-text ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{contactEmail}</span>
        <button
          type="button"
          onClick={() => void onCopyContactEmail()}
          aria-live="polite"
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md border px-2.5 text-xs font-medium transition-colors ${
            emailCopied
              ? 'border-transparent text-emerald-600 dark:text-emerald-400'
              : 'border-border text-foreground hover:bg-surface-raised'
          }`}
        >
          {emailCopied && <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />}
          {i18nService.t(emailCopied ? 'copied' : 'copy')}
        </button>
      </div>
    </Group>
  </div>
);

export default HelpFeedbackSettings;
