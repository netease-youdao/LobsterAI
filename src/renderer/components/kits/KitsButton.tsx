import React, { useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import SidebarKitsIcon from '../icons/SidebarKitsIcon';
import KitsPopover from './KitsPopover';

interface KitsButtonProps {
  onSelectKit: (kitId: string) => void;
  onManageKits: () => void;
  className?: string;
  iconClassName?: string;
  onOpenChange?: (open: boolean) => void;
}

const KitsButton: React.FC<KitsButtonProps> = ({
  onSelectKit,
  onManageKits,
  className = '',
  iconClassName = 'h-5 w-5',
  onOpenChange,
}) => {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleButtonClick = () => {
    setIsPopoverOpen(prev => {
      const next = !prev;
      onOpenChange?.(next);
      return next;
    });
  };

  const handleClosePopover = () => {
    onOpenChange?.(false);
    setIsPopoverOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={handleButtonClick}
        className={`flex h-[34px] w-[34px] items-center justify-center rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors ${className}`}
        title={i18nService.t('kits')}
        aria-label={i18nService.t('kits')}
      >
        <SidebarKitsIcon className={iconClassName} />
      </button>
      <KitsPopover
        isOpen={isPopoverOpen}
        onClose={handleClosePopover}
        onSelectKit={onSelectKit}
        onManageKits={onManageKits}
        anchorRef={buttonRef}
      />
    </div>
  );
};

export default KitsButton;
