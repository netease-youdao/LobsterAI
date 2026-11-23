import {
  ExclamationTriangleIcon,
  GlobeAltIcon,
  ShieldExclamationIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  CommandLineIcon,
  FolderIcon,
} from '@heroicons/react/24/solid';
import React, { useId } from 'react';

import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import {
  FULL_ACCESS_RISK_ITEMS,
  FullAccessRiskItemId,
} from './permissionPresetOptions';

interface FullAccessConfirmDialogProps {
  isOpen: boolean;
  confirming?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const RISK_ITEM_ICONS: Record<
  FullAccessRiskItemId,
  {
    Icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    iconClassName: string;
  }
> = {
  [FullAccessRiskItemId.Files]: {
    Icon: FolderIcon,
    iconClassName: 'text-blue-500 dark:text-blue-400',
  },
  [FullAccessRiskItemId.Terminal]: {
    Icon: CommandLineIcon,
    iconClassName: 'text-foreground/80',
  },
  [FullAccessRiskItemId.Network]: {
    Icon: GlobeAltIcon,
    iconClassName: 'text-sky-500 dark:text-sky-400',
  },
};

const FullAccessConfirmDialog: React.FC<FullAccessConfirmDialogProps> = ({
  isOpen,
  confirming = false,
  onCancel,
  onConfirm,
}) => {
  const titleId = useId();
  const descriptionId = useId();

  const handleCancel = () => {
    if (!confirming) onCancel();
  };

  const handleConfirm = () => {
    if (confirming) return;
    onConfirm();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleCancel}
      onEscape={handleCancel}
      overlayClassName="fixed inset-0 z-[9999] flex items-center justify-center modal-backdrop px-4"
      className="modal-content w-full max-w-[460px] overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <ShieldExclamationIcon
              className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden={true}
            />
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              {i18nService.t('coworkFullAccessConfirmTitle')}
            </h2>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            disabled={confirming}
            aria-label={i18nService.t('close')}
            className="rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            <XMarkIcon className="h-4 w-4" aria-hidden={true} />
          </button>
        </div>

        <div className="space-y-3.5 px-6 pb-5">
          <p id={descriptionId} className="text-sm leading-relaxed text-secondary">
            {i18nService.t('coworkFullAccessConfirmLead')}
          </p>

          <div className="divide-y divide-border/60 rounded-xl border border-border/70 bg-surface-raised/60">
            {FULL_ACCESS_RISK_ITEMS.map((item) => {
              const { Icon, iconClassName } = RISK_ITEM_ICONS[item.id];
              return (
                <div key={item.id} className="flex items-start gap-3 px-3.5 py-2.5">
                  <Icon
                    className={`mt-0.5 h-5 w-5 shrink-0 ${iconClassName}`}
                    aria-hidden={true}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {i18nService.t(item.titleKey)}
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-secondary">
                      {i18nService.t(item.descKey)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-xs leading-relaxed text-secondary">
            {i18nService.t('coworkFullAccessConfirmNotice')}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2.5 px-6 pb-5 pt-0.5">
          <button
            type="button"
            autoFocus
            onClick={handleCancel}
            disabled={confirming}
            className="rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirming}
            className="inline-flex items-center gap-1.5 rounded-xl bg-red-500/15 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-500/20 dark:text-red-400 dark:hover:bg-red-500/30"
          >
            <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden={true} />
            <span>{i18nService.t('coworkFullAccessConfirmAction')}</span>
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default FullAccessConfirmDialog;
