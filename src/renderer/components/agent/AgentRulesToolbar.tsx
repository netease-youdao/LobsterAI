import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronDownIcon,
  DocumentTextIcon,
  SparklesIcon,
  StopIcon,
} from '@heroicons/react/24/outline';
import { AgentRulePolishDirective } from '@shared/agent';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '../../services/i18n';
import {
  AGENT_RULE_POLISH_OPTIONS,
  AGENT_RULE_TEMPLATES,
  type AgentRuleTemplateOption,
  getPolishDirectiveLabelKey,
  RulesUndoSource,
} from './agentPersonaHelpers';

const RulesToolbarMenuKind = {
  Templates: 'templates',
  Polish: 'polish',
} as const;

type RulesToolbarMenuKind = typeof RulesToolbarMenuKind[keyof typeof RulesToolbarMenuKind];

const MENU_EDGE_GAP_PX = 8;
const MENU_TRIGGER_GAP_PX = 6;
const TEMPLATE_MENU_WIDTH_PX = 308;
const POLISH_MENU_WIDTH_PX = 276;
const ESTIMATED_MENU_HEIGHT_PX = 280;

export interface AgentRulesToolbarProps {
  hasRules: boolean;
  polishing: boolean;
  polishStreaming: boolean;
  activePolishDirective: AgentRulePolishDirective | null;
  undoSource: RulesUndoSource | null;
  undoRestoresPreviousText: boolean;
  onApplyTemplate: (template: AgentRuleTemplateOption) => void;
  onAiPolish: (directive: AgentRulePolishDirective) => void;
  onCancelPolish: () => void;
  onUndo: () => void;
  onMenuOpenChange?: (open: boolean) => void;
}

