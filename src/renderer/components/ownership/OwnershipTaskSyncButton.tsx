import { InformationCircleIcon } from '@heroicons/react/24/outline';
import { OwnershipContentSyncReason, OwnershipContentSyncState, OwnershipTargetKind } from '@shared/ownership/constants';
import React from 'react';

import { i18nService } from '../../services/i18n';
import { ownershipService } from '../../services/ownership';
import { useOwnershipDetail } from './useOwnershipDetail';

const OwnershipTaskSyncButton: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const target = { kind: OwnershipTargetKind.Task, id: sessionId };
  const detail = useOwnershipDetail(target, true);
  const content = detail?.contentSync;
  const failed = content?.state === OwnershipContentSyncState.Failed
    && (content.reason === OwnershipContentSyncReason.Content || content.reason === OwnershipContentSyncReason.History);
  if (!failed && content?.state !== OwnershipContentSyncState.Partial) return null;
  return <button type="button" title={i18nService.t('ownershipDetails')}
    className={`non-draggable inline-flex min-w-0 max-w-40 shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${failed ? 'text-amber-700 dark:text-amber-400' : 'text-secondary'}`}
    onClick={() => { void ownershipService.open(target); }}>
    <InformationCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span className="truncate">{i18nService.t(failed ? 'ownershipContentSyncEntryFailed' : 'ownershipContentSyncEntryPartial')}</span>
  </button>;
};
export default OwnershipTaskSyncButton;
