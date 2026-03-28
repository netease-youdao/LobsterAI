import type { RefObject } from 'react';
import type { SelectionAction, ActionConfig, SelectionToolbarConfig } from './types';
import type { CoworkPromptInputRef } from '../cowork/CoworkPromptInput';
import { i18nService } from '../../services/i18n';

export const PLACEHOLDER = '{{SELECTED_CONTENT}}';

const injectToPrompt = (
  promptInputRef: RefObject<CoworkPromptInputRef | null>,
  template: string,
  selectedText: string,
): void => {
  const prompt = template.replace(PLACEHOLDER, selectedText);
  promptInputRef.current?.setValue(prompt);
  promptInputRef.current?.focus();
};

type ActionFactory = (promptInputRef: RefObject<CoworkPromptInputRef | null>) => SelectionAction;

export const BUILTIN_ACTION_MAP: Record<string, ActionFactory> = {
  copy: () => ({
    id: 'copy',
    label: i18nService.t('selectionToolbarCopy'),
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
      </svg>
    ),
    clearSelectionAfter: true,
    handler: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback: text is still in the system selection, user can Ctrl+C manually
      }
    },
  }),

  quote: (promptInputRef) => ({
    id: 'quote',
    label: i18nService.t('selectionToolbarQuote'),
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.076-4.076a1.526 1.526 0 0 1 1.037-.443 48.3 48.3 0 0 0 5.887-.373c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
      </svg>
    ),
    clearSelectionAfter: true,
    handler: (text) => {
      const quoted = text
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
      injectToPrompt(promptInputRef, `${quoted}\n\n`, text);
    },
  }),

  explain: (promptInputRef) => ({
    id: 'explain',
    label: i18nService.t('selectionToolbarExplain'),
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 0 0 1.5-.189m-1.5.189a6.01 6.01 0 0 1-1.5-.189m3.75 7.478a12.06 12.06 0 0 1-4.5 0m3.75 2.383a14.406 14.406 0 0 1-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 1 0-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
      </svg>
    ),
    clearSelectionAfter: false,
    handler: (text) => {
      injectToPrompt(
        promptInputRef,
        `${i18nService.t('selectionToolbarExplainPrompt')}${PLACEHOLDER}`,
        text,
      );
    },
  }),

  translate: (promptInputRef) => ({
    id: 'translate',
    label: i18nService.t('selectionToolbarTranslate'),
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="m10.5 21 5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 0 1 6-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 0 1-3.827-5.802" />
      </svg>
    ),
    clearSelectionAfter: false,
    handler: (text) => {
      injectToPrompt(
        promptInputRef,
        `${i18nService.t('selectionToolbarTranslatePrompt')}${PLACEHOLDER}`,
        text,
      );
    },
  }),

  ask: (promptInputRef) => ({
    id: 'ask',
    label: i18nService.t('selectionToolbarAsk'),
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
      </svg>
    ),
    clearSelectionAfter: false,
    handler: (text) => {
      injectToPrompt(
        promptInputRef,
        `${i18nService.t('selectionToolbarAskPrompt')}${PLACEHOLDER}\n\n`,
        text,
      );
    },
  }),
};

export const BUILTIN_ACTION_IDS = Object.keys(BUILTIN_ACTION_MAP);

export const DEFAULT_ACTIONS: ActionConfig[] = [
  { id: 'copy', type: 'builtin', enabled: true, order: 0 },
  { id: 'quote', type: 'builtin', enabled: true, order: 1 },
  { id: 'explain', type: 'builtin', enabled: true, order: 2 },
  { id: 'translate', type: 'builtin', enabled: true, order: 3 },
  { id: 'ask', type: 'builtin', enabled: true, order: 4 },
];

export const DEFAULT_CONFIG: SelectionToolbarConfig = { version: 1, actions: null };

export const buildDefaultActions = (
  promptInputRef: RefObject<CoworkPromptInputRef | null>,
): SelectionAction[] =>
  BUILTIN_ACTION_IDS.map(id => BUILTIN_ACTION_MAP[id](promptInputRef));

export const buildCustomAction = (
  config: ActionConfig,
  promptInputRef: RefObject<CoworkPromptInputRef | null>,
): SelectionAction => ({
  id: config.id,
  label: config.label ?? '',
  icon: <span className="text-sm leading-none">{config.icon ?? '⚡'}</span>,
  clearSelectionAfter: false,
  handler: (text) => {
    if (config.prompt) {
      injectToPrompt(promptInputRef, config.prompt, text);
    }
  },
});

export const resolveActions = (
  config: SelectionToolbarConfig,
  promptInputRef: RefObject<CoworkPromptInputRef | null>,
): SelectionAction[] => {
  try {
    const actionConfigs = config.actions ?? DEFAULT_ACTIONS;
    if (!Array.isArray(actionConfigs)) return buildDefaultActions(promptInputRef);
    return actionConfigs
      .filter(ac => ac.enabled)
      .sort((a, b) => a.order - b.order)
      .map(ac => {
        if (ac.type === 'builtin') {
          const factory = BUILTIN_ACTION_MAP[ac.id];
          return factory ? factory(promptInputRef) : null;
        }
        return buildCustomAction(ac, promptInputRef);
      })
      .filter((a): a is SelectionAction => a !== null);
  } catch {
    return buildDefaultActions(promptInputRef);
  }
};

export const validatePromptTemplate = (prompt: string): { valid: boolean; error?: string } => {
  if (!prompt.trim()) {
    return { valid: false, error: i18nService.t('selectionToolbarPromptRequired') };
  }
  if (!prompt.includes(PLACEHOLDER)) {
    return { valid: false, error: i18nService.t('selectionToolbarPromptMissingPlaceholder') };
  }
  return { valid: true };
};

export interface CustomActionTemplate {
  labelKey: string;
  icon: string;
  promptKey: string;
}

export const CUSTOM_ACTION_TEMPLATES: CustomActionTemplate[] = [
  { labelKey: 'selectionToolbarTemplateSummary', icon: '📝', promptKey: 'selectionToolbarTemplateSummaryPrompt' },
  { labelKey: 'selectionToolbarTemplatePolish', icon: '✨', promptKey: 'selectionToolbarTemplatePolishPrompt' },
  { labelKey: 'selectionToolbarTemplateCodeExplain', icon: '🔍', promptKey: 'selectionToolbarTemplateCodeExplainPrompt' },
  { labelKey: 'selectionToolbarTemplateBlank', icon: '⚡', promptKey: 'selectionToolbarTemplateBlankPrompt' },
];