const AgentRulesToolbar: React.FC<AgentRulesToolbarProps> = ({
  hasRules,
  polishing,
  polishStreaming,
  activePolishDirective,
  undoSource,
  undoRestoresPreviousText,
  onApplyTemplate,
  onAiPolish,
  onCancelPolish,
  onUndo,
  onMenuOpenChange,
}) => {
  const [openMenu, setOpenMenu] = useState<RulesToolbarMenuKind | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);

  const templateTriggerRef = useRef<HTMLButtonElement>(null);
  const polishGroupRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setOpenMenu(null);
  }, []);

  useEffect(() => {
    onMenuOpenChange?.(openMenu !== null);
  }, [onMenuOpenChange, openMenu]);

  useEffect(() => () => {
    onMenuOpenChange?.(false);
  }, [onMenuOpenChange]);

  useEffect(() => {
    if (polishing) {
      setOpenMenu(null);
      return;
    }
    if (openMenu === RulesToolbarMenuKind.Templates && hasRules) {
      setOpenMenu(null);
    } else if (openMenu === RulesToolbarMenuKind.Polish && !hasRules) {
      setOpenMenu(null);
    }
  }, [hasRules, openMenu, polishing]);

  const updateMenuPosition = useCallback(() => {
    if (!openMenu) return;
    const anchor = openMenu === RulesToolbarMenuKind.Templates
      ? templateTriggerRef.current
      : polishGroupRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    const width = openMenu === RulesToolbarMenuKind.Templates
      ? TEMPLATE_MENU_WIDTH_PX
      : POLISH_MENU_WIDTH_PX;
    const measuredHeight = menuRef.current?.offsetHeight || ESTIMATED_MENU_HEIGHT_PX;

    const preferredLeft = openMenu === RulesToolbarMenuKind.Templates
      ? rect.left
      : rect.right - width;
    const maxLeft = Math.max(MENU_EDGE_GAP_PX, window.innerWidth - width - MENU_EDGE_GAP_PX);
    const left = Math.max(MENU_EDGE_GAP_PX, Math.min(preferredLeft, maxLeft));

    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < measuredHeight + MENU_TRIGGER_GAP_PX && rect.top > spaceBelow;
    const preferredTop = openAbove
      ? rect.top - measuredHeight - MENU_TRIGGER_GAP_PX
      : rect.bottom + MENU_TRIGGER_GAP_PX;
    const maxTop = Math.max(MENU_EDGE_GAP_PX, window.innerHeight - measuredHeight - MENU_EDGE_GAP_PX);

    setMenuPosition({
      top: Math.max(MENU_EDGE_GAP_PX, Math.min(preferredTop, maxTop)),
      left,
    });
  }, [openMenu]);

  useLayoutEffect(() => {
    if (!openMenu) {
      setMenuPosition(null);
      return;
    }
    updateMenuPosition();
  }, [openMenu, updateMenuPosition]);

  useEffect(() => {
    if (!openMenu) return undefined;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        templateTriggerRef.current?.contains(target)
        || polishGroupRef.current?.contains(target)
        || menuRef.current?.contains(target)
      ) {
        return;
      }
      setOpenMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpenMenu(null);
    };

    const handleScroll = (event: Event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) {
        return;
      }
      setOpenMenu(null);
    };

    const handleResize = () => setOpenMenu(null);

    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [openMenu]);

  const toggleMenu = (kind: RulesToolbarMenuKind) => {
    setOpenMenu(prev => (prev === kind ? null : kind));
  };

  const polishingStatusLabel = (() => {
    if (polishStreaming) {
      return i18nService.t('agentRulesAiStreaming');
    }
    if (activePolishDirective && activePolishDirective !== AgentRulePolishDirective.Polish) {
      const styleLabel = i18nService.t(getPolishDirectiveLabelKey(activePolishDirective));
      return i18nService.t('agentRulesAiApplyingDirective').replace('{style}', styleLabel);
    }
    return hasRules
      ? i18nService.t('agentRulesAiPolishing')
      : i18nService.t('agentRulesAiGenerating');
  })();

  const renderMenuPortal = () => {
    if (!openMenu || typeof document === 'undefined') return null;

    const isTemplates = openMenu === RulesToolbarMenuKind.Templates;
    const widthPx = isTemplates ? TEMPLATE_MENU_WIDTH_PX : POLISH_MENU_WIDTH_PX;

    return createPortal(
      <div
        ref={menuRef}
        role="menu"
        style={
          menuPosition
            ? { top: menuPosition.top, left: menuPosition.left, width: widthPx }
            : { top: -9999, left: -9999, width: widthPx, visibility: 'hidden' }
        }
        className="fixed z-[60] max-h-[min(360px,calc(100vh-16px))] overflow-y-auto rounded-xl border border-border bg-surface py-1.5 shadow-popover"
      >
        <div className="px-3 pt-1 pb-1.5 text-[11px] font-medium text-secondary">
          {i18nService.t(isTemplates ? 'agentRulesTemplatesMenuHeader' : 'agentRulesAiMenuHeader')}
        </div>

        {isTemplates
          ? AGENT_RULE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onApplyTemplate(template);
                }}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              >
                <span className="text-xs font-medium text-foreground">
                  {i18nService.t(template.titleKey)}
                </span>
                <span className="text-[11px] leading-4 text-secondary">
                  {i18nService.t(template.descriptionKey)}
                </span>
              </button>
            ))
          : AGENT_RULE_POLISH_OPTIONS.map((option) => (
              <React.Fragment key={option.directive}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    onAiPolish(option.directive);
                  }}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                >
                  <span className="text-xs font-medium text-foreground">
                    {i18nService.t(option.labelKey)}
                  </span>
                  <span className="text-[11px] leading-4 text-secondary">
                    {i18nService.t(option.descriptionKey)}
                  </span>
                </button>
                {option.separatorAfter && (
                  <div className="my-1 border-t border-border-subtle" role="separator" />
                )}
              </React.Fragment>
            ))}
      </div>,
      document.body,
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface-raised/45 px-2.5 py-2">
        {/* Left slot: streaming status, empty-state templates, or undo status */}
        <div className="flex min-w-0 items-center gap-1.5">
          {polishing ? (
            <span className="inline-flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-foreground/80">
              <ArrowPathIcon className="h-3.5 w-3.5 shrink-0 animate-spin text-foreground" />
              <span>{polishingStatusLabel}</span>
            </span>
          ) : !hasRules ? (
            <button
              ref={templateTriggerRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={openMenu === RulesToolbarMenuKind.Templates}
              onClick={() => toggleMenu(RulesToolbarMenuKind.Templates)}
              className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors active:scale-[0.98] ${
                openMenu === RulesToolbarMenuKind.Templates
                  ? 'border-border bg-surface text-foreground shadow-subtle'
                  : 'border-transparent text-secondary hover:border-border/80 hover:bg-surface hover:text-foreground'
              }`}
            >
              <DocumentTextIcon className="h-3.5 w-3.5 shrink-0" />
              <span>{i18nService.t('agentRulesTemplatesAction')}</span>
              <ChevronDownIcon className="h-3 w-3 shrink-0 opacity-75" />
            </button>
          ) : undoSource ? (
            <div className="flex flex-wrap items-center gap-1.5 px-1 animate-fade-in">
              <span className="text-xs text-secondary">
                {undoSource === RulesUndoSource.Template
                  ? i18nService.t('agentRulesTemplateAppliedHint')
                  : i18nService.t('agentRulesAiAppliedHint')}
              </span>
              <span className="text-secondary/35" aria-hidden="true">·</span>
              <button
                type="button"
                onClick={onUndo}
                className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-surface hover:text-foreground"
              >
                <ArrowUturnLeftIcon className="h-3 w-3 shrink-0" />
                <span>
                  {undoRestoresPreviousText
                    ? i18nService.t('agentRulesAiUndo')
                    : i18nService.t('agentRulesUndoAction')}
                </span>
              </button>
            </div>
          ) : null}
        </div>

        {/* Right slot: Stop while polishing, AI Generate when empty, split AI Polish when populated */}
        <div className="flex shrink-0 items-center gap-1.5">
          {polishing ? (
            <button
              type="button"
              onClick={onCancelPolish}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-foreground/20 bg-surface px-2.5 text-xs font-medium text-foreground shadow-subtle transition-colors hover:bg-surface-raised active:scale-[0.98]"
            >
              <StopIcon className="h-3.5 w-3.5" />
              <span>{i18nService.t('agentRulesAiStop')}</span>
            </button>
          ) : !hasRules ? (
            <button
              type="button"
              onClick={() => {
                closeMenu();
                onAiPolish(AgentRulePolishDirective.Polish);
              }}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-xs font-medium text-foreground shadow-subtle transition-colors hover:bg-surface-raised active:scale-[0.98]"
            >
              <SparklesIcon className="h-3.5 w-3.5 text-secondary" />
              <span>{i18nService.t('agentRulesAiGenerateAction')}</span>
            </button>
          ) : (
            <div
              ref={polishGroupRef}
              className="inline-flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border bg-surface shadow-subtle"
            >
              <button
                type="button"
                onClick={() => {
                  closeMenu();
                  onAiPolish(AgentRulePolishDirective.Polish);
                }}
                className="inline-flex h-full items-center gap-1.5 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised active:scale-[0.98]"
              >
                <SparklesIcon className="h-3.5 w-3.5 text-secondary" />
                <span>{i18nService.t('agentRulesAiPolishAction')}</span>
              </button>
              <span className="h-4 w-px bg-border" aria-hidden="true" />
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={openMenu === RulesToolbarMenuKind.Polish}
                aria-label={i18nService.t('agentRulesAiMenuTrigger')}
                title={i18nService.t('agentRulesAiMenuTrigger')}
                onClick={() => toggleMenu(RulesToolbarMenuKind.Polish)}
                className={`inline-flex h-full w-6 items-center justify-center text-secondary transition-colors hover:bg-surface-raised hover:text-foreground ${
                  openMenu === RulesToolbarMenuKind.Polish ? 'bg-surface-raised text-foreground' : ''
                }`}
              >
                <ChevronDownIcon className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
      {renderMenuPortal()}
    </>
  );
};

export default AgentRulesToolbar;
