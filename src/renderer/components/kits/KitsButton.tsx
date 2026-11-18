import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useRef } from 'react';

import { i18nService } from '../../services/i18n';
import { PROMPT_MENU_ROW_CLASS, type PromptMenuItemControl } from '../common/promptSubmenu';
import SidebarKitsIcon from '../icons/SidebarKitsIcon';
import KitsPopover from './KitsPopover';

interface KitsButtonProps {
  onSelectKit: (kitId: string) => void;
  onManageKits: () => void;
  /** The button is a row of the prompt's add menu, with the kits as its submenu. */
  menuItem: PromptMenuItemControl;
}

const KitsButton: React.FC<KitsButtonProps> = ({
  onSelectKit,
  onManageKits,
  menuItem,
}) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
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
        <span className="min-w-0 flex-1 truncate">{i18nService.t('useKits')}</span>
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
};

export default KitsButton;
