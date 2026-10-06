import React from 'react';

import { i18nService } from '../../services/i18n';

interface SiteDeleteWarningsProps {
  showFreeQuotaNotice: boolean;
  showPersistenceWarning: boolean;
}

const SiteDeleteWarnings: React.FC<SiteDeleteWarningsProps> = ({
  showFreeQuotaNotice,
  showPersistenceWarning,
}) => {
  if (!showFreeQuotaNotice && !showPersistenceWarning) return null;

  return (
    <div className="mt-2 space-y-1 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs leading-5 text-red-700 dark:text-red-300">
      {showFreeQuotaNotice && <p>{i18nService.t('sitesDeleteQuotaNotice')}</p>}
      {showPersistenceWarning && <p>{i18nService.t('sitesDeletePersistenceWarning')}</p>}
    </div>
  );
};

export default SiteDeleteWarnings;
