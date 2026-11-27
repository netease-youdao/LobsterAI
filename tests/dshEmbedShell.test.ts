import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, test, vi } from 'vitest';
import * as vm from 'vm';

const EMBED_SHELL_CLIENT_PATH = path.resolve(
  __dirname,
  '..',
  'dsh-bundles',
  'lobsterai-host',
  'plugins',
  'embed-shell',
  'client.js',
);

interface MockSettingsState {
  open: boolean;
  activeId: string | undefined;
}

function createMockSettingsStore() {
  let snapshot: MockSettingsState = { open: false, activeId: undefined };
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const instance = {
    getSnapshot: () => snapshot,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    actions: {
      open: vi.fn(() => {
        snapshot = { ...snapshot, open: true };
        notify();
      }),
      close: vi.fn(() => {
        snapshot = { open: false, activeId: undefined };
        notify();
      }),
      select: vi.fn((id: string) => {
        snapshot = { ...snapshot, activeId: id };
        notify();
      }),
      openSection: vi.fn((id: string) => {
        snapshot = { open: true, activeId: id };
        notify();
      }),
    },
  };
  return {
    handle: { create: () => instance },
    instance,
  };
}

function createEmbedShellHarness(initialHash: string) {
  const storage = new Map<string, string>();
  const hashListeners = new Set<() => void>();
  const slotEntries = new Map<string, Array<Record<string, unknown>>>();
  const slotListeners = new Map<string, Set<() => void>>();
  let activeMainPanelId: string | null = null;
  let effectCleanup: (() => void) | undefined;

  const styleNodes = new Map<string, { id: string; textContent: string; parentNode: unknown }>();
  const dataset: Record<string, string | undefined> = {};
  const head = {
    appendChild: vi.fn((node: { id: string; textContent: string; parentNode: unknown }) => {
      node.parentNode = head;
      styleNodes.set(node.id, node);
    }),
    removeChild: vi.fn((node: { id: string; parentNode: unknown }) => {
      styleNodes.delete(node.id);
      node.parentNode = null;
    }),
  };

  const mockDocument = {
    head,
    documentElement: {
      dataset,
      appendChild: head.appendChild,
    },
    getElementById: (id: string) => styleNodes.get(id) ?? null,
    createElement: () => ({ id: '', textContent: '', parentNode: null }),
  };

  const mockWindow = {
    location: { hash: initialHash },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    addEventListener: (event: string, listener: () => void) => {
      if (event === 'hashchange') hashListeners.add(listener);
    },
    removeEventListener: (event: string, listener: () => void) => {
      if (event === 'hashchange') hashListeners.delete(listener);
    },
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  };

  let loadedModule: {
    inject: string[];
    apply: (ctx: Record<string, unknown>) => void;
  } | null = null;

  const sandbox = {
    window: {
      ...mockWindow,
      __ModuleLoader__: {
        load: ({ factory }: { id: string; factory: () => typeof loadedModule }) => {
          loadedModule = factory();
        },
      },
    },
    document: mockDocument,
    URLSearchParams,
  };
  vm.runInNewContext(fs.readFileSync(EMBED_SHELL_CLIENT_PATH, 'utf8'), sandbox);
  if (!loadedModule) {
    throw new Error('Failed to load embed-shell client module');
  }

  const selectPanel = vi.fn((key: string) => {
    activeMainPanelId = key;
  });

  const ctx = {
    slots: {
      entriesOfSlot: (name: string) => slotEntries.get(name) ?? [],
      entries: (name: string) => slotEntries.get(name) ?? [],
      subscribe: (name: string, fn: () => void) => {
        let listeners = slotListeners.get(name);
        if (!listeners) {
          listeners = new Set();
          slotListeners.set(name, listeners);
        }
        listeners.add(fn);
        return () => {
          listeners!.delete(fn);
        };
      },
    },
    layout: {
      panelInfo: {
        getSnapshot: () => ({ activePanelId: activeMainPanelId }),
      },
      selectPanel,
    },
    effect: (fn: () => (() => void) | void) => {
      const cleanup = fn();
      if (typeof cleanup === 'function') {
        effectCleanup = cleanup;
      }
      return () => {
        effectCleanup?.();
      };
    },
  };

  return {
    apply: () => loadedModule!.apply(ctx),
    setSlotEntries: (slotName: string, entries: Array<Record<string, unknown>>) => {
      slotEntries.set(slotName, entries);
      const listeners = slotListeners.get(slotName);
      if (listeners) {
        for (const listener of [...listeners]) {
          listener();
        }
      }
    },
    setHash: (nextHash: string) => {
      sandbox.window.location.hash = nextHash;
      for (const listener of [...hashListeners]) {
        listener();
      }
    },
    cleanup: () => {
      effectCleanup?.();
    },
    dataset,
    selectPanel,
    getStyleText: () => styleNodes.get('lobsterai-dsh-embed-shell-style')?.textContent ?? '',
  };
}

