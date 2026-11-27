import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  getAgentOnboardingMeta,
  removeAgentOnboardingMeta,
  saveAgentOnboardingMeta,
} from './agentOnboarding';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, value); },
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: createMemoryStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agentOnboarding storage', () => {
  test('saves, reads, clamps, and deletes per-agent onboarding metadata', () => {
    saveAgentOnboardingMeta('agent-1', {
      starterPrompts: ['  Prompt 1 ', 'Prompt 2', 'Prompt 3', 'Prompt 4'],
      recommendedSkillIds: ['docx', '  '],
    });

    const loaded = getAgentOnboardingMeta('agent-1');
    expect(loaded?.starterPrompts).toEqual(['Prompt 1', 'Prompt 2', 'Prompt 3']);
    expect(loaded?.recommendedSkillIds).toEqual(['docx']);

    removeAgentOnboardingMeta('agent-1');
    expect(getAgentOnboardingMeta('agent-1')).toBeNull();
  });

  test('removes entry when saved with empty prompts and skills', () => {
    saveAgentOnboardingMeta('agent-2', { starterPrompts: ['Hello'] });
    expect(getAgentOnboardingMeta('agent-2')).not.toBeNull();

    saveAgentOnboardingMeta('agent-2', { starterPrompts: [] });
    expect(getAgentOnboardingMeta('agent-2')).toBeNull();
  });
});
