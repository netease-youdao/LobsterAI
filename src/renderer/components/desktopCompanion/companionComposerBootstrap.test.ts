import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { authService } from '../../services/auth';
import { THEME_APPEARANCE_STORAGE_KEY, THEME_ID_STORAGE_KEY } from '../../theme/engine/theme-manager';
import { bootstrapCompanionComposer, refreshCompanionComposer } from './companionComposerBootstrap';
import { observeCompanionTheme, synchronizeCompanionTheme } from './companionTheme';

const mocks = vi.hoisted(() => ({
  config: { theme: 'light', themeId: 'classic-light', language: 'zh' },
  updateConfig: vi.fn(async () => {}),
}));

vi.mock('../../services/config', () => ({ configService: {
  init: vi.fn(async () => {}),
  getConfig: () => mocks.config,
  updateConfig: mocks.updateConfig,
} }));
vi.mock('../../services/appConfigModels', () => ({ applyAppConfigToStore: vi.fn() }));
vi.mock('../../services/agent', () => ({ agentService: { loadAgents: vi.fn(async () => {}) } }));
vi.mock('../../services/auth', () => ({ authService: { refreshAuthState: vi.fn(async () => {}) } }));
vi.mock('../../services/cowork', () => ({ coworkService: { loadConfig: vi.fn(async () => {}) } }));
vi.mock('../../services/i18n', () => ({ i18nService: { initialize: vi.fn(async () => {}), setLanguage: vi.fn() } }));

let root: { dataset: Record<string, string>; classList: { add: (name: string) => void; remove: (name: string) => void; toggle: (name: string, enabled: boolean) => void } };
let values: Map<string, string>;
let setItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
  values = new Map([
    [THEME_ID_STORAGE_KEY, 'ocean'],
    [THEME_APPEARANCE_STORAGE_KEY, 'dark'],
  ]);
  setItem = vi.fn((key: string, value: string) => values.set(key, value));
  const classes = new Set<string>();
  root = { dataset: {}, classList: {
    add: name => { classes.add(name); },
    remove: name => { classes.delete(name); },
    toggle: (name, enabled) => { if (enabled) classes.add(name); else classes.delete(name); },
  } };
  vi.stubGlobal('document', { documentElement: root });
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem });
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
  }));
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe('companion composer auth synchronization', () => {
  test('restores auth on first load and rechecks it on every reopening', async () => {
    await bootstrapCompanionComposer();
    await refreshCompanionComposer();
    await refreshCompanionComposer();

    expect(authService.refreshAuthState).toHaveBeenCalledTimes(3);
    expect(authService.refreshAuthState).toHaveBeenNthCalledWith(1, { clearOnFailure: true });
    expect(authService.refreshAuthState).toHaveBeenNthCalledWith(2, { clearOnFailure: true });
    expect(authService.refreshAuthState).toHaveBeenNthCalledWith(3, { clearOnFailure: true });
  });
});

describe('companion composer theme ownership', () => {
  test('first opening follows the active main-window skin without rewriting shared appearance', async () => {
    await bootstrapCompanionComposer();
    expect(root.dataset.theme).toBe('ocean');
    expect(values.get(THEME_APPEARANCE_STORAGE_KEY)).toBe('dark');
    expect(setItem).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  test('reopening follows the latest main-window theme instead of the default setting', async () => {
    values.set(THEME_ID_STORAGE_KEY, 'sakura');
    await refreshCompanionComposer();
    expect(root.dataset.theme).toBe('sakura');
    expect(setItem).not.toHaveBeenCalled();
  });

  test('follows theme changes immediately, ignores unrelated storage and releases listeners', () => {
    const stop = observeCompanionTheme();
    expect(root.dataset.theme).toBe('ocean');
    values.set(THEME_ID_STORAGE_KEY, 'sakura');
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated-key' }));
    expect(root.dataset.theme).toBe('ocean');
    window.dispatchEvent(Object.assign(new Event('storage'), { key: THEME_ID_STORAGE_KEY }));
    expect(root.dataset.theme).toBe('sakura');
    stop();
    values.set(THEME_ID_STORAGE_KEY, 'midnight');
    window.dispatchEvent(Object.assign(new Event('storage'), { key: THEME_ID_STORAGE_KEY }));
    expect(root.dataset.theme).toBe('sakura');
    expect(setItem).not.toHaveBeenCalled();
  });

  test('missing, unknown or inaccessible shared themes fall back to the configured appearance', () => {
    for (const themeId of ['', 'removed-theme']) {
      values.set(THEME_ID_STORAGE_KEY, themeId);
      synchronizeCompanionTheme();
      expect(root.dataset.theme).toBe('classic-light');
    }
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage blocked'); } });
    synchronizeCompanionTheme();
    expect(root.dataset.theme).toBe('classic-light');
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });
});
