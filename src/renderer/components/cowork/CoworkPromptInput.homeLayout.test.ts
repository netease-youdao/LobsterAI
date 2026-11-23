import { configureStore } from '@reduxjs/toolkit';
import { AgentSource } from '@shared/agent/constants';
import { AuthSessionStatus } from '@shared/auth/constants';
import {
  MediaPreferenceMode,
  type MediaSelection,
  resolveMediaPreferences,
} from '@shared/media/defaultPolicy';
import { ProviderName } from '@shared/providers';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider } from 'react-redux';
import { describe, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import { store as applicationStore } from '../../store';
import coworkReducer from '../../store/slices/coworkSlice';
import { type Model, ServerModelLoadStatus } from '../../store/slices/modelSlice';
import type { Agent } from '../../types/agent';
import { type CoworkSession, CoworkSessionStatusValue } from '../../types/cowork';
import CoworkPromptInput from './CoworkPromptInput';

vi.hoisted(() => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    electron: {},
  });
});
vi.mock('../../services/agent', () => ({ agentService: { updateAgent: vi.fn() } }));
vi.mock('../../services/cowork', () => ({
  coworkService: {
    selectSessionModelPreset: vi.fn(),
    patchSession: vi.fn(),
    refreshContextUsage: vi.fn(),
  },
}));
vi.mock('../../services/useMediaPreferences', () => ({ useMediaPreferences: vi.fn() }));
vi.mock('../../services/logReporter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/logReporter')>()),
  reportYdAnalyzer: vi.fn(),
}));
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useLayoutEffect: react.useEffect,
    default: { ...react, useLayoutEffect: react.useEffect },
  };
});

const customModel: Model = {
  id: 'gpt-test',
  name: 'Custom',
  providerKey: ProviderName.OpenAI,
};
const webAgent: Agent = {
  id: 'web-dev',
  name: '网站开发',
  model: 'openai/gpt-test',
  thinkingLevel: '',
  description: '前端与全栈开发助手',
  systemPrompt: '',
  identity: '',
  workingDirectory: '/Users/dev/ai-toolbox',
  icon: '',
  skillIds: [],
  subagentAllowAgentIds: [],
  enabled: true,
  pinned: false,
  isDefault: false,
  source: AgentSource.Custom,
  presetId: '',
  createdAt: 1,
  updatedAt: 1,
};
const activeSession: CoworkSession = {
  id: 'session-1',
  title: 'Active chat',
  agentId: webAgent.id,
  modelOverride: 'openai/gpt-test',
  modelPresetId: null,
  claudeSessionId: null,
  scheduledTaskId: null,
  status: CoworkSessionStatusValue.Completed,
  pinned: false,
  cwd: '/Users/dev/ai-toolbox',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  messages: [{ id: 'm1', type: 'user', content: 'Hi', timestamp: 1 }],
  messagesOffset: 0,
  totalMessages: 1,
  createdAt: 1,
  updatedAt: 1,
};

function renderPrompt(options: {
  session?: CoworkSession | null;
  showFolderSelector?: boolean;
  showAgentSelector?: boolean;
  showReadOnlyContext?: boolean;
  narrow?: boolean;
  mediaSelection?: MediaSelection;
} = {}) {
  const base = applicationStore.getState();
  const draftKey = options.session?.id ?? '__home__';
  const ownerAccountKey = 'user:test';
  const initialState = {
    ...base,
    auth: {
      ...base.auth,
      isLoggedIn: true,
      isLoading: false,
      ownerAccountKey,
      sessionStatus: AuthSessionStatus.Authenticated,
    },
    agent: {
      ...base.agent,
      currentAgentId: webAgent.id,
      agents: [webAgent],
    },
    model: {
      ...base.model,
      availableModels: [customModel],
      defaultSelectedModel: customModel,
      selectedModelByAgent: {},
      serverModelLoadStatus: ServerModelLoadStatus.Ready,
    },
    cowork: {
      ...base.cowork,
      currentSession: options.session ?? null,
      currentSessionId: options.session?.id ?? null,
      mediaModelsOwnerAccountKey: ownerAccountKey,
      mediaModels: {
        image: [{ modelId: 'banana-2', displayName: 'Nano Banana 2', mediaType: 'image' as const }],
        video: [],
      },
      mediaSelection: options.mediaSelection ? { [draftKey]: options.mediaSelection } : {},
    },
  };
  const store = configureStore({
    reducer: (state = initialState, action) => ({
      ...state,
      cowork: coworkReducer(state.cowork, action),
    }),
  });
  return renderToStaticMarkup(
    React.createElement(Provider, {
      store,
      children: React.createElement(CoworkPromptInput, {
        sessionId: options.session?.id,
        size: 'large',
        workingDirectory: webAgent.workingDirectory,
        showFolderSelector: options.showFolderSelector ?? !options.session,
        showModelSelector: true,
        showAgentSelector: options.showAgentSelector ?? !options.session,
        showReadOnlyContext: options.showReadOnlyContext ?? Boolean(options.session),
        narrow: options.narrow ?? false,
        onSubmit: vi.fn(),
      }),
    }),
  );
}

