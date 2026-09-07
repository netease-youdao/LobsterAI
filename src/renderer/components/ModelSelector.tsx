import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  LockClosedIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  getModelThinkingLevels,
  ModelRuntimeProfile,
  type ModelThinkingConfig,
  type ModelThinkingLevel as ModelThinkingLevelType,
  ProviderName,
  supportsLobsterAIRequestOptionsV1,
} from '@shared/providers';
import React from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { getProviderIcon, ProviderIconId } from '../providers/uiRegistry';
import { authService } from '../services/auth';
import { i18nService } from '../services/i18n';
import {
  readRememberedModelThinkingLevel,
  rememberModelThinkingLevel,
} from '../services/modelThinkingLevelMemory';
import { RootState } from '../store';
import type { Model } from '../store/slices/modelSlice';
import { getModelIdentityKey, isSameModelIdentity, setSelectedModel } from '../store/slices/modelSlice';
import Modal from './common/Modal';
import ModelThinkingMenu, {
  getModelThinkingLevelLabel,
} from './modelSelector/ModelThinkingMenu';

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
  /** Persisted thinking level for the selected model. Omit to hide the thinking control. */
  thinkingLevel?: ModelThinkingLevelType | null;
}

const DROPDOWN_MAX_HEIGHT = 380; // list max-h-72 plus the tab area and current-model footer
const DROPDOWN_WIDTH = 300;
const MODEL_ITEM_HEIGHT = 36; // px-3 py-2 row with a 20px line
const LIST_VERTICAL_PADDING = 8; // scroll container py-1
const LIST_MAX_HEIGHT = 288; // default cap for the scrollable model list (18rem)
const LIST_MIN_HEIGHT = MODEL_ITEM_HEIGHT * 3 + LIST_VERTICAL_PADDING; // never collapse below three rows
const DROPDOWN_VIEWPORT_MARGIN = 8;
const DROPDOWN_TRIGGER_GAP = 4; // matches mt-1/mb-1 and the +4 offset in portal mode
const DROPDOWN_TABS_BLOCK_HEIGHT = 49; // group tabs block: p-2 + p-0.5 + py-1.5 + leading-4 + border-b
const DROPDOWN_FOOTER_HEIGHT = 33; // current-model footer: py-2 + leading-4 + border-t
const DROPDOWN_BORDER_HEIGHT = 2;
const HOVER_CARD_WIDTH = 220;
const HOVER_CARD_VIEWPORT_MARGIN = 8;
const HOVER_CLOSE_DELAY = 180;
const THINKING_MENU_WIDTH = 210;
// Cascaded popovers sit flush against their anchor: no gap that makes the stack
// look disconnected, and no overlap that makes the panels look stacked.
const CASCADE_OVERLAP = 0;
const MODEL_ICON_CLASS_NAME = 'h-[18px] w-[18px]';
export const CascadeSide = {
  Left: 'left',
  Right: 'right',
} as const;
export type CascadeSide = typeof CascadeSide[keyof typeof CascadeSide];
export const ModelSelectorGroup = {
  Server: 'server',
  User: 'user',
} as const;
type ModelSelectorGroup = typeof ModelSelectorGroup[keyof typeof ModelSelectorGroup];

export interface ModelSelectorSections {
  primaryModels: Model[];
  moreModels: Model[];
}

export const partitionModelSelectorModels = (models: Model[]): ModelSelectorSections => ({
  primaryModels: models.filter(model => model.moreModel !== true),
  moreModels: models.filter(model => model.moreModel === true),
});

export const countVisibleModelSelectorRows = (
  models: Model[],
  moreModelsExpanded: boolean,
): number => {
  const sections = partitionModelSelectorModels(models);
  return sections.primaryModels.length
    + (sections.moreModels.length > 0 ? 1 : 0)
    + (moreModelsExpanded ? sections.moreModels.length : 0);
};

export const shouldRenderSelectedModelUnavailableFallback = (
  availableModelCount: number,
  selectedModel: Model | null | undefined,
  isLoggedIn: boolean,
): selectedModel is Model & { isServerModel: true } => (
  isLoggedIn
  && availableModelCount === 0
  && selectedModel?.isServerModel === true
);

export interface ModelSelectorChangeMeta {
  group: ModelSelectorGroup;
  thinkingLevel?: ModelThinkingLevelType;
}

