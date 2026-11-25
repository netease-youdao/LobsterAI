window.__ModuleLoader__.load({
  id: '@lobsterai/dsh-embed-shell',
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;

    const EMBED_STORAGE_KEY = 'lobsterai:dsh-embed-state';
    const STYLE_ELEMENT_ID = 'lobsterai-dsh-embed-shell-style';
    const FALLBACK_READY_TIMEOUT_MS = 4000;

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
        return { active: false, panel: '', theme: '', lang: '' };
      }
      if (flag === '1' || flag === 'true') {
        const state = {
          active: true,
          panel: (params.get('panel') || '').trim(),
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
        const existing = document.getElementById(STYLE_ELEMENT_ID);
        if (existing && existing.parentNode) {
          existing.parentNode.removeChild(existing);
        }
      };
    }

    function normalizePanelKey(value) {
      return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/^@[^/]+\//, '')
        .replace(/^dsh-/, '');
    }

    function findMatchingMainPanelKey(ctx, targetPanelId) {
      if (!targetPanelId || !ctx.slots) return null;
      const entries = typeof ctx.slots.entries === 'function'
        ? ctx.slots.entries('main')
        : (typeof ctx.slots.entriesOfSlot === 'function' ? ctx.slots.entriesOfSlot('main') : []);
      if (!Array.isArray(entries) || entries.length === 0) return null;

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

    exports.inject = ['slots', 'layout'];

    exports.apply = function apply(ctx) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return;

      let state = readEmbedState();
      if (!state) return;

      let readyTimer = null;
      let themeService = null;
      let localeService = null;

      const removeStyles = installEmbedStyles();
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

      const trySelectTargetPanel = () => {
        if (!state || !state.panel) {
          markReady();
          return true;
        }
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
        const panelChanged = !state || next.panel !== state.panel;
        state = next;
        syncThemeAndLocale(state);
        if (panelChanged && state.panel) {
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
        window.addEventListener('hashchange', handleHashChange);

        if (!trySelectTargetPanel()) {
          armReadyFallback();
        }

        return () => {
          if (readyTimer !== null) {
            window.clearTimeout(readyTimer);
            readyTimer = null;
          }
          window.removeEventListener('hashchange', handleHashChange);
          offSidebar();
          offMain();
          removeStyles();
        };
      }, 'lobster-embed-shell: chromeless panel host');
    };

    return module.exports;
  },
});
