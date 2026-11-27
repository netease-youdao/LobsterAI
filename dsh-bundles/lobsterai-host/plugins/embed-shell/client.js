window.__ModuleLoader__.load({
  id: '@lobsterai/dsh-embed-shell',
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;

    const EMBED_STORAGE_KEY = 'lobsterai:dsh-embed-state';
    const STYLE_ELEMENT_ID = 'lobsterai-dsh-embed-shell-style';
    const FALLBACK_READY_TIMEOUT_MS = 4000;
    const PANEL_KIND_MAIN = 'main';
    const PANEL_KIND_SETTINGS_SECTION = 'settings-section';

    function normalizePanelKind(value) {
      return String(value || '').trim().toLowerCase() === PANEL_KIND_SETTINGS_SECTION
        ? PANEL_KIND_SETTINGS_SECTION
        : PANEL_KIND_MAIN;
    }

    function parseEmbedParamsFromHash(rawHash) {
      const cleaned = typeof rawHash === 'string' ? rawHash.replace(/^#/, '') : '';
      if (!cleaned) return null;
      const params = new URLSearchParams(cleaned);
      const flag = params.get('lobster-embed');
      if (flag === '0' || flag === 'false') {
        try {
          window.sessionStorage.removeItem(EMBED_STORAGE_KEY);
        } catch {
          // Ignore storage errors in restricted contexts.
        }
        return { active: false, panel: '', panelKind: PANEL_KIND_MAIN, theme: '', lang: '' };
      }
      if (flag === '1' || flag === 'true') {
        const state = {
          active: true,
          panel: (params.get('panel') || '').trim(),
          panelKind: normalizePanelKind(params.get('panelKind')),
          theme: (params.get('theme') || '').trim().toLowerCase(),
          lang: (params.get('lang') || '').trim().toLowerCase(),
        };
        try {
          window.sessionStorage.setItem(EMBED_STORAGE_KEY, JSON.stringify(state));
        } catch {
          // Ignore storage errors in restricted contexts.
        }
        return state;
      }
      return null;
    }

    function readEmbedState() {
      if (typeof window === 'undefined') return null;
      const fromHash = parseEmbedParamsFromHash(window.location.hash);
      if (fromHash) {
        return fromHash.active ? fromHash : null;
      }
      try {
        const stored = window.sessionStorage.getItem(EMBED_STORAGE_KEY);
        if (!stored) return null;
        const parsed = JSON.parse(stored);
        if (parsed && parsed.active === true) {
          return {
            active: true,
            panel: typeof parsed.panel === 'string' ? parsed.panel : '',
            panelKind: normalizePanelKind(parsed.panelKind),
            theme: typeof parsed.theme === 'string' ? parsed.theme : '',
            lang: typeof parsed.lang === 'string' ? parsed.lang : '',
          };
        }
      } catch {
        // Ignore malformed storage entries.
      }
      return null;
    }

    const EMBED_CSS = `
html[data-lobster-embed="true"] [data-sidebar-mask],
html[data-lobster-embed="true"] [data-shell-leading],
html[data-lobster-embed="true"] [data-side="sidebar"],
html[data-lobster-embed="true"] [data-side="rightbar"],
html[data-lobster-embed="true"] [data-rightbar-col] {
  display: none !important;
  pointer-events: none !important;
}

html[data-lobster-embed="true"] :has(> [data-rightbar-col]) {
  grid-template-columns: 0px minmax(0, 1fr) 0px !important;
  --dsh-frame-leading-clearance: 0px !important;
  --dsh-frame-top-clearance: 0px !important;
  --dsh-frame-chrome-top: 0px !important;
  padding-top: 0 !important;
}

html[data-lobster-embed="true"] :has(> [data-rightbar-col]) > :has(+ * + [data-rightbar-col]) {
  display: none !important;
  pointer-events: none !important;
}

html[data-lobster-embed="true"] :has(> [data-rightbar-col]) > :has(+ [data-rightbar-col]) {
  grid-column: 1 / -1 !important;
  border-left: none !important;
}

html[data-lobster-embed="true"] [data-global-panel] {
  padding-top: 0 !important;
}

html[data-lobster-embed="true"][data-lobster-embed-ready="false"] :has(> [data-rightbar-col]) > :has(+ [data-rightbar-col]) {
  opacity: 0 !important;
}

html[data-lobster-embed="true"][data-lobster-embed-mode="settings"] :has(> [data-rightbar-col]) > :has(+ [data-rightbar-col]) {
  opacity: 0 !important;
  pointer-events: none !important;
}

html[data-lobster-embed="true"][data-lobster-embed-mode="settings"][data-lobster-embed-ready="false"] body > :has(> [data-shortcut-modal="settings"]) {
  opacity: 0 !important;
}

html[data-lobster-embed="true"][data-lobster-embed-mode="settings"] body > :has(> [data-shortcut-modal="settings"]) {
  position: fixed !important;
  inset: 0 !important;
  align-items: stretch !important;
  justify-content: stretch !important;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent)) !important;
}

html[data-lobster-embed="true"][data-lobster-embed-mode="settings"] body > :has(> [data-shortcut-modal="settings"]) > :not([data-shortcut-modal="settings"]) {
  display: none !important;
  pointer-events: none !important;
}

html[data-lobster-embed="true"][data-lobster-embed-mode="settings"] [data-shortcut-modal="settings"] {
  display: flex !important;
  flex-direction: column !important;
  width: 100% !important;
  max-width: none !important;
  height: 100% !important;
  max-height: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent)) !important;
}

html[data-lobster-embed="true"][data-lobster-embed-mode="settings"] [data-shortcut-modal="settings"] > :not(:last-child) {
  display: none !important;
  pointer-events: none !important;
}

html[data-lobster-embed="true"][data-lobster-embed-mode="settings"] [data-shortcut-modal="settings"] > :last-child {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  width: 100% !important;
  box-sizing: border-box !important;
  padding: 24px !important;
  overflow-y: auto !important;
}
`;

    function installEmbedStyles() {
      if (typeof document === 'undefined') return () => {};
      let styleEl = document.getElementById(STYLE_ELEMENT_ID);
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = STYLE_ELEMENT_ID;
        styleEl.textContent = EMBED_CSS;
        (document.head || document.documentElement).appendChild(styleEl);
      }
      document.documentElement.dataset.lobsterEmbed = 'true';
      return () => {
        delete document.documentElement.dataset.lobsterEmbed;
        delete document.documentElement.dataset.lobsterEmbedReady;
        delete document.documentElement.dataset.lobsterEmbedMode;
        const existing = document.getElementById(STYLE_ELEMENT_ID);
        if (existing && existing.parentNode) {
          existing.parentNode.removeChild(existing);
        }
      };
    }

    function syncEmbedModeAttribute(currentState) {
      if (typeof document === 'undefined') return;
      document.documentElement.dataset.lobsterEmbedMode =
        currentState && currentState.panelKind === PANEL_KIND_SETTINGS_SECTION
          ? 'settings'
          : 'main';
    }

    function normalizePanelKey(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^@[^/]+\//, '')
        .replace(/^dsh-/, '');
    }

    function readSlotEntries(ctx, slotName) {
      if (!ctx || !ctx.slots) return [];
      const entries = typeof ctx.slots.entriesOfSlot === 'function'
        ? ctx.slots.entriesOfSlot(slotName)
        : (typeof ctx.slots.entries === 'function' ? ctx.slots.entries(slotName) : []);
      return Array.isArray(entries) ? entries : [];
    }

    function findMatchingMainPanelKey(ctx, targetPanelId) {
      if (!targetPanelId || !ctx.slots) return null;
      const entries = readSlotEntries(ctx, 'main');
      if (entries.length === 0) return null;

      const keys = entries
        .map((entry) => entry && entry.options && entry.options.key)
        .filter((key) => typeof key === 'string' && key.length > 0 && key !== 'conversation');

      if (keys.includes(targetPanelId)) {
        return targetPanelId;
      }
      const normalizedTarget = normalizePanelKey(targetPanelId);
      const fuzzy = keys.find((key) => normalizePanelKey(key) === normalizedTarget);
      return fuzzy || null;
    }

    function findMatchingSettingsSectionId(ctx, targetSectionId) {
      if (!targetSectionId || !ctx.slots) return null;
      const entries = readSlotEntries(ctx, 'settings.section');
      if (entries.length === 0) return null;

      const ids = entries
        .map((entry) => entry && entry.options && entry.options.id)
        .filter((id) => typeof id === 'string' && id.length > 0);

      if (ids.includes(targetSectionId)) {
        return targetSectionId;
      }
      const normalizedTarget = normalizePanelKey(targetSectionId);
      const fuzzy = ids.find((id) => normalizePanelKey(id) === normalizedTarget);
      return fuzzy || null;
    }

    function resolveSettingsShellStore(ctx) {
      const entries = readSlotEntries(ctx, 'sidebar.settings');
      for (const entry of entries) {
        const handle = entry && entry.store;
        if (!handle || typeof handle.create !== 'function') continue;
        try {
          const instance = handle.create();
          if (
            instance
            && instance.actions
            && typeof instance.actions.openSection === 'function'
            && typeof instance.actions.close === 'function'
          ) {
            return instance;
          }
        } catch {
          // Try next registration if present.
        }
      }
      return null;
    }

    exports.inject = ['slots', 'layout'];

    exports.apply = function apply(ctx) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;

      let state = readEmbedState();
      if (!state) return;

      let readyTimer = null;
      let themeService = null;
      let localeService = null;
      let guardedSettingsStore = null;
      let unsubscribeSettingsStore = null;
      let reopeningSettings = false;

      const removeStyles = installEmbedStyles();
      syncEmbedModeAttribute(state);
      document.documentElement.dataset.lobsterEmbedReady = state.panel ? 'false' : 'true';

      const syncThemeAndLocale = (currentState) => {
        if (!currentState) return;
        if (themeService && (currentState.theme === 'light' || currentState.theme === 'dark')) {
          try {
            const snapshot = typeof themeService.getTheme === 'function' ? themeService.getTheme() : null;
            if (!snapshot || snapshot.active?.colorScheme !== currentState.theme) {
              themeService.setTheme(currentState.theme);
            }
          } catch {
            // Best-effort theme alignment.
          }
        }
        if (localeService && (currentState.lang === 'zh' || currentState.lang === 'en')) {
          try {
            const snapshot = typeof localeService.getLocale === 'function' ? localeService.getLocale() : null;
            if (!snapshot || snapshot.active !== currentState.lang) {
              localeService.setLocale(currentState.lang);
            }
          } catch {
            // Best-effort locale alignment.
          }
        }
      };

      const markReady = () => {
        if (readyTimer !== null) {
          window.clearTimeout(readyTimer);
          readyTimer = null;
        }
        document.documentElement.dataset.lobsterEmbedReady = 'true';
      };

      const armReadyFallback = () => {
        if (readyTimer !== null) {
          window.clearTimeout(readyTimer);
        }
        readyTimer = window.setTimeout(() => {
          readyTimer = null;
          document.documentElement.dataset.lobsterEmbedReady = 'true';
        }, FALLBACK_READY_TIMEOUT_MS);
      };

      const detachSettingsGuard = () => {
        if (typeof unsubscribeSettingsStore === 'function') {
          try {
            unsubscribeSettingsStore();
          } catch {
            // Ignore cleanup errors.
          }
        }
        unsubscribeSettingsStore = null;
        guardedSettingsStore = null;
      };

      const closeSettingsShellIfOpen = () => {
        detachSettingsGuard();
        const settingsStore = resolveSettingsShellStore(ctx);
        if (!settingsStore) return;
        try {
          const snap = typeof settingsStore.getSnapshot === 'function' ? settingsStore.getSnapshot() : null;
          if (!snap || snap.open) {
            settingsStore.actions.close();
          }
        } catch {
          // Best-effort close when leaving settings-section embed mode.
        }
      };

      const ensureSettingsSectionOpen = (settingsStore, sectionId) => {
        if (reopeningSettings) return;
        try {
          const snap = typeof settingsStore.getSnapshot === 'function' ? settingsStore.getSnapshot() : null;
          if (!snap || !snap.open || snap.activeId !== sectionId) {
            reopeningSettings = true;
            try {
              settingsStore.actions.openSection(sectionId);
            } finally {
              reopeningSettings = false;
            }
          }
        } catch {
          reopeningSettings = false;
        }
      };

      const attachSettingsGuard = (settingsStore) => {
        if (guardedSettingsStore === settingsStore && typeof unsubscribeSettingsStore === 'function') {
          return;
        }
        detachSettingsGuard();
        guardedSettingsStore = settingsStore;
        if (typeof settingsStore.subscribe === 'function') {
          unsubscribeSettingsStore = settingsStore.subscribe(() => {
            if (!state || state.panelKind !== PANEL_KIND_SETTINGS_SECTION || !state.panel) return;
            const currentMatched = findMatchingSettingsSectionId(ctx, state.panel);
            if (!currentMatched) return;
            ensureSettingsSectionOpen(settingsStore, currentMatched);
          });
        }
      };

      const trySelectTargetPanel = () => {
        syncEmbedModeAttribute(state);
        if (!state || !state.panel) {
          closeSettingsShellIfOpen();
          markReady();
          return true;
        }
        if (state.panelKind === PANEL_KIND_SETTINGS_SECTION) {
          const matchedSectionId = findMatchingSettingsSectionId(ctx, state.panel);
          const settingsStore = resolveSettingsShellStore(ctx);
          if (!matchedSectionId || !settingsStore) return false;
          try {
            attachSettingsGuard(settingsStore);
            ensureSettingsSectionOpen(settingsStore, matchedSectionId);
            markReady();
            return true;
          } catch {
            return false;
          }
        }
        closeSettingsShellIfOpen();
        const matchedKey = findMatchingMainPanelKey(ctx, state.panel);
        if (!matchedKey) return false;
        try {
          const activeId = ctx.layout.panelInfo?.getSnapshot?.()?.activePanelId ?? null;
          if (activeId !== matchedKey) {
            ctx.layout.selectPanel(matchedKey);
          }
          markReady();
          return true;
        } catch {
          return false;
        }
      };

      // Optional service injections for theme and locale sync.
      if (typeof ctx.inject === 'function') {
        ctx.inject(['theme'], (themeCtx) => {
          themeService = themeCtx.theme;
          syncThemeAndLocale(state);
          return () => {
            themeService = null;
          };
        });
        ctx.inject(['locale'], (localeCtx) => {
          localeService = localeCtx.locale;
          syncThemeAndLocale(state);
          return () => {
            localeService = null;
          };
        });
      }

      const handleHashChange = () => {
        const next = readEmbedState();
        if (!next) return;
        const targetChanged =
          !state || next.panel !== state.panel || next.panelKind !== state.panelKind;
        state = next;
        syncEmbedModeAttribute(state);
        syncThemeAndLocale(state);
        if (targetChanged && state.panel) {
          const alreadyMatched = trySelectTargetPanel();
          if (!alreadyMatched) {
            document.documentElement.dataset.lobsterEmbedReady = 'false';
            armReadyFallback();
          }
        } else {
          trySelectTargetPanel();
        }
      };

      ctx.effect(() => {
        const offMain = ctx.slots.subscribe('main', () => {
          trySelectTargetPanel();
        });
        const offSidebar = ctx.slots.subscribe('sidebar.panellist', () => {
          trySelectTargetPanel();
        });
        const offSidebarSettings = ctx.slots.subscribe('sidebar.settings', () => {
          trySelectTargetPanel();
        });
        const offSettingsSection = ctx.slots.subscribe('settings.section', () => {
          trySelectTargetPanel();
        });
        window.addEventListener('hashchange', handleHashChange);

        if (!trySelectTargetPanel()) {
          armReadyFallback();
        }

        return () => {
          if (readyTimer !== null) {
            window.clearTimeout(readyTimer);
            readyTimer = null;
          }
          detachSettingsGuard();
          window.removeEventListener('hashchange', handleHashChange);
          offSettingsSection();
          offSidebarSettings();
          offSidebar();
          offMain();
          removeStyles();
        };
      }, 'lobster-embed-shell: chromeless panel host');
    };

    return module.exports;
  },
});
