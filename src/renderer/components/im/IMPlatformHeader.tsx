import React from 'react';

import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_SECTION_TITLE_TEXT } from '../settings/settingsTypography';

interface IMPlatformHeaderProps {
  logo: string;
  name: string;
  description?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
}

/**
 * Identity row at the top of a platform's settings pane: logo, name, live
 * status and the platform-level actions (connectivity test, enable switch).
 *
 * Logos ship in mixed shapes (full-bleed app icons and bare glyphs), so each
 * sits on the same framed tile to keep the header reading consistently.
 */
const IMPlatformHeader: React.FC<IMPlatformHeaderProps> = ({ logo, name, description, status, actions }) => (
  <div className="flex items-center gap-3.5">
    <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-surface shadow-subtle ring-1 ring-border">
      <img src={logo} alt="" className="h-7 w-7 rounded-lg object-contain" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className={`truncate ${SETTINGS_SECTION_TITLE_TEXT} font-semibold text-foreground`}>{name}</h3>
        {status}
      </div>
      {description && (
        <div className={`mt-0.5 line-clamp-2 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>{description}</div>
      )}
    </div>
    {actions && <div className="flex flex-shrink-0 items-center gap-3">{actions}</div>}
  </div>
);

export default IMPlatformHeader;
