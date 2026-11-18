import React from 'react';

import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
  SETTINGS_SECTION_TITLE_TEXT,
} from './settingsTypography';

export const SETTINGS_ACTION_BUTTON_CLASS =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100';

export const SETTINGS_ICON_BUTTON_CLASS =
  '-mr-1.5 shrink-0 rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-red-500';

export const SettingsSection: React.FC<{
  title?: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Brand mark shown in a fixed tile, so marks of any shape line up as a set. */
  icon?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, action, icon, children }) => (
  <section className="space-y-2.5">
    {title ? (
      <div className={`flex justify-between gap-4 px-1 ${icon ? 'items-start' : 'items-center'}`}>
        <div className="flex min-w-0 items-start gap-3">
          {icon ? (
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface [&>svg]:h-5 [&>svg]:w-5">
              {icon}
            </div>
          ) : null}
          <div className="min-w-0">
            <h4 className={`${SETTINGS_SECTION_TITLE_TEXT} font-semibold text-foreground`}>{title}</h4>
            {description ? (
              <div className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{description}</div>
            ) : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    ) : null}
    {children}
  </section>
);

export const SettingsStatusTone = {
  Neutral: 'neutral',
  Success: 'success',
  Warning: 'warning',
  Progress: 'progress',
  Danger: 'danger',
} as const;
export type SettingsStatusTone = typeof SettingsStatusTone[keyof typeof SettingsStatusTone];

const STATUS_TONE_CLASS: Record<SettingsStatusTone, { badge: string; dot: string }> = {
  [SettingsStatusTone.Neutral]: { badge: 'bg-surface-raised text-secondary', dot: 'bg-secondary/50' },
  [SettingsStatusTone.Success]: {
    badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  [SettingsStatusTone.Warning]: {
    badge: 'bg-amber-400/15 text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-400',
  },
  [SettingsStatusTone.Progress]: {
    badge: 'bg-amber-400/15 text-amber-700 dark:text-amber-400',
    dot: 'bg-amber-400 animate-pulse',
  },
  [SettingsStatusTone.Danger]: { badge: 'bg-red-500/10 text-red-600 dark:text-red-400', dot: 'bg-red-500' },
};

/** Compact state pill for a section header, readable while the section's card is scrolled away. */
export const SettingsStatusBadge: React.FC<{
  tone: SettingsStatusTone;
  label: string;
  /** Longer explanation shown on hover. */
  title?: string;
}> = ({ tone, label, title }) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE_CLASS[tone].badge}`}
  >
    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_TONE_CLASS[tone].dot}`} />
    {label}
  </span>
);

export const SettingsCard: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="divide-y divide-border rounded-xl border border-border bg-surface">
    {children}
  </div>
);

export const SettingsItem: React.FC<{
  title: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
}> = ({ title, description, control }) => (
  <div className="flex items-center justify-between gap-6 px-4 py-3">
    <div className="min-w-0 flex-1">
      <div className={`${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>{title}</div>
      {description ? (
        <div className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{description}</div>
      ) : null}
    </div>
    {control ? <div className="shrink-0">{control}</div> : null}
  </div>
);

export const SettingsCardMessage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className={`px-4 py-3 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{children}</div>
);