describe('lobster-embed-shell client.js', () => {
  test('opens a settings.section plugin once sidebar.settings and settings.section register and keeps it open', () => {
    const harness = createEmbedShellHarness(
      '#lobster-embed=1&panel=pocket&panelKind=settings-section&theme=light&lang=zh',
    );
    const settingsShell = createMockSettingsStore();

    harness.apply();
    expect(harness.dataset.lobsterEmbed).toBe('true');
    expect(harness.dataset.lobsterEmbedMode).toBe('settings');
    expect(harness.dataset.lobsterEmbedReady).toBe('false');
    expect(harness.getStyleText()).toContain('[data-shortcut-modal="settings"]');

    // Register sidebar.settings first; section is not yet mounted so it stays waiting.
    harness.setSlotEntries('sidebar.settings', [{ store: settingsShell.handle }]);
    expect(settingsShell.instance.actions.openSection).not.toHaveBeenCalled();
    expect(harness.dataset.lobsterEmbedReady).toBe('false');

    // Register settings.section (`dsh-pocket`); embed shell opens it immediately.
    harness.setSlotEntries('settings.section', [
      { options: { id: 'general' } },
      { options: { id: 'pocket' } },
    ]);
    expect(settingsShell.instance.actions.openSection).toHaveBeenCalledWith('pocket');
    expect(settingsShell.instance.getSnapshot()).toEqual({ open: true, activeId: 'pocket' });
    expect(harness.dataset.lobsterEmbedReady).toBe('true');

    // If Escape or a modal close handler closes SettingsPanel, the guard re-opens `pocket`.
    settingsShell.instance.actions.close();
    expect(settingsShell.instance.getSnapshot()).toEqual({ open: true, activeId: 'pocket' });

    harness.cleanup();
    expect(harness.dataset.lobsterEmbed).toBeUndefined();
    expect(harness.dataset.lobsterEmbedMode).toBeUndefined();
  });

  test('switches cleanly between settings-section and main panels via hashchange in the same webview', () => {
    const harness = createEmbedShellHarness(
      '#lobster-embed=1&panel=pocket&panelKind=settings-section&theme=dark&lang=zh',
    );
    const settingsShell = createMockSettingsStore();
    harness.setSlotEntries('sidebar.settings', [{ store: settingsShell.handle }]);
    harness.setSlotEntries('settings.section', [{ options: { id: 'pocket' } }]);
    harness.setSlotEntries('main', [{ options: { key: 'media-desk' } }]);

    harness.apply();
    expect(harness.dataset.lobsterEmbedMode).toBe('settings');
    expect(settingsShell.instance.getSnapshot()).toEqual({ open: true, activeId: 'pocket' });

    // Switch to a main panel (`media-desk`): closes settings shell and selects main panel.
    harness.setHash('#lobster-embed=1&panel=media-desk&theme=dark&lang=zh');
    expect(harness.dataset.lobsterEmbedMode).toBe('main');
    expect(settingsShell.instance.getSnapshot()).toEqual({ open: false, activeId: undefined });
    expect(harness.selectPanel).toHaveBeenCalledWith('media-desk');
    expect(harness.dataset.lobsterEmbedReady).toBe('true');

    // Switch back to settings-section (`dsh-pocket` fuzzy-matches `pocket`).
    harness.setHash('#lobster-embed=1&panel=dsh-pocket&panelKind=settings-section&theme=dark&lang=zh');
    expect(harness.dataset.lobsterEmbedMode).toBe('settings');
    expect(settingsShell.instance.getSnapshot()).toEqual({ open: true, activeId: 'pocket' });
    expect(harness.dataset.lobsterEmbedReady).toBe('true');

    harness.cleanup();
  });
});
