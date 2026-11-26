import { InformationCircleIcon } from '@heroicons/react/24/outline';
import type { OwnershipTarget } from '@shared/ownership/types';
import React from 'react';

import { i18nService } from '../../services/i18n';
import { ownershipService } from '../../services/ownership';

const OwnershipDetailButton: React.FC<{ target: OwnershipTarget }> = ({ target }) => <button
  type="button" className="non-draggable inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-secondary hover:bg-surface-raised hover:text-foreground"
  onClick={() => void ownershipService.open(target)}
  aria-label={i18nService.t('ownershipDetails')} title={i18nService.t('ownershipDetails')}
><InformationCircleIcon className="h-4 w-4" /></button>;
export default OwnershipDetailButton;
