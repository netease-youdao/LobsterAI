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
  children: React.ReactNode;
}> = ({ title, description, action, children }) => (
  <section className="space-y-2.5">
    {title ? (
      <div className="flex items-center justify-between gap-4 px-1">
        <div className="min-w-0">
          <h4 className={`${SETTINGS_SECTION_TITLE_TEXT} font-semibold text-foreground`}>{title}</h4>
          {description ? (
            <div className={`mt-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{description}</div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    ) : null}
    {children}
  </section>
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
