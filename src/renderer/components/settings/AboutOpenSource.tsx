import { StarIcon } from '@heroicons/react/24/solid';
import React from 'react';

import {
  OPEN_SOURCE_FORK_URL,
  OPEN_SOURCE_LICENSE_URL,
  OPEN_SOURCE_REPO_URL,
} from '../../constants/openSource';
import { i18nService } from '../../services/i18n';
import GitHubMarkIcon from '../icons/GitHubMarkIcon';
import RepoForkedIcon from '../icons/RepoForkedIcon';

export const AboutOpenSourceAction = {
  OpenRepo: 'open_source_repo',
  OpenLicense: 'open_source_license',
  StarPromptStar: 'star_prompt_star',
  StarPromptFork: 'star_prompt_fork',
} as const;
export type AboutOpenSourceAction = typeof AboutOpenSourceAction[keyof typeof AboutOpenSourceAction];

interface AboutOpenSourceProps {
  onAction: (action: AboutOpenSourceAction) => void;
}

const infoRowClassName = 'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 border-b border-border';
const infoRowLinkClassName = 'min-w-0 break-all text-right text-sm text-secondary hover:text-primary dark:hover:text-primary bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer focus:outline-none hover:bg-surface-raised transition-colors';
const promptButtonClassName = 'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-foreground transition-colors hover:border-primary hover:text-primary dark:hover:border-primary dark:hover:text-primary';

const openExternalLink = (url: string): void => {
  void window.electron.shell.openExternal(url);
};

/** Info-card rows for the repository and license; rendered inside the About card. */
export const AboutOpenSourceRows: React.FC<AboutOpenSourceProps> = ({ onAction }) => (
  <>
    <div className={infoRowClassName}>
      <span className="shrink-0 text-sm text-foreground">{i18nService.t('aboutSourceCode')}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(AboutOpenSourceAction.OpenRepo);
          openExternalLink(OPEN_SOURCE_REPO_URL);
        }}
        className={infoRowLinkClassName}
      >
        {OPEN_SOURCE_REPO_URL}
      </button>
    </div>
    <div className={infoRowClassName}>
      <span className="shrink-0 text-sm text-foreground">{i18nService.t('aboutLicense')}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(AboutOpenSourceAction.OpenLicense);
          openExternalLink(OPEN_SOURCE_LICENSE_URL);
        }}
        className={infoRowLinkClassName}
      >
        {i18nService.t('aboutLicenseMit')}
      </button>
    </div>
  </>
);

/** Permanent invitation to star or fork the repository, shown below the About card. */
export const AboutOpenSourceStarPrompt: React.FC<AboutOpenSourceProps> = ({ onAction }) => (
  <div className="mt-4 flex w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-primary/20 bg-primary/[0.06] px-4 py-3">
    <div className="flex min-w-0 grow basis-72 items-center gap-3">
      <GitHubMarkIcon className="h-6 w-6 shrink-0 text-foreground" />
      <div className="min-w-0">
        <p className="text-sm font-medium leading-5 text-foreground">
          {i18nService.t('aboutOpenSourceStarPromptTitle')}
        </p>
        <p className="mt-0.5 text-xs leading-4 text-secondary">
          {i18nService.t('aboutOpenSourceStarPrompt')}
        </p>
      </div>
    </div>
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(AboutOpenSourceAction.StarPromptStar);
          openExternalLink(OPEN_SOURCE_REPO_URL);
        }}
        className={promptButtonClassName}
      >
        <StarIcon className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
        {i18nService.t('aboutOpenSourceStar')}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(AboutOpenSourceAction.StarPromptFork);
          openExternalLink(OPEN_SOURCE_FORK_URL);
        }}
        className={promptButtonClassName}
      >
        <RepoForkedIcon className="h-3.5 w-3.5" />
        {i18nService.t('aboutOpenSourceFork')}
      </button>
    </div>
  </div>
);
