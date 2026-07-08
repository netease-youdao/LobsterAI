import { CheckIcon, ChevronDownIcon, ChevronRightIcon, LockClosedIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { ProviderName } from '@shared/providers';
import React from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { getProviderIcon, ProviderIconId } from '../providers/uiRegistry';
import { authService } from '../services/auth';
import { i18nService } from '../services/i18n';
import { RootState } from '../store';
import type { Model } from '../store/slices/modelSlice';
import { getModelIdentityKey, isSameModelIdentity, setSelectedModel } from '../store/slices/modelSlice';
import Modal from './common/Modal';

interface ModelSelectorProps {
  dropdownDirection?: 'up' | 'down' | 'auto';
  /**
   * Controlled mode: the currently selected Model (or `null` for "default").
   * When provided, the component does NOT read/write Redux global state.
   */
  value?: Model | null;
  /** Controlled mode callback. `null` means the user picked "default". */
  onChange?: (model: Model | null, meta: ModelSelectorChangeMeta) => void;
  /** Show a "default" option at the top of the dropdown (controlled mode only). */
  defaultLabel?: string;
  /** Disable interaction while the selected model is being persisted. */
  disabled?: boolean;
  /** Use a denser trigger for compact toolbars. */
  compact?: boolean;
  /** Render the dropdown outside the local stacking context. */
  portal?: boolean;
  /** Align the dropdown's trailing edge with the trigger's trailing edge. */
  alignDropdownToTriggerEnd?: boolean;
  /** Override the trigger's max width while keeping the default selector behavior. */
  triggerMaxWidthClassName?: string;
}

const DROPDOWN_MAX_HEIGHT = 380; // list max-h-72 plus the tab area and current-model footer
const DROPDOWN_WIDTH = 300;
const MODEL_ITEM_HEIGHT = 36; // px-3 py-2 row with a 20px line
const LIST_VERTICAL_PADDING = 8; // scroll container py-1
const LIST_MAX_HEIGHT = 288; // matches max-h-72
const DROPDOWN_VIEWPORT_MARGIN = 8;
const HOVER_CARD_WIDTH = 220;
const HOVER_CARD_GAP = 8;
const HOVER_CARD_VIEWPORT_MARGIN = 8;
const MODEL_ICON_CLASS_NAME = 'h-[18px] w-[18px]';
export const ModelSelectorGroup = {
  Server: 'server',
  User: 'user',
} as const;
type ModelSelectorGroup = typeof ModelSelectorGroup[keyof typeof ModelSelectorGroup];

export interface ModelSelectorChangeMeta {
  group: ModelSelectorGroup;
}

export const ModelAccessPromptKind = {
  Login: 'login',
  Subscribe: 'subscribe',
} as const;
export type ModelAccessPromptKind = typeof ModelAccessPromptKind[keyof typeof ModelAccessPromptKind];

interface ModelAccessPromptModalProps {
  promptKind: ModelAccessPromptKind;
  onClose: () => void;
  titleKey?: string;
  descriptionKey?: string;
  primaryButtonKey?: string;
  showLearnMore?: boolean;
}

export const ModelAccessPromptModal: React.FC<ModelAccessPromptModalProps> = ({
  promptKind,
  onClose,
  titleKey,
  descriptionKey,
  primaryButtonKey,
  showLearnMore = true,
}) => {
  const loginPrompt = promptKind === ModelAccessPromptKind.Login;
  const resolvedTitleKey = titleKey ?? (loginPrompt ? 'modelSelectorLoginTitle' : 'modelSelectorSubscribeTitle');
  const resolvedDescriptionKey = descriptionKey ?? (loginPrompt ? 'modelSelectorLoginDesc' : 'modelSelectorSubscribeDesc');
  const resolvedPrimaryButtonKey = primaryButtonKey ?? (loginPrompt ? 'modelSelectorLoginBtn' : 'modelSelectorSubscribeBtn');

  const openSubscriptionPage = async () => {
    onClose();
    const { getPortalPricingUrl } = await import('../services/endpoints');
    await window.electron.shell.openExternal(getPortalPricingUrl());
  };

  const handlePrimary = async () => {
    if (promptKind === ModelAccessPromptKind.Login) {
      onClose();
      await authService.login();
      return;
    }
    await openSubscriptionPage();
  };

  return (
    <Modal
      onClose={onClose}
      overlayClassName="fixed inset-0 z-[10050] flex items-center justify-center modal-backdrop px-4"
      className="modal-content w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-modal"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-base font-semibold leading-6 text-foreground">
            {i18nService.t(resolvedTitleKey)}
          </div>
          <div className="mt-1.5 text-sm leading-5 text-secondary">
            {i18nService.t(resolvedDescriptionKey)}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 -mt-1 rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
          aria-label={i18nService.t('close')}
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>
      <button
        type="button"
        onClick={() => { void handlePrimary(); }}
        className="mt-5 w-full rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
      >
        {i18nService.t(resolvedPrimaryButtonKey)}
      </button>
      {loginPrompt && showLearnMore && (
        <button
          type="button"
          onClick={() => { void openSubscriptionPage(); }}
          className="mt-3 w-full text-center text-sm text-secondary transition-colors hover:text-foreground"
        >
          {i18nService.t('modelSelectorLearnMore')}
        </button>
      )}
    </Modal>
  );
};

export function resolveHoverCardTop(
  desiredTop: number,
  cardHeight: number,
  viewportHeight: number,
  viewportMargin = HOVER_CARD_VIEWPORT_MARGIN,
): number {
  const maxTop = Math.max(viewportMargin, viewportHeight - cardHeight - viewportMargin);
  return Math.min(Math.max(desiredTop, viewportMargin), maxTop);
}

const MODEL_ICON_PROVIDER_HINTS: Array<{ pattern: RegExp; providerName: ProviderName | ProviderIconId }> = [
  { pattern: /doubao|豆包/i, providerName: ProviderIconId.Doubao },
  { pattern: /deepseek/i, providerName: ProviderName.DeepSeek },
  { pattern: /minimax/i, providerName: ProviderName.Minimax },
  { pattern: /kimi|moonshot/i, providerName: ProviderName.Moonshot },
  { pattern: /glm|zhipu/i, providerName: ProviderName.Zhipu },
  { pattern: /qwen|qwq|qvq/i, providerName: ProviderName.Qwen },
  { pattern: /claude|anthropic/i, providerName: ProviderName.Anthropic },
  { pattern: /gemini/i, providerName: ProviderName.Gemini },
  { pattern: /gpt|openai/i, providerName: ProviderName.OpenAI },
  { pattern: /hy3|youdao/i, providerName: ProviderName.Youdaozhiyun },
];

const ModelSelector: React.FC<ModelSelectorProps> = ({
  dropdownDirection = 'auto',
  value,
  onChange,
  defaultLabel,
  disabled = false,
  compact = false,
  portal = false,
  alignDropdownToTriggerEnd = false,
  triggerMaxWidthClassName,
}) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  const [resolvedDirection, setResolvedDirection] = React.useState<'up' | 'down'>('down');
  const [portalStyle, setPortalStyle] = React.useState<React.CSSProperties>({});
  const [activeGroup, setActiveGroup] = React.useState<ModelSelectorGroup>(ModelSelectorGroup.Server);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const selectedItemRef = React.useRef<HTMLButtonElement>(null);
  const [hoveredModel, setHoveredModel] = React.useState<Model | null>(null);
  const [hoverCardStyle, setHoverCardStyle] = React.useState<React.CSSProperties>({});
  const [restrictedPrompt, setRestrictedPrompt] = React.useState<ModelAccessPromptKind | null>(null);
  const hoverCardRef = React.useRef<HTMLDivElement>(null);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const controlled = onChange !== undefined;
  const globalSelectedModel = useSelector((state: RootState) => state.model.defaultSelectedModel);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const selectedModel = controlled ? value ?? null : globalSelectedModel;
  const selectedModelKey = selectedModel ? getModelIdentityKey(selectedModel) : '';
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const serverModels = availableModels.filter(m => m.isServerModel);
  const userModels = availableModels.filter(m => !m.isServerModel);
  const modelGroups = [
    ...(serverModels.length > 0
      ? [{ key: ModelSelectorGroup.Server, label: i18nService.t('modelGroupServer') }]
      : []),
    ...(userModels.length > 0
      ? [{ key: ModelSelectorGroup.User, label: i18nService.t('modelGroupUser') }]
      : []),
  ];
  const shouldShowGroupTabs = serverModels.length > 0;
  const isGroupAvailable = (group: ModelSelectorGroup): boolean => (
    group === ModelSelectorGroup.Server ? serverModels.length > 0 : userModels.length > 0
  );
  const getModelGroup = (model: Model | null): ModelSelectorGroup | null => {
    if (!model) return null;
    return model.isServerModel ? ModelSelectorGroup.Server : ModelSelectorGroup.User;
  };
  const selectedModelGroup = getModelGroup(selectedModel);
  const getPreferredGroup = (): ModelSelectorGroup => {
    const selectedGroup = getModelGroup(selectedModel);
    if (selectedGroup && isGroupAvailable(selectedGroup)) return selectedGroup;
    return serverModels.length > 0 ? ModelSelectorGroup.Server : ModelSelectorGroup.User;
  };
  const visibleGroup = isGroupAvailable(activeGroup) ? activeGroup : getPreferredGroup();
  const visibleModels = shouldShowGroupTabs
    ? (visibleGroup === ModelSelectorGroup.Server ? serverModels : userModels)
    : availableModels;
  const accessibleModels = visibleModels.filter(m => m.accessible !== false);
  const restrictedModels = visibleModels.filter(m => m.accessible === false);
  // Keep the list height identical across tabs so switching never resizes the dropdown.
  const largestGroupRowCount = Math.max(serverModels.length, userModels.length) + (defaultLabel ? 1 : 0);
  const stableListMinHeight = shouldShowGroupTabs
    ? Math.min(largestGroupRowCount * MODEL_ITEM_HEIGHT + LIST_VERTICAL_PADDING, LIST_MAX_HEIGHT)
    : undefined;

  // 点击外部区域关闭下拉框
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideTrigger = containerRef.current?.contains(target);
      const isInsideDropdown = dropdownRef.current?.contains(target);

      if (!isInsideTrigger && !isInsideDropdown) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside, true);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
    };
  }, [isOpen]);

  const resolveDirection = React.useCallback(() => {
    if (dropdownDirection !== 'auto') return dropdownDirection;
    if (!containerRef.current) return 'down';
    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    return spaceBelow < DROPDOWN_MAX_HEIGHT && rect.top > spaceBelow ? 'up' : 'down';
  }, [dropdownDirection]);

  const updatePortalPosition = React.useCallback((direction: 'up' | 'down') => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const desiredLeft = alignDropdownToTriggerEnd
      ? rect.right - DROPDOWN_WIDTH
      : rect.left;
    const left = Math.min(
      Math.max(desiredLeft, DROPDOWN_VIEWPORT_MARGIN),
      window.innerWidth - DROPDOWN_WIDTH - DROPDOWN_VIEWPORT_MARGIN
    );
    const nextStyle: React.CSSProperties = {
      left,
      position: 'fixed',
      width: DROPDOWN_WIDTH,
      zIndex: 10000,
    };

    if (direction === 'up') {
      nextStyle.bottom = window.innerHeight - rect.top + 4;
    } else {
      nextStyle.top = rect.bottom + 4;
    }

    setPortalStyle(nextStyle);
  }, [alignDropdownToTriggerEnd]);

  React.useEffect(() => {
    if (!isOpen || !portal) return;

    const handlePositionUpdate = () => updatePortalPosition(resolvedDirection);
    window.addEventListener('resize', handlePositionUpdate);
    window.addEventListener('scroll', handlePositionUpdate, true);

    return () => {
      window.removeEventListener('resize', handlePositionUpdate);
      window.removeEventListener('scroll', handlePositionUpdate, true);
    };
  }, [isOpen, portal, resolvedDirection, updatePortalPosition]);

  React.useLayoutEffect(() => {
    if (!isOpen || !selectedModelKey) return;

    const scrollContainer = scrollContainerRef.current;
    const selectedItem = selectedItemRef.current;
    if (!scrollContainer || !selectedItem || !scrollContainer.contains(selectedItem)) return;

    const containerRect = scrollContainer.getBoundingClientRect();
    const selectedRect = selectedItem.getBoundingClientRect();
    const selectedOffsetTop = selectedRect.top - containerRect.top + scrollContainer.scrollTop;
    const targetScrollTop = selectedOffsetTop - ((scrollContainer.clientHeight - selectedItem.offsetHeight) / 2);
    const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    scrollContainer.scrollTop = Math.min(Math.max(0, targetScrollTop), maxScrollTop);
  }, [isOpen, selectedModelKey, visibleGroup, visibleModels.length]);

  const toggleOpen = () => {
    if (disabled) return;
    if (!isOpen) {
      const nextDirection = resolveDirection();
      setResolvedDirection(nextDirection);
      if (portal) {
        updatePortalPosition(nextDirection);
      }
      setActiveGroup(getPreferredGroup());
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  };

  const handleModelSelect = (model: Model | null) => {
    if (disabled) return;
    if (model && model.accessible === false) {
      setRestrictedPrompt(isLoggedIn ? ModelAccessPromptKind.Subscribe : ModelAccessPromptKind.Login);
      setHoveredModel(null);
      setIsOpen(false);
      return;
    }
    if (controlled) {
      onChange(model, { group: getModelGroup(model) ?? visibleGroup });
    } else if (model) {
      dispatch(setSelectedModel({ agentId: currentAgentId, model }));
    }
    setRestrictedPrompt(null);
    setIsOpen(false);
  };

  React.useEffect(() => {
    if (!isOpen) {
      setHoveredModel(null);
    }
  }, [isOpen]);

  React.useLayoutEffect(() => {
    if (!hoveredModel || !hoverCardRef.current) return;

    const cardRect = hoverCardRef.current.getBoundingClientRect();
    const currentTop = typeof hoverCardStyle.top === 'number'
      ? hoverCardStyle.top
      : cardRect.top;
    const nextTop = resolveHoverCardTop(currentTop, cardRect.height, window.innerHeight);

    if (Math.abs(nextTop - currentTop) < 0.5) return;
    setHoverCardStyle(style => ({ ...style, top: nextTop }));
  }, [hoveredModel, hoverCardStyle.top]);

  // 如果没有可用模型，显示提示
  if (availableModels.length === 0) {
    return (
      <div className="px-3 py-1.5 rounded-xl bg-surface text-secondary text-sm">
        {i18nService.t('modelSelectorNoModels')}
      </div>
    );
  }

  const dropdownPositionClass = resolvedDirection === 'up'
    ? 'bottom-full mb-1'
    : 'top-full mt-1';
  const dropdownAlignmentClass = alignDropdownToTriggerEnd ? 'right-0' : 'left-0';

  const isSelected = (model: Model): boolean => {
    if (!selectedModel) return false;
    return isSameModelIdentity(model, selectedModel);
  };
  const resolveModelIconProviderKey = (model: Model): string => {
    const providerKey = model.providerKey?.trim();
    if (providerKey && providerKey !== ProviderName.LobsteraiServer) return providerKey;

    const searchableText = `${model.name} ${model.id}`;
    return MODEL_ICON_PROVIDER_HINTS.find(({ pattern }) => pattern.test(searchableText))?.providerName
      ?? providerKey
      ?? '';
  };
  const renderProviderIcon = (model: Model): React.ReactNode => {
    const icon = getProviderIcon(resolveModelIconProviderKey(model));
    if (!React.isValidElement<{ className?: string }>(icon)) return icon;

    const existingClassName = icon.props.className ? `${icon.props.className} ` : '';
    return React.cloneElement(icon, {
      className: `${existingClassName}${MODEL_ICON_CLASS_NAME}`,
    });
  };
  const triggerMaxWidthClass = triggerMaxWidthClassName ?? (compact ? 'max-w-[220px]' : 'max-w-[280px]');
  const triggerClassName = compact
    ? `space-x-1.5 px-2 py-1 rounded-lg ${triggerMaxWidthClass}`
    : `space-x-2 px-3 py-1.5 rounded-xl ${triggerMaxWidthClass}`;
  const triggerTextClassName = compact
    ? 'font-normal text-[13px] leading-5'
    : 'font-medium text-sm';
  const triggerIconClassName = compact ? 'h-3.5 w-3.5' : 'h-4 w-4';

  const handleModelHover = (model: Model, event: React.MouseEvent<HTMLButtonElement>) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const itemRect = event.currentTarget.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(() => {
      if (!model.description && !model.costMultiplier && !model.supportsImage && !model.supportsThinking) {
        setHoveredModel(null);
        return;
      }
      const dropdownEl = dropdownRef.current;
      if (!dropdownEl) return;
      const dropdownRect = dropdownEl.getBoundingClientRect();
      const spaceRight = window.innerWidth - dropdownRect.right;
      const style: React.CSSProperties = {
        position: 'fixed',
        top: itemRect.top,
        zIndex: 10001,
      };
      if (spaceRight >= HOVER_CARD_WIDTH + HOVER_CARD_GAP) {
        style.left = dropdownRect.right + HOVER_CARD_GAP;
      } else {
        style.right = window.innerWidth - dropdownRect.left + HOVER_CARD_GAP;
      }
      setHoverCardStyle(style);
      setHoveredModel(model);
    }, 200);
  };

  const handleModelHoverEnd = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredModel(null);
  };

  const renderModelItem = (model: Model) => {
    const selected = isSelected(model);
    const restricted = model.accessible === false;

    return (
      <button
        ref={selected ? selectedItemRef : undefined}
        type="button"
        key={getModelIdentityKey(model)}
        onClick={() => handleModelSelect(model)}
        onMouseEnter={(e) => handleModelHover(model, e)}
        onMouseLeave={handleModelHoverEnd}
        aria-disabled={restricted}
        className={`w-full px-3 py-2 text-left dark:text-claude-darkText text-claude-text flex items-center gap-2.5 transition-colors ${
          restricted
            ? 'cursor-pointer opacity-60 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
            : selected
              ? 'bg-primary/10 dark:bg-primary/15'
              : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
        }`}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-secondary">
          {renderProviderIcon(model)}
        </span>
        <span className={`min-w-0 truncate text-[13px] leading-5 ${selected ? 'font-medium' : 'font-normal'}`}>
          {model.name}
        </span>
        {model.costMultiplier != null && model.costMultiplier > 0 && (
          <span className="shrink-0 text-[11px] text-secondary whitespace-nowrap">
            x{model.costMultiplier} {i18nService.t('authCreditsUnit')}
          </span>
        )}
        <span className="flex-1" />
        {model.supportsImage && (
          <span className="shrink-0 rounded-md bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium leading-none text-secondary">
            {i18nService.t('modelSupportsImageInputBadge')}
          </span>
        )}
        {restricted && (
          <LockClosedIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
        )}
        {selected && !restricted && (
          <CheckIcon className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.5} />
        )}
      </button>
    );
  };

  const renderHoverCard = () => {
    if (!hoveredModel) return null;
    const card = (
      <div ref={hoverCardRef} style={hoverCardStyle} className="w-[220px] rounded-xl border border-border bg-surface shadow-popover p-3 pointer-events-none">
        <div className="text-[13px] font-semibold text-foreground leading-5">{hoveredModel.name}</div>
        {hoveredModel.description && (
          <div className="mt-1 text-[11px] text-secondary leading-4">{hoveredModel.description}</div>
        )}
        {hoveredModel.costMultiplier != null && hoveredModel.costMultiplier > 0 && (
          <div className="mt-2 text-[11px] text-secondary">
            ({i18nService.t('modelCostMultiplierLabel')} x{hoveredModel.costMultiplier})
          </div>
        )}
        {(hoveredModel.supportsImage || hoveredModel.supportsThinking) && (
          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-emerald-600">
            {hoveredModel.supportsImage && (
              <span className="flex items-center gap-1">
                <span>✓</span>
                <span>{i18nService.t('modelSupportsImageInputBadge')}</span>
              </span>
            )}
            {hoveredModel.supportsThinking && (
              <span className="flex items-center gap-1">
                <span>✓</span>
                <span>{i18nService.t('modelSupportsThinkingBadge')}</span>
              </span>
            )}
          </div>
        )}
      </div>
    );
    return createPortal(card, document.body);
  };

  const renderGroupTabs = () => (
    <div className="border-b border-border/60 p-2">
      <div className="flex rounded-lg bg-surface-raised p-0.5" role="tablist" aria-label={i18nService.t('model')}>
        {modelGroups.map(group => {
          const active = visibleGroup === group.key;
          return (
            <button
              type="button"
              key={group.key}
              role="tab"
              aria-selected={active}
              onClick={() => setActiveGroup(group.key)}
              className={`flex min-w-0 flex-1 items-center justify-center rounded-md px-2 py-1.5 text-[12px] leading-4 transition-colors ${
                active
                  ? 'bg-surface font-semibold text-foreground shadow-sm'
                  : 'font-medium text-secondary hover:text-foreground'
              }`}
            >
              <span className="truncate">{group.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const renderCurrentModelFooter = () => {
    if (!shouldShowGroupTabs || !selectedModel || !selectedModelGroup) return null;
    const inOtherGroup = selectedModelGroup !== visibleGroup;
    return (
      <button
        type="button"
        onClick={() => setActiveGroup(selectedModelGroup)}
        className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-2 text-left transition-colors hover:bg-surface-raised"
      >
        <span className="shrink-0 text-[11px] leading-4 text-secondary">
          {i18nService.t('modelSelectorCurrentModel')}
        </span>
        <span className="min-w-0 truncate text-[12px] font-medium leading-4 text-foreground">
          {selectedModel.name}
        </span>
        {inOtherGroup && <ChevronRightIcon className="ml-auto h-3 w-3 shrink-0 text-secondary" />}
      </button>
    );
  };

  const renderRestrictedPrompt = () => {
    if (!restrictedPrompt) return null;
    return (
      <ModelAccessPromptModal
        promptKind={restrictedPrompt}
        onClose={() => setRestrictedPrompt(null)}
      />
    );
  };

  const dropdown = isOpen ? (
    <div
      ref={dropdownRef}
      style={portal ? portalStyle : undefined}
      className={`${portal ? '' : `absolute ${dropdownPositionClass} ${dropdownAlignmentClass}`} w-[300px] bg-surface rounded-xl popover-enter shadow-popover z-50 border-border border overflow-hidden`}
    >
      {shouldShowGroupTabs && renderGroupTabs()}
      <div
        ref={scrollContainerRef}
        style={stableListMinHeight !== undefined ? { minHeight: stableListMinHeight } : undefined}
        className="model-selector-scroll max-h-72 overflow-y-auto py-1"
      >
        {defaultLabel && (
          <button
            type="button"
            onClick={() => handleModelSelect(null)}
            className={`w-full px-3 py-2 text-left dark:text-claude-darkText text-claude-text flex items-center justify-between gap-2 transition-colors ${
              !selectedModel
                ? 'bg-primary/10 dark:bg-primary/15'
                : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
            }`}
          >
            <span className={`truncate text-[13px] leading-5 ${!selectedModel ? 'font-medium' : 'font-normal'}`}>{defaultLabel}</span>
            {!selectedModel && <CheckIcon className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.5} />}
          </button>
        )}
        {accessibleModels.map(renderModelItem)}
        {restrictedModels.length > 0 && (
          <div>
            {restrictedModels.map(renderModelItem)}
          </div>
        )}
      </div>
      {renderCurrentModelFooter()}
    </div>
  ) : null;

  return (
    <div ref={containerRef} className={`relative ${disabled ? 'cursor-wait' : 'cursor-pointer'}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={toggleOpen}
        className={`flex min-w-0 items-center overflow-hidden hover:bg-surface-raised text-foreground transition-colors disabled:opacity-70 disabled:cursor-wait ${triggerClassName} ${isOpen ? 'bg-surface-raised' : ''}`}
      >
        {selectedModel?.isServerModel && (
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-secondary">
            {renderProviderIcon(selectedModel)}
          </span>
        )}
        <span className={`${triggerTextClassName} min-w-0 truncate`}>{selectedModel?.name ?? defaultLabel ?? ''}</span>
        <ChevronDownIcon className={`${triggerIconClassName} shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary`} />
      </button>

      {portal && dropdown ? createPortal(dropdown, document.body) : dropdown}
      {renderHoverCard()}
      {renderRestrictedPrompt()}
    </div>
  );
};

export default ModelSelector;