describe('CoworkPromptInput unified top-cap home layout', () => {
  test('wraps folder and agent in a top-cap shell above the nested home card and moves permission inside the card', () => {
    const html = renderPrompt();
    const trayIndex = html.indexOf('data-prompt-context-tray');
    const cardIndex = html.indexOf('data-onboarding-target="home-prompt"');
    const permissionAria = `aria-label="${i18nService.t('coworkPermissionModeLabel')}:`;
    const permissionIndex = html.indexOf(permissionAria);

    expect(trayIndex).toBeGreaterThan(-1);
    expect(cardIndex).toBeGreaterThan(trayIndex);
    expect(permissionIndex).toBeGreaterThan(cardIndex);
    // Unified outer top-cap shell replaces the old bottom gray tray.
    expect(html).toContain('rounded-[24px]');
    expect(html).toContain('rounded-[23px]');
    expect(html).not.toContain('bg-black/[0.035]');
    expect(html).not.toContain('-mt-6');
    // Folder and agent appear in the top-cap strip before the nested white card.
    expect(html.slice(trayIndex, cardIndex)).toContain('ai-toolbox');
    expect(html.slice(trayIndex, cardIndex)).toContain('网站开发');
    // Standalone magic wand and custom media pill are absent under System Default.
    expect(html).not.toContain(`aria-label="${i18nService.t('mediaGenerationMenuItem')}"`);
    expect(html).not.toContain('data-custom-media-pill');
  });

  test('provides localized Manus-style home headline in zh and en', () => {
    for (const language of ['zh', 'en'] as const) {
      i18nService.setLanguage(language, { persist: false });
      expect(i18nService.t('coworkHomeHeadline')).not.toBe('coworkHomeHeadline');
    }
    i18nService.setLanguage('zh', { persist: false });
  });

  test('shows the compact media override pill only when a user explicitly picks a custom media model', () => {
    const selection = resolveMediaPreferences({
      schemaVersion: 1,
      revision: 2,
      image: { mode: MediaPreferenceMode.Selected, modelId: 'banana-2', modelName: 'Nano Banana 2' },
      video: { mode: MediaPreferenceMode.Inherit },
    });
    const html = renderPrompt({ mediaSelection: selection });
    expect(html).toContain('data-custom-media-pill="true"');
    expect(html).toContain('Nano Banana 2');
  });

  test('keeps permission inside the card in active sessions without a standalone magic wand', () => {
    const html = renderPrompt({ session: activeSession });
    const permissionAria = `aria-label="${i18nService.t('coworkPermissionModeLabel')}:`;
    expect(html).not.toContain('data-prompt-context-tray');
    expect(html).toContain(permissionAria);
    expect(html).not.toContain(`aria-label="${i18nService.t('mediaGenerationMenuItem')}"`);
  });

  test('keeps desktop companion narrow composer single-row with tray inside the card', () => {
    const html = renderPrompt({ narrow: true, showFolderSelector: false });
    const trayIndex = html.indexOf('data-prompt-context-tray');
    const cardIndex = html.indexOf('data-onboarding-target="home-prompt"');
    expect(cardIndex).toBeGreaterThan(-1);
    expect(trayIndex).toBeGreaterThan(cardIndex);
    expect(html).not.toContain('data-custom-media-pill');
  });
});
