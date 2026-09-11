import { ArrowPathIcon, InformationCircleIcon, LinkIcon } from '@heroicons/react/24/outline';
import { OwnershipSyncState, OwnershipTargetKind } from '@shared/ownership/constants';
import type { OwnershipTarget } from '@shared/ownership/types';
import React from 'react';

import { i18nService } from '../../services/i18n';
import { ownershipService, OwnershipView } from '../../services/ownership';
import { useOwnershipDetail } from './useOwnershipDetail';

const OwnershipMenuItems: React.FC<{ target: OwnershipTarget; onAction: () => void; className: string }> = ({ target, onAction, className }) => {
  const detail = useOwnershipDetail(target, true);
  const open = (view: OwnershipView) => { onAction(); void ownershipService.open(target, view); };
  return <>
    {target.kind === OwnershipTargetKind.Agent && <button type="button" role="menuitem" className={className} onClick={event => { event.stopPropagation(); open(OwnershipView.Detail); }}>
      <InformationCircleIcon className="h-3.5 w-3.5" />
      {i18nService.t('ownershipAgentDetails')}
    </button>}
    {detail?.canAssociate && <button type="button" role="menuitem" className={className} onClick={event => { event.stopPropagation(); open(OwnershipView.Preview); }}>
      <LinkIcon className="h-3.5 w-3.5" />{i18nService.t('ownershipAssociate')}
    </button>}
    {detail?.ownership.kind === 'owned' && detail.syncState === OwnershipSyncState.Failed && <button
      type="button" role="menuitem" className={className} onClick={event => {
        event.stopPropagation(); onAction(); void ownershipService.retrySync(target);
      }}>
      <ArrowPathIcon className="h-3.5 w-3.5" />{i18nService.t('ownershipRetrySync')}
    </button>}
  </>;
};
export default OwnershipMenuItems;
