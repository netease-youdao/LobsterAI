import React from 'react';

import { i18nService } from '@/services/i18n';
import { useWordPanel } from '@/services/office/word/useWordPanel';
import { openLocalPathWithToast } from '@/utils/localFileActions';

import { useOfficePreviewActions, useRegisterOfficeOwnsDocumentToolbar } from '../common/OfficePreviewActionsContext';

export default function WordPanel({ filePath, onAddToChat }: {
  filePath: string; onAddToChat?: (text: string) => void;
}): React.ReactElement {
  const actions = useOfficePreviewActions()?.documentActions;
  const { element, failed, snapshot, retry } = useWordPanel(filePath, actions, onAddToChat);
  useRegisterOfficeOwnsDocumentToolbar(!failed);
  return <div ref={element} className="relative h-full w-full overflow-hidden" data-word-panel-host>
    {failed ? <div role="alert" className="lobster-office-notice">
      <p>{i18nService.t('wordAccessFailed')}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={retry}>{i18nService.t('retry')}</button>
        <button type="button" onClick={() => { void openLocalPathWithToast(filePath); }}>{i18nService.t('officeOpenExternal')}</button>
      </div>
    </div> : snapshot ? <img aria-hidden="true" alt="" src={snapshot} className="pointer-events-none absolute inset-0 h-full w-full" />
      : <div role="status" className="p-6 text-sm opacity-60">{i18nService.t('wordLoading')}</div>}
  </div>;
}
