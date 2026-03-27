import type { Editor } from '@tiptap/core';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';

interface SuggestionViewModel {
  title: string;
  subtitle?: string;
  badge?: string;
}

interface CreateSuggestionRendererOptions<TItem> {
  editor: Editor;
  emptyText: string;
  getItemView: (item: TItem) => SuggestionViewModel;
  onOpen?: () => void;
  onClose?: () => void;
}

const MAX_POPUP_HEIGHT = 288;
const MIN_POPUP_HEIGHT = 120;

const updatePosition = (element: HTMLElement, clientRect?: (() => DOMRect | null) | null) => {
  const rect = clientRect?.();
  if (!rect) {
    element.style.opacity = '0';
    element.style.pointerEvents = 'none';
    return;
  }

  const horizontalMargin = 12;
  const verticalGap = 10;
  const verticalMargin = 12;
  const maxWidth = Math.min(320, window.innerWidth - horizontalMargin * 2);
  element.style.width = `${maxWidth}px`;
  element.style.maxWidth = `${maxWidth}px`;

  const listElement = element.firstElementChild as HTMLElement | null;
  const availableBelow = Math.max(MIN_POPUP_HEIGHT, window.innerHeight - rect.bottom - verticalGap - verticalMargin);
  const availableAbove = Math.max(MIN_POPUP_HEIGHT, rect.top - verticalGap - verticalMargin);
  const placeBelow = availableBelow >= availableAbove;
  const availableHeight = Math.min(MAX_POPUP_HEIGHT, placeBelow ? availableBelow : availableAbove);
  if (listElement) {
    listElement.style.maxHeight = `${availableHeight}px`;
  }

  const popupWidth = element.offsetWidth || maxWidth;
  const popupHeight = element.offsetHeight || 0;
  const top = placeBelow
    ? Math.min(rect.bottom + verticalGap, window.innerHeight - popupHeight - verticalMargin)
    : Math.max(verticalMargin, rect.top - popupHeight - verticalGap);
  const left = Math.min(
    Math.max(horizontalMargin, rect.left),
    Math.max(horizontalMargin, window.innerWidth - popupWidth - horizontalMargin),
  );

  element.style.opacity = '1';
  element.style.pointerEvents = 'auto';
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
};

export const createSuggestionRenderer = <TItem>({
  editor,
  emptyText,
  getItemView,
  onOpen,
  onClose,
}: CreateSuggestionRendererOptions<TItem>) => {
  const storage = editor.storage as unknown as Record<string, unknown>;
  let element: HTMLDivElement | null = null;
  let currentProps: SuggestionProps<TItem, TItem> | null = null;

  const syncActiveItemIntoView = () => {
    if (!element) {
      return;
    }

    const activeIndex = Number(storage.__composerSelectedIndex ?? 0);
    const activeButton = element.querySelector<HTMLButtonElement>(`button[data-index="${activeIndex}"]`);
    activeButton?.scrollIntoView({ block: 'nearest' });
  };

  const renderItems = (props: SuggestionProps<TItem, TItem>) => {
    if (!element) {
      return;
    }

    const activeIndex = Number(storage.__composerSelectedIndex ?? 0);
    const markup = props.items.length === 0
      ? `<div class="px-4 py-3 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">${emptyText}</div>`
      : props.items.map((item, index) => {
        const view = getItemView(item);
        const activeClass = index === activeIndex
          ? 'dark:bg-claude-accent/10 bg-claude-accent/10'
          : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover';
        return `
          <button type="button" data-index="${index}" class="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors ${activeClass}">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium dark:text-claude-darkText text-claude-text">${view.title}</span>
                ${view.badge ? `<span class="rounded-full bg-claude-accent/10 px-2 py-0.5 text-[11px] font-medium text-claude-accent">${view.badge}</span>` : ''}
              </div>
              ${view.subtitle ? `<div class="mt-0.5 truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">${view.subtitle}</div>` : ''}
            </div>
          </button>
        `;
      }).join('');

    element.innerHTML = `<div class="overflow-y-auto py-1">${markup}</div>`;
    updatePosition(element, props.clientRect);
    Array.from(element.querySelectorAll<HTMLButtonElement>('button[data-index]')).forEach((button) => {
      button.onclick = () => {
        const index = Number(button.dataset.index);
        const item = props.items[index];
        if (item) {
          props.command(item);
        }
      };
    });
    syncActiveItemIntoView();
  };

  const destroy = () => {
    if (element) {
      element.remove();
      element = null;
    }
    currentProps = null;
    onClose?.();
  };

  return {
    onStart: (props: SuggestionProps<TItem, TItem>) => {
      currentProps = props;
      storage.__composerSelectedIndex = 0;
      element = document.createElement('div');
      element.className = 'fixed z-[120] overflow-hidden rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl';
      document.body.appendChild(element);
      onOpen?.();
      renderItems(props);
    },
    onUpdate: (props: SuggestionProps<TItem, TItem>) => {
      currentProps = props;
      renderItems(props);
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      if (!currentProps) {
        return false;
      }

      const itemCount = currentProps.items.length;
      const currentIndex = Number(storage.__composerSelectedIndex ?? 0);

      if (event.key === 'ArrowDown' && itemCount > 0) {
        event.preventDefault();
        storage.__composerSelectedIndex = (currentIndex + 1) % itemCount;
        renderItems(currentProps);
        return true;
      }

      if (event.key === 'ArrowUp' && itemCount > 0) {
        event.preventDefault();
        storage.__composerSelectedIndex = (currentIndex - 1 + itemCount) % itemCount;
        renderItems(currentProps);
        return true;
      }

      if ((event.key === 'Enter' || event.key === 'Tab') && itemCount > 0) {
        event.preventDefault();
        currentProps.command(currentProps.items[currentIndex]);
        return true;
      }

      return false;
    },
    onExit: destroy,
  };
};
