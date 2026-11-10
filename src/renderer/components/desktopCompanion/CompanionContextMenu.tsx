import { CheckIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useLayoutEffect, useRef, useState } from 'react';

import type { DesktopCompanionState } from '../../../shared/desktopCompanion/constants';
import {
  COMPANION_CONTEXT_MENU_ROOT,
  type CompanionContextMenuItem,
  CompanionContextMenuSize,
  type CompanionContextMenuState,
} from '../../../shared/desktopCompanion/contextMenu';
import type { CompanionPoint } from '../../../shared/desktopCompanion/geometry';

/** Keeps a submenu open while the pointer crosses other items on its way there. */
const SUBMENU_CLOSE_DELAY_MS = 250;

interface MenuCardProps {
  items: CompanionContextMenuItem[];
  at: CompanionPoint;
  width: number;
  active: number;
  /** The item whose submenu is open. */
  expanded?: number;
  onItemEnter(index: number): void;
  onItemClick(index: number): void;
  onEnter?(): void;
  onLeave(): void;
}

function MenuCard({ items, at, width, active, expanded = -1, onItemEnter, onItemClick, onEnter, onLeave }: MenuCardProps) {
  const choices = items.some(item => item.checked !== undefined);
  return (
    <div
      className="ctx-card"
      role="menu"
      style={{ left: at.x, top: at.y, width }}
      // Keep focus on the surface, which handles the keyboard for both cards.
      onMouseDown={event => event.preventDefault()}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {item.divided && <div className="ctx-divider" role="separator" />}
          <button
            type="button"
            tabIndex={-1}
            className="ctx-item"
            role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={item.checked}
            aria-haspopup={item.submenu ? 'menu' : undefined}
            aria-expanded={item.submenu ? expanded === index : undefined}
            data-active={active === index}
            onMouseEnter={() => onItemEnter(index)}
            onClick={() => onItemClick(index)}
          >
            {choices && <span className="ctx-check">{item.checked && <CheckIcon />}</span>}
            <span className="ctx-label">{item.label}</span>
            {item.submenu && <ChevronRightIcon className="ctx-chevron" />}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

function ContextMenu({ menu }: { menu: CompanionContextMenuState }) {
  const api = window.electron.desktopCompanion;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(-1);
  // A highlighted submenu choice puts the keyboard in the submenu.
  const [subActive, setSubActive] = useState(-1);
  const submenu = open >= 0 ? menu.items[open].submenu ?? [] : [];

  // The window is shown only after this opening has painted, so it never flashes a previous menu.
  useLayoutEffect(() => {
    surfaceRef.current?.focus();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        void api.contextMenuReady(menu.id).then(shown => { if (shown) surfaceRef.current?.focus(); })
          .catch(error => console.error('[CompanionContextMenu] Failed to show the menu', error));
      });
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(closeTimer.current); };
  }, [api, menu.id]);

  const run = (id: string) => {
    void api.runContextMenuItem(id).catch(error => console.error('[CompanionContextMenu] Menu action failed', error));
  };
  const dismiss = () => { void api.dismissContextMenu(); };
  const openSubmenu = (index: number, selectChoice: boolean) => {
    clearTimeout(closeTimer.current);
    setActive(index);
    setOpen(index);
    const choices = menu.items[index].submenu ?? [];
    setSubActive(selectChoice ? Math.max(0, choices.findIndex(item => item.checked)) : -1);
  };
  const closeSubmenu = () => {
    clearTimeout(closeTimer.current);
    setOpen(-1);
    setSubActive(-1);
  };
  const activate = (index: number, fromKeyboard: boolean) => {
    const item = menu.items[index];
    if (item.submenu) openSubmenu(index, fromKeyboard);
    else run(item.id);
  };
  const hoverItem = (index: number) => {
    setActive(index);
    setSubActive(-1);
    if (menu.items[index].submenu) { openSubmenu(index, false); return; }
    if (open < 0) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(closeSubmenu, SUBMENU_CLOSE_DELAY_MS);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const inSubmenu = subActive >= 0;
    const list = inSubmenu ? submenu : menu.items;
    const current = inSubmenu ? subActive : active;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const next = current < 0 ? (delta > 0 ? 0 : list.length - 1) : (current + delta + list.length) % list.length;
        if (inSubmenu) setSubActive(next);
        else { setActive(next); if (open >= 0) closeSubmenu(); }
        break;
      }
      case 'ArrowRight':
        if (!inSubmenu && active >= 0 && menu.items[active].submenu) openSubmenu(active, true);
        break;
      case 'ArrowLeft':
        if (open >= 0) closeSubmenu();
        break;
      case 'Escape':
        if (open >= 0) closeSubmenu();
        else dismiss();
        break;
      case 'Enter':
      case ' ':
        if (inSubmenu) run(submenu[subActive].id);
        else if (active >= 0) activate(active, true);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <div
      ref={surfaceRef}
      className="ctx-surface"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      // The transparent room around the cards is outside the menu.
      onMouseDown={event => { if (event.target === event.currentTarget) dismiss(); }}
      onContextMenu={event => event.preventDefault()}
    >
      <MenuCard
        items={menu.items}
        at={menu.cards[COMPANION_CONTEXT_MENU_ROOT]}
        width={CompanionContextMenuSize.Width}
        active={active}
        expanded={open}
        onItemEnter={hoverItem}
        onItemClick={index => activate(index, false)}
        onLeave={() => { if (open < 0) setActive(-1); }}
      />
      {open >= 0 && submenu.length > 0 && menu.cards[menu.items[open].id] && (
        <MenuCard
          items={submenu}
          at={menu.cards[menu.items[open].id]}
          width={CompanionContextMenuSize.SubmenuWidth}
          active={subActive}
          onItemEnter={setSubActive}
          onItemClick={index => run(submenu[index].id)}
          onEnter={() => { clearTimeout(closeTimer.current); setActive(open); }}
          onLeave={() => setSubActive(-1)}
        />
      )}
    </div>
  );
}

/** The orb's right-click menu on macOS, drawn in a panel that also shows over full-screen apps. */
export default function CompanionContextMenu({ state }: { state: DesktopCompanionState }) {
  if (!state.contextMenu) return null;
  return <ContextMenu key={state.contextMenu.id} menu={state.contextMenu} />;
}
