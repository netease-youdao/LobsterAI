import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { PROMPT_MENU_ROW_CLASS, type PromptMenuItemControl } from '../common/promptSubmenu';
import SidebarKitsIcon from '../icons/SidebarKitsIcon';
import KitsPopover from './KitsPopover';

interface KitsButtonProps {
  onSelectKit: (kitId: string) => void;
  onManageKits: () => void;
  className?: string;
  iconClassName?: string;
  onOpenChange?: (open: boolean) => void;
  /** Shows the button as a row of the prompt's add menu, with the kits as its submenu. */
  menuItem?: PromptMenuItemControl;
}

const KitsButton: React.FC<KitsButtonProps> = ({
  onSelectKit,
  onManageKits,
  className = '',
  iconClassName = 'h-5 w-5',
  onOpenChange,
  menuItem,
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

  if (menuItem) {
    const openSubmenu = () => menuItem.onOpenChange(true);
    // No positioned wrapper: the submenu hangs off the add menu itself.
    return (
      <>
        <button
          ref={buttonRef}
          type="button"
          onClick={openSubmenu}
          onMouseEnter={openSubmenu}
          onFocus={openSubmenu}
          className={`${PROMPT_MENU_ROW_CLASS} ${menuItem.open ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`}
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={menuItem.open}
        >
          <SidebarKitsIcon className="h-5 w-5 shrink-0 text-secondary" />
          <span className="min-w-0 flex-1 truncate">{i18nService.t('kits')}</span>
          <ChevronRightIcon className="h-4 w-4 shrink-0 text-secondary" />
        </button>
        <KitsPopover
          isOpen={menuItem.open}
          onClose={() => menuItem.onOpenChange(false)}
          onSelectKit={onSelectKit}
          onManageKits={onManageKits}
          anchorRef={buttonRef}
          asSubmenu
          side={menuItem.side}
        />
      </>
    );
  }

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