export const ModelAccessPromptKind = {
  AgenticNotReady: 'agentic_not_ready',
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
  const agenticNotReadyPrompt = promptKind === ModelAccessPromptKind.AgenticNotReady;
  const loginPrompt = promptKind === ModelAccessPromptKind.Login;
  const resolvedTitleKey = titleKey ?? (
    agenticNotReadyPrompt
      ? 'modelSelectorAgenticNotReadyTitle'
      : loginPrompt ? 'modelSelectorLoginTitle' : 'modelSelectorSubscribeTitle'
  );
  const resolvedDescriptionKey = descriptionKey ?? (
    agenticNotReadyPrompt
      ? 'serverModelAgenticNotReady'
      : loginPrompt ? 'modelSelectorLoginDesc' : 'modelSelectorSubscribeDesc'
  );
  const resolvedPrimaryButtonKey = primaryButtonKey ?? (
    agenticNotReadyPrompt
      ? 'modelSelectorAgenticNotReadyBtn'
      : loginPrompt ? 'modelSelectorLoginBtn' : 'modelSelectorSubscribeBtn'
  );

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
    if (promptKind === ModelAccessPromptKind.AgenticNotReady) {
      onClose();
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

export function resolveDropdownListMaxHeight(
  availableSpace: number,
  hasGroupTabs: boolean,
  hasCurrentModelFooter: boolean,
): number {
  const chromeHeight = DROPDOWN_BORDER_HEIGHT
    + (hasGroupTabs ? DROPDOWN_TABS_BLOCK_HEIGHT : 0)
    + (hasCurrentModelFooter ? DROPDOWN_FOOTER_HEIGHT : 0);
  return Math.min(Math.max(availableSpace - chromeHeight, LIST_MIN_HEIGHT), LIST_MAX_HEIGHT);
}

export function resolveHoverCardTop(
  desiredTop: number,
  cardHeight: number,
  viewportHeight: number,
  viewportMargin = HOVER_CARD_VIEWPORT_MARGIN,
): number {
  const maxTop = Math.max(viewportMargin, viewportHeight - cardHeight - viewportMargin);
  return Math.min(Math.max(desiredTop, viewportMargin), maxTop);
}

/**
 * Places a cascaded popover (hover card, thinking menu) next to its anchor.
 * The popover keeps flowing towards `preferredSide` so the stack never
 * zig-zags back across the panel it came from, and only flips when the
 * preferred side cannot fit inside the viewport.
 */
export function resolveCascadePlacement(options: {
  anchorLeft: number;
  anchorRight: number;
  width: number;
  viewportWidth: number;
  preferredSide: CascadeSide;
  overlap?: number;
  viewportMargin?: number;
}): { left: number; side: CascadeSide } {
  const {
    anchorLeft,
    anchorRight,
    width,
    viewportWidth,
    preferredSide,
    overlap = CASCADE_OVERLAP,
    viewportMargin = HOVER_CARD_VIEWPORT_MARGIN,
  } = options;
  const rightSideLeft = anchorRight - overlap;
  const leftSideLeft = anchorLeft + overlap - width;
  const fitsRight = rightSideLeft + width + viewportMargin <= viewportWidth;
  const fitsLeft = leftSideLeft >= viewportMargin;
  const side = preferredSide === CascadeSide.Right
    ? (fitsRight || !fitsLeft ? CascadeSide.Right : CascadeSide.Left)
    : (fitsLeft || !fitsRight ? CascadeSide.Left : CascadeSide.Right);
  const desiredLeft = side === CascadeSide.Right ? rightSideLeft : leftSideLeft;
  const maxLeft = Math.max(viewportMargin, viewportWidth - width - viewportMargin);
  return { left: Math.min(Math.max(desiredLeft, viewportMargin), maxLeft), side };
}

/**
 * A third cascaded panel must not flip inward across its parent and cover the
 * model dropdown. When the outward side is exhausted (notably at the 800px
 * minimum window width), overlay the hover card itself instead; its 220px
 * surface is wider than the 210px thinking menu and remains pointer-adjacent.
 */
export function resolveNestedCascadePlacement(options: Parameters<typeof resolveCascadePlacement>[0]): {
  left: number;
  side: CascadeSide;
  overlaysAnchor: boolean;
} {
  const placement = resolveCascadePlacement(options);
  if (placement.side === options.preferredSide) {
    return { ...placement, overlaysAnchor: false };
  }

  const viewportMargin = options.viewportMargin ?? HOVER_CARD_VIEWPORT_MARGIN;
  const maxLeft = Math.max(viewportMargin, options.viewportWidth - options.width - viewportMargin);
  return {
    left: Math.min(Math.max(options.anchorLeft, viewportMargin), maxLeft),
    side: options.preferredSide,
    overlaysAnchor: true,
  };
}

/**
 * Thinking level the picker should show for one model, in precedence order:
 *
 * 1. the level being requested right now (the user just clicked it);
 * 2. the level persisted for the agent/session, but only for the model that is
 *    actually selected — that record holds a single level, so it says nothing
 *    about the other models in the list;
 * 3. the level the user last picked for this specific model;
 * 4. the model's built-in default.
 *
 * Step 3 is what keeps two models from sharing one level: without it, every
 * model except the selected one falls back to its default, so switching models
 * silently discards the level chosen for the previous one.
 */
export function resolvePickerThinkingLevel(options: {
  config: ModelThinkingConfig;
  requestedLevel?: ModelThinkingLevelType;
  selectedModelLevel?: ModelThinkingLevelType | null;
  rememberedLevel?: ModelThinkingLevelType;
}): ModelThinkingLevelType {
  const { config, requestedLevel, selectedModelLevel, rememberedLevel } = options;
  const levels = getModelThinkingLevels(config);
  const candidates = [requestedLevel, selectedModelLevel, rememberedLevel];
  return candidates.find(
    (level): level is ModelThinkingLevelType => !!level && levels.includes(level),
  ) ?? config.defaultLevel;
}

export function isModelAgenticBlocked(
  model: Pick<Model, 'agenticReady' | 'isServerModel' | 'runtimeProfile'> | null | undefined,
): boolean {
  return model?.isServerModel === true
    && model.runtimeProfile === ModelRuntimeProfile.MoonshotKimiK3
    && model.agenticReady !== true;
}

export function canConfigureModelThinking(
  model: Pick<
    Model,
    | 'accessible'
    | 'agenticReady'
    | 'isServerModel'
    | 'requestCapabilities'
    | 'runtimeProfile'
    | 'thinkingConfig'
  > | null | undefined,
): boolean {
  return !!model?.thinkingConfig
    && supportsLobsterAIRequestOptionsV1(model.requestCapabilities)
    && model.accessible !== false
    && !isModelAgenticBlocked(model);
}

export function supportsConfigurableModelThinkingProtocol(
  model: Pick<Model, 'requestCapabilities' | 'thinkingConfig'> | null | undefined,
): boolean {
  return !!model?.thinkingConfig
    && supportsLobsterAIRequestOptionsV1(model.requestCapabilities);
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
  thinkingLevel,
}) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = React.useState(false);
  const [resolvedDirection, setResolvedDirection] = React.useState<'up' | 'down'>('down');
  const [portalStyle, setPortalStyle] = React.useState<React.CSSProperties>({});
  const [listMaxHeight, setListMaxHeight] = React.useState<number>(LIST_MAX_HEIGHT);
  const [activeGroup, setActiveGroup] = React.useState<ModelSelectorGroup>(ModelSelectorGroup.Server);
  const [moreModelsExpanded, setMoreModelsExpanded] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const selectedItemRef = React.useRef<HTMLButtonElement>(null);
  const moreModelsSectionRef = React.useRef<HTMLDivElement>(null);
  const revealMoreModelsOnExpandRef = React.useRef(false);
  const [hoveredModel, setHoveredModel] = React.useState<Model | null>(null);
  const [hoverCardStyle, setHoverCardStyle] = React.useState<React.CSSProperties>({});
  const [hoverCardSide, setHoverCardSide] = React.useState<CascadeSide>(CascadeSide.Right);
  const [isThinkingMenuOpen, setIsThinkingMenuOpen] = React.useState(false);
  const [thinkingMenuStyle, setThinkingMenuStyle] = React.useState<React.CSSProperties>({});
  const [restrictedPrompt, setRestrictedPrompt] = React.useState<ModelAccessPromptKind | null>(null);
  const hoverCardRef = React.useRef<HTMLDivElement>(null);
  const thinkingMenuRef = React.useRef<HTMLDivElement>(null);
  const thinkingMenuTriggerRef = React.useRef<HTMLButtonElement>(null);
  const hoverTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const controlled = onChange !== undefined;
  const thinkingSelectionEnabled = controlled && thinkingLevel !== undefined;
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
  const showCurrentModelFooter = shouldShowGroupTabs && selectedModel !== null && selectedModelGroup !== null;
  const getPreferredGroup = (): ModelSelectorGroup => {
    const selectedGroup = getModelGroup(selectedModel);
    if (selectedGroup && isGroupAvailable(selectedGroup)) return selectedGroup;
    return serverModels.length > 0 ? ModelSelectorGroup.Server : ModelSelectorGroup.User;
  };
  const visibleGroup = isGroupAvailable(activeGroup) ? activeGroup : getPreferredGroup();
  const visibleModels = shouldShowGroupTabs
    ? (visibleGroup === ModelSelectorGroup.Server ? serverModels : userModels)
    : availableModels;
  const visibleSections = partitionModelSelectorModels(visibleModels);
  // Keep the list height identical across tabs so switching never resizes the dropdown.
  const largestGroupRowCount = Math.max(
    countVisibleModelSelectorRows(serverModels, moreModelsExpanded),
    countVisibleModelSelectorRows(userModels, moreModelsExpanded),
  ) + (defaultLabel ? 1 : 0);
  const stableListMinHeight = shouldShowGroupTabs
    ? Math.min(largestGroupRowCount * MODEL_ITEM_HEIGHT + LIST_VERTICAL_PADDING, LIST_MAX_HEIGHT)
    : undefined;
  const showSelectedModelUnavailableFallback = shouldRenderSelectedModelUnavailableFallback(
    availableModels.length,
    selectedModel,
    isLoggedIn,
  );
  const selectedModelUnavailableFallbackLogKey = showSelectedModelUnavailableFallback
    ? `${selectedModel.providerKey ?? ''}:${selectedModel.id}`
    : '';
  const selectedModelUnavailableFallbackLogKeyRef = React.useRef('');
  const triggerMaxWidthClass = triggerMaxWidthClassName ?? (compact ? 'max-w-[220px]' : 'max-w-[280px]');
  const triggerClassName = compact
    ? `space-x-1.5 px-2 py-1 rounded-lg ${triggerMaxWidthClass}`
    : `space-x-2 px-3 py-1.5 rounded-xl ${triggerMaxWidthClass}`;
  const triggerTextClassName = compact
    ? 'font-normal text-[13px] leading-5'
    : 'font-medium text-sm';
  const triggerIconClassName = compact ? 'h-3.5 w-3.5' : 'h-4 w-4';
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

  // 点击外部区域关闭下拉框
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideTrigger = containerRef.current?.contains(target);
      const isInsideDropdown = dropdownRef.current?.contains(target);
      const isInsideHoverCard = hoverCardRef.current?.contains(target);
      const isInsideThinkingMenu = thinkingMenuRef.current?.contains(target);

      if (!isInsideTrigger && !isInsideDropdown && !isInsideHoverCard && !isInsideThinkingMenu) {
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

  const resolveListMaxHeight = React.useCallback((direction: 'up' | 'down'): number => {
    const container = containerRef.current;
    if (!container) return LIST_MAX_HEIGHT;
    const rect = container.getBoundingClientRect();
    let topBoundary = 0;
    let bottomBoundary = window.innerHeight;
    if (!portal) {
      // The in-place dropdown is clipped by overflow ancestors (e.g. the app
      // shell below the window title bar), so clamp against them as well.
      for (let el = container.parentElement; el && el !== document.body; el = el.parentElement) {
        if (window.getComputedStyle(el).overflowY === 'visible') continue;
        const ancestorRect = el.getBoundingClientRect();
        topBoundary = Math.max(topBoundary, ancestorRect.top);
        bottomBoundary = Math.min(bottomBoundary, ancestorRect.bottom);
      }
    }
    const availableSpace = (direction === 'up'
      ? rect.top - topBoundary
      : bottomBoundary - rect.bottom) - DROPDOWN_TRIGGER_GAP - DROPDOWN_VIEWPORT_MARGIN;
    return resolveDropdownListMaxHeight(availableSpace, shouldShowGroupTabs, showCurrentModelFooter);
  }, [portal, shouldShowGroupTabs, showCurrentModelFooter]);

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
    if (!isOpen) return;

    setListMaxHeight(resolveListMaxHeight(resolvedDirection));
    const handlePositionUpdate = (event?: Event) => {
      // Scrolls inside the dropdown itself (e.g. the model list) do not move the trigger.
      if (event && event.target instanceof Node && dropdownRef.current?.contains(event.target)) return;
      if (portal) updatePortalPosition(resolvedDirection);
      setListMaxHeight(resolveListMaxHeight(resolvedDirection));
    };
    window.addEventListener('resize', handlePositionUpdate);
    window.addEventListener('scroll', handlePositionUpdate, true);

    return () => {
      window.removeEventListener('resize', handlePositionUpdate);
      window.removeEventListener('scroll', handlePositionUpdate, true);
    };
  }, [isOpen, portal, resolvedDirection, updatePortalPosition, resolveListMaxHeight]);

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
  }, [isOpen, selectedModelKey, visibleGroup, visibleModels.length, listMaxHeight]);

  React.useLayoutEffect(() => {
    if (!isOpen || !moreModelsExpanded || !revealMoreModelsOnExpandRef.current) return;

    const scrollContainer = scrollContainerRef.current;
    const moreModelsSection = moreModelsSectionRef.current;
    if (!scrollContainer || !moreModelsSection) return;
    revealMoreModelsOnExpandRef.current = false;

    const containerRect = scrollContainer.getBoundingClientRect();
    const sectionRect = moreModelsSection.getBoundingClientRect();
    const sectionTop = sectionRect.top - containerRect.top + scrollContainer.scrollTop;
    const sectionBottom = sectionTop + sectionRect.height;
    const viewportTop = scrollContainer.scrollTop;
    const viewportBottom = viewportTop + scrollContainer.clientHeight;
    if (sectionTop >= viewportTop && sectionBottom <= viewportBottom) return;

    const targetScrollTop = sectionRect.height <= scrollContainer.clientHeight
      ? sectionBottom - scrollContainer.clientHeight
      : sectionTop;
    const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
    scrollContainer.scrollTop = Math.min(Math.max(0, targetScrollTop), maxScrollTop);
  }, [isOpen, moreModelsExpanded]);

  const toggleOpen = () => {
    if (disabled) return;
    if (!isOpen) {
      const nextDirection = resolveDirection();
      setResolvedDirection(nextDirection);
      setListMaxHeight(resolveListMaxHeight(nextDirection));
      if (portal) {
        updatePortalPosition(nextDirection);
      }
      const preferredGroup = getPreferredGroup();
      setActiveGroup(preferredGroup);
      setMoreModelsExpanded(
        selectedModel?.moreModel === true && getModelGroup(selectedModel) === preferredGroup,
      );
      setIsOpen(true);
    } else {
      setIsOpen(false);
    }
  };

  const resolveThinkingLevel = (
    model: Model,
    requestedLevel?: ModelThinkingLevelType,
  ): ModelThinkingLevelType | undefined => {
    if (!canConfigureModelThinking(model)) return undefined;
    const config = model.thinkingConfig;
    if (!config) return undefined;
    return resolvePickerThinkingLevel({
      config,
      requestedLevel,
      selectedModelLevel: isSelected(model) ? thinkingLevel : undefined,
      rememberedLevel: readRememberedModelThinkingLevel(getModelIdentityKey(model)),
    });
  };

  const handleModelSelect = (model: Model | null) => {
    if (disabled) return;
    if (isModelAgenticBlocked(model)) {
      setRestrictedPrompt(ModelAccessPromptKind.AgenticNotReady);
      setHoveredModel(null);
      setIsOpen(false);
      return;
    }
    if (model && model.accessible === false) {
      setRestrictedPrompt(isLoggedIn ? ModelAccessPromptKind.Subscribe : ModelAccessPromptKind.Login);
      setHoveredModel(null);
      setIsOpen(false);
      return;
    }
    const resolvedThinkingLevel = model ? resolveThinkingLevel(model) : undefined;
    if (controlled) {
      onChange(model, {
        group: getModelGroup(model) ?? visibleGroup,
        ...(resolvedThinkingLevel ? { thinkingLevel: resolvedThinkingLevel } : {}),
      });
    } else if (model) {
      dispatch(setSelectedModel({ agentId: currentAgentId, model }));
    }
    setRestrictedPrompt(null);
    setIsThinkingMenuOpen(false);
    setHoveredModel(null);
    setIsOpen(false);
  };

  const handleThinkingLevelSelect = (
    model: Model,
    requestedThinkingLevel: ModelThinkingLevelType,
  ) => {
    if (disabled || !thinkingSelectionEnabled || !canConfigureModelThinking(model)) return;
    const resolvedThinkingLevel = resolveThinkingLevel(model, requestedThinkingLevel);
    if (!resolvedThinkingLevel) return;

    // Each model keeps its own level, so picking one here must not be lost when
    // the user switches to another model and back.
    rememberModelThinkingLevel(getModelIdentityKey(model), resolvedThinkingLevel);
    onChange(model, {
      group: getModelGroup(model) ?? visibleGroup,
      thinkingLevel: resolvedThinkingLevel,
    });
    setRestrictedPrompt(null);
  };

  React.useEffect(() => {
    if (!isOpen) {
      setHoveredModel(null);
      setIsThinkingMenuOpen(false);
    }
  }, [isOpen]);

  React.useEffect(() => {
    if (
      isOpen
      && selectedModel?.moreModel === true
      && selectedModelGroup === visibleGroup
    ) {
      setMoreModelsExpanded(true);
    }
  }, [isOpen, selectedModel?.moreModel, selectedModelGroup, visibleGroup]);

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

  React.useLayoutEffect(() => {
    if (!isThinkingMenuOpen || !thinkingMenuRef.current) return;
    const menuRect = thinkingMenuRef.current.getBoundingClientRect();
    const nextTop = resolveHoverCardTop(
      menuRect.top,
      menuRect.height,
      window.innerHeight,
    );
    if (Math.abs(nextTop - menuRect.top) < 0.5) return;
    setThinkingMenuStyle(style => ({ ...style, top: nextTop }));
  }, [isThinkingMenuOpen, thinkingMenuStyle.left]);

  React.useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isThinkingMenuOpen) {
        setIsThinkingMenuOpen(false);
      } else {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, isThinkingMenuOpen]);

  React.useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
  }, []);

  React.useEffect(() => {
    if (!showSelectedModelUnavailableFallback) {
      selectedModelUnavailableFallbackLogKeyRef.current = '';
      return;
    }
    if (selectedModelUnavailableFallbackLogKeyRef.current === selectedModelUnavailableFallbackLogKey) {
      return;
    }
    selectedModelUnavailableFallbackLogKeyRef.current = selectedModelUnavailableFallbackLogKey;
    const message = `preserving stale server model display while authenticated model list is empty: ${selectedModelUnavailableFallbackLogKey}`;
    console.debug(`[ModelSelector] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'ModelSelector', message);
    } catch {
      // Diagnostics only.
    }
  }, [
    selectedModelUnavailableFallbackLogKey,
    showSelectedModelUnavailableFallback,
  ]);

  // 如果没有可用模型，显示提示
  if (availableModels.length === 0) {
    if (showSelectedModelUnavailableFallback) {
      return (
        <div ref={containerRef} className="relative cursor-wait">
          <button
            type="button"
            disabled
            aria-disabled="true"
            className={`flex min-w-0 items-center overflow-hidden text-foreground transition-colors disabled:cursor-wait disabled:opacity-70 ${triggerClassName}`}
          >
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-secondary">
              {renderProviderIcon(selectedModel)}
            </span>
            <span className={`${triggerTextClassName} min-w-0 truncate`}>{selectedModel.name}</span>
            <ChevronDownIcon className={`${triggerIconClassName} shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary`} />
          </button>
        </div>
      );
    }

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

  const cancelHoverClose = () => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  };

  const handleModelHover = (
    model: Model,
    target: HTMLButtonElement,
    delay = 200,
  ) => {
    cancelHoverClose();
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const itemRect = target.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(() => {
      if (
        !model.description
        && !model.costMultiplier
        && !model.supportsImage
        && !model.supportsThinking
        && !model.thinkingConfig
        && !isModelAgenticBlocked(model)
      ) {
        setHoveredModel(null);
        return;
      }
      const dropdownEl = dropdownRef.current;
      if (!dropdownEl) return;
      const dropdownRect = dropdownEl.getBoundingClientRect();
      const placement = resolveCascadePlacement({
        anchorLeft: dropdownRect.left,
        anchorRight: dropdownRect.right,
        width: HOVER_CARD_WIDTH,
        viewportWidth: window.innerWidth,
        preferredSide: CascadeSide.Right,
      });
      setHoverCardSide(placement.side);
      setHoverCardStyle({
        position: 'fixed',
        left: placement.left,
        top: itemRect.top,
        zIndex: 10001,
      });
      setIsThinkingMenuOpen(false);
      setHoveredModel(model);
    }, delay);
  };

  const handleModelHoverEnd = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    cancelHoverClose();
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveredModel(null);
      setIsThinkingMenuOpen(false);
      hoverCloseTimerRef.current = null;
    }, HOVER_CLOSE_DELAY);
  };

  const openThinkingMenu = (trigger: HTMLElement) => {
    if (!thinkingSelectionEnabled || !canConfigureModelThinking(hoveredModel)) {
      setIsThinkingMenuOpen(false);
      return;
    }
    // Already open for this model: keep the current placement so re-entering
    // the trigger row does not make the menu jump.
    if (isThinkingMenuOpen) return;
    const card = hoverCardRef.current;
    if (!card) return;
    const cardRect = card.getBoundingClientRect();
    const { left } = resolveNestedCascadePlacement({
      anchorLeft: cardRect.left,
      anchorRight: cardRect.right,
      width: THINKING_MENU_WIDTH,
      viewportWidth: window.innerWidth,
      preferredSide: hoverCardSide,
    });
    setThinkingMenuStyle({
      position: 'fixed',
      left,
      // Cascade from the row that opened the menu, not from the card top, so the
      // two panels stay visually attached.
      top: trigger.getBoundingClientRect().top,
      width: THINKING_MENU_WIDTH,
      zIndex: 10002,
    });
    setIsThinkingMenuOpen(true);
  };

  const renderModelItem = (model: Model) => {
    const selected = isSelected(model);
    const agenticBlocked = isModelAgenticBlocked(model);
    const restricted = model.accessible === false;
    const blocked = restricted || agenticBlocked;
    const hasThinkingProtocol = supportsConfigurableModelThinkingProtocol(model);

    return (
      <button
        ref={selected ? selectedItemRef : undefined}
        type="button"
        key={getModelIdentityKey(model)}
        onClick={() => handleModelSelect(model)}
        onMouseEnter={(event) => handleModelHover(model, event.currentTarget)}
        onMouseLeave={handleModelHoverEnd}
        onFocus={(event) => handleModelHover(model, event.currentTarget, 0)}
        onBlur={handleModelHoverEnd}
        aria-disabled={blocked}
        aria-haspopup={thinkingSelectionEnabled && hasThinkingProtocol ? 'menu' : undefined}
        className={`w-full px-3 py-2 text-left dark:text-claude-darkText text-claude-text flex items-center gap-2.5 transition-colors ${
          blocked
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
        {hasThinkingProtocol && model.thinkingConfig && (
          <span className="shrink-0 text-[11px] font-medium text-secondary whitespace-nowrap">
            {getModelThinkingLevelLabel(resolveThinkingLevel(model) ?? model.thinkingConfig.defaultLevel)}
          </span>
        )}
        {model.costMultiplier != null && model.costMultiplier > 0 && (
          <span className="shrink-0 text-[11px] text-secondary whitespace-nowrap">
            x{model.costMultiplier}
          </span>
        )}
        <span className="flex-1" />
        {model.supportsImage && (
          <span className="shrink-0 rounded-md bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium leading-none text-secondary">
            {i18nService.t('modelSupportsImageInputBadge')}
          </span>
        )}
        {agenticBlocked && (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-700 dark:text-amber-300">
            <ClockIcon className="h-3 w-3" />
            {i18nService.t('modelSelectorAgenticVerifyingBadge')}
          </span>
        )}
        {restricted && !agenticBlocked && (
          <LockClosedIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
        )}
        {selected && !blocked && (
          <CheckIcon className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.5} />
        )}
      </button>
    );
  };

  const renderModelRows = (models: Model[]) => {
    const accessibleModels = models.filter(model => model.accessible !== false);
    const restrictedModels = models.filter(model => model.accessible === false);
    return (
      <>
        {accessibleModels.map(renderModelItem)}
        {restrictedModels.length > 0 && (
          <div>{restrictedModels.map(renderModelItem)}</div>
        )}
      </>
    );
  };

  const renderMoreModelsSection = () => {
    if (visibleSections.moreModels.length === 0) return null;
    const handleToggle = () => {
      const nextExpanded = !moreModelsExpanded;
      revealMoreModelsOnExpandRef.current = nextExpanded;
      setMoreModelsExpanded(nextExpanded);
    };
    return (
      <div ref={moreModelsSectionRef}>
        <button
          type="button"
          aria-expanded={moreModelsExpanded}
          onClick={handleToggle}
          className="mx-2 flex w-[calc(100%-1rem)] items-center justify-between rounded-lg bg-surface-raised px-3 py-2 text-left text-[13px] font-semibold leading-5 text-foreground transition-colors hover:bg-surface-hover"
        >
          <span>{i18nService.t('modelSelectorMoreModels')}</span>
          <ChevronDownIcon
            className={`h-4 w-4 shrink-0 text-secondary transition-transform ${moreModelsExpanded ? 'rotate-180' : ''}`}
          />
        </button>
        {moreModelsExpanded && renderModelRows(visibleSections.moreModels)}
      </div>
    );
  };

  const renderHoverCard = () => {
    if (!hoveredModel) return null;
    const hasThinkingProtocol = supportsConfigurableModelThinkingProtocol(hoveredModel);
    const thinkingConfigurable = thinkingSelectionEnabled && canConfigureModelThinking(hoveredModel);
    const card = (
      <div
        ref={hoverCardRef}
        style={hoverCardStyle}
        onMouseEnter={cancelHoverClose}
        onMouseLeave={handleModelHoverEnd}
        onFocus={cancelHoverClose}
        onBlur={handleModelHoverEnd}
        className="w-[220px] rounded-xl border border-border bg-surface p-3 shadow-popover pointer-events-auto"
      >
        <div className="text-[13px] font-semibold text-foreground leading-5">{hoveredModel.name}</div>
        {hoveredModel.description && (
          <div className="mt-1 text-[11px] text-secondary leading-4">{hoveredModel.description}</div>
        )}
        {isModelAgenticBlocked(hoveredModel) && (
          <div className="mt-2 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[11px] leading-4 text-amber-700 dark:text-amber-300">
            {i18nService.t('serverModelAgenticNotReady')}
          </div>
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
        {thinkingSelectionEnabled && hasThinkingProtocol && hoveredModel.thinkingConfig && (
          <button
            ref={thinkingMenuTriggerRef}
            type="button"
            disabled={!thinkingConfigurable}
            aria-disabled={!thinkingConfigurable}
            onClick={(event) => openThinkingMenu(event.currentTarget)}
            onMouseEnter={(event) => openThinkingMenu(event.currentTarget)}
            onFocus={(event) => openThinkingMenu(event.currentTarget)}
            aria-haspopup="menu"
            aria-expanded={isThinkingMenuOpen}
            // Bleeds into the card padding so the label still lines up with the
            // text above it while the hover highlight keeps some breathing room.
            className={`-mx-1.5 mt-1.5 flex w-[calc(100%+12px)] items-center justify-between rounded-lg px-1.5 py-2 text-left text-[12px] transition-colors ${
              thinkingConfigurable
                ? `text-foreground ${isThinkingMenuOpen ? 'bg-surface-raised' : 'hover:bg-surface-raised'}`
                : 'cursor-not-allowed text-secondary opacity-60'
            }`}
          >
            <span>{i18nService.t('modelThinkingStrength')}</span>
            <span className="flex items-center gap-1 font-medium">
              {getModelThinkingLevelLabel(
                resolveThinkingLevel(hoveredModel) ?? hoveredModel.thinkingConfig.defaultLevel,
              )}
              {thinkingConfigurable
                ? <ChevronRightIcon className="h-3.5 w-3.5 text-secondary" />
                : <LockClosedIcon className="h-3.5 w-3.5 text-secondary" />}
            </span>
          </button>
        )}
      </div>
    );
    return createPortal(card, document.body);
  };

  const renderThinkingMenu = () => {
    const config = hoveredModel?.thinkingConfig;
    if (!thinkingSelectionEnabled || !hoveredModel || !config || !isThinkingMenuOpen
      || !canConfigureModelThinking(hoveredModel)) return null;
    const selectedLevel = resolveThinkingLevel(hoveredModel) ?? config.defaultLevel;
    return createPortal(
      <div
        ref={thinkingMenuRef}
        style={thinkingMenuStyle}
        onMouseEnter={cancelHoverClose}
        onMouseLeave={handleModelHoverEnd}
        onFocus={cancelHoverClose}
        onBlur={handleModelHoverEnd}
      >
        <ModelThinkingMenu
          config={config}
          selectedLevel={selectedLevel}
          onSelect={(level) => handleThinkingLevelSelect(hoveredModel, level)}
          onEscape={() => setIsThinkingMenuOpen(false)}
        />
      </div>,
      document.body,
    );
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
              onClick={() => {
                setActiveGroup(group.key);
                setMoreModelsExpanded(
                  selectedModel?.moreModel === true && getModelGroup(selectedModel) === group.key,
                );
              }}
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
    if (!showCurrentModelFooter || !selectedModel || !selectedModelGroup) return null;
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
        style={{
          maxHeight: listMaxHeight,
          minHeight: stableListMinHeight !== undefined ? Math.min(stableListMinHeight, listMaxHeight) : undefined,
        }}
        className="model-selector-scroll overflow-y-auto py-1"
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
        {renderModelRows(visibleSections.primaryModels)}
        {renderMoreModelsSection()}
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
        {isModelAgenticBlocked(selectedModel) && (
          <ClockIcon
            className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300"
            aria-label={i18nService.t('serverModelAgenticNotReady')}
          />
        )}
        <ChevronDownIcon className={`${triggerIconClassName} shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary`} />
      </button>

      {portal && dropdown ? createPortal(dropdown, document.body) : dropdown}
      {renderHoverCard()}
      {renderThinkingMenu()}
      {renderRestrictedPrompt()}
    </div>
  );
};

export default ModelSelector;
