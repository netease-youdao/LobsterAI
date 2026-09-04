import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  nativeTheme,
} from 'electron';

import {
  AgentBrowserHostMenuAction,
  type AgentBrowserHostMenuAction as AgentBrowserHostMenuActionValue,
  type AgentBrowserHostMenuResponse,
  AgentBrowserZoom,
} from '../../shared/browserWebAccess/constants';
import { t } from '../i18n';

const AGENT_BROWSER_MENU_PROTOCOL = 'lobster-agent-browser-menu:';
const AGENT_BROWSER_MENU_HOST = 'action';
const AGENT_BROWSER_MENU_WIDTH = 224;
const AGENT_BROWSER_MENU_HEIGHT = 208;
const AGENT_BROWSER_MENU_BLUR_GUARD_MS = 100;

type AgentBrowserHostZoomMenuAction =
  | typeof AgentBrowserHostMenuAction.ZoomOut
  | typeof AgentBrowserHostMenuAction.ResetZoom
  | typeof AgentBrowserHostMenuAction.ZoomIn;

interface AgentBrowserHostMenuOptions {
  targetWindow: BrowserWindow;
  position?: {
    x?: number;
    y?: number;
  };
  hasPage: boolean;
  zoomFactor?: number;
  darkMode?: boolean;
  onZoomAction: (action: AgentBrowserHostZoomMenuAction) => Promise<number>;
}

interface AgentBrowserHostMenuViewOptions {
  hasPage: boolean;
  zoomFactor: number;
  darkMode: boolean;
}

let activeMenuWindow: BrowserWindow | null = null;

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const normalizeZoomFactor = (factor: number | undefined): number => (
  typeof factor === 'number' && Number.isFinite(factor)
    ? Math.min(AgentBrowserZoom.Max, Math.max(AgentBrowserZoom.Min, factor))
    : AgentBrowserZoom.Default
);

const actionUrl = (action: AgentBrowserHostMenuActionValue): string => (
  `${AGENT_BROWSER_MENU_PROTOCOL}//${AGENT_BROWSER_MENU_HOST}/${action}`
);

const isZoomAction = (
  action: AgentBrowserHostMenuActionValue,
): action is AgentBrowserHostZoomMenuAction => (
  action === AgentBrowserHostMenuAction.ZoomOut
  || action === AgentBrowserHostMenuAction.ResetZoom
  || action === AgentBrowserHostMenuAction.ZoomIn
);

export const parseAgentBrowserHostMenuActionUrl = (
  value: string,
): AgentBrowserHostMenuActionValue | undefined => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== AGENT_BROWSER_MENU_PROTOCOL || parsed.hostname !== AGENT_BROWSER_MENU_HOST) {
      return undefined;
    }
    const action = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return Object.values(AgentBrowserHostMenuAction).includes(action as AgentBrowserHostMenuActionValue)
      ? action as AgentBrowserHostMenuActionValue
      : undefined;
  } catch {
    return undefined;
  }
};

const renderAction = (
  label: string,
  action: AgentBrowserHostMenuActionValue,
  enabled = true,
): string => enabled
  ? `<a class="menu-item" role="menuitem" draggable="false" href="${escapeHtml(actionUrl(action))}">${escapeHtml(label)}</a>`
  : `<span class="menu-item disabled" role="menuitem" aria-disabled="true">${escapeHtml(label)}</span>`;

const renderZoomButton = (
  id: string,
  label: string,
  action: AgentBrowserHostZoomMenuAction,
  disabled: boolean,
  extraClass = '',
): string => `<a id="${id}" class="zoom-button ${extraClass}${disabled ? ' disabled' : ''}" role="button" draggable="false" aria-label="${escapeHtml(label)}" aria-disabled="${disabled}"${disabled ? '' : ` href="${escapeHtml(actionUrl(action))}"`}>${escapeHtml(label)}</a>`;

export const buildAgentBrowserHostMenuHtml = ({
  hasPage,
  zoomFactor,
  darkMode,
}: AgentBrowserHostMenuViewOptions): string => {
  const normalizedZoomFactor = normalizeZoomFactor(zoomFactor);
  const zoomPercent = `${Math.round(normalizedZoomFactor * 100)}%`;
  const colors = darkMode
    ? {
        background: '#24272f',
        border: '#30343e',
        control: '#12151c',
        hover: '#30343d',
        text: '#f4f5f7',
        muted: '#9399a6',
      }
    : {
        background: '#ffffff',
        border: '#d9dce3',
        control: '#f2f3f6',
        hover: '#eef0f4',
        text: '#20232a',
        muted: '#777e8c',
      };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <meta name="color-scheme" content="${darkMode ? 'dark' : 'light'}">
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { color: ${colors.text}; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px; user-select: none; }
    .menu { width: 100%; height: 100%; padding: 8px; border: 1px solid ${colors.border}; border-radius: 9px; background: ${colors.background}; box-shadow: 0 10px 30px rgba(0, 0, 0, .32); }
    .menu-item { display: flex; height: 32px; align-items: center; border-radius: 6px; padding: 0 8px; color: ${colors.text}; text-decoration: none; outline: none; }
    .menu-item:hover, .menu-item:focus-visible { background: ${colors.hover}; }
    .menu-item.disabled { color: ${colors.muted}; opacity: .5; }
    .separator { height: 1px; margin: 4px 6px; background: ${colors.border}; }
    .zoom-row { display: flex; height: 36px; align-items: center; gap: 8px; padding: 0 8px; }
    .zoom-label { min-width: 0; flex: 1; color: ${colors.muted}; }
    .zoom-controls { display: flex; height: 28px; flex: none; overflow: hidden; border: 1px solid ${colors.border}; border-radius: 6px; background: ${colors.control}; }
    .zoom-button { display: flex; width: 28px; height: 100%; align-items: center; justify-content: center; color: ${colors.text}; text-decoration: none; outline: none; }
    .zoom-button.value { width: 56px; border-right: 1px solid ${colors.border}; border-left: 1px solid ${colors.border}; font-weight: 500; }
    .zoom-button:hover, .zoom-button:focus-visible { background: ${colors.hover}; }
    .zoom-button.disabled { color: ${colors.muted}; opacity: .4; pointer-events: none; }
  </style>
</head>
<body>
  <div class="menu" role="menu">
    ${renderAction(t('agentBrowserMenuScreenshot'), AgentBrowserHostMenuAction.CaptureScreenshot, hasPage)}
    <div class="separator"></div>
    ${renderAction(t('agentBrowserMenuNewBlankPage'), AgentBrowserHostMenuAction.NewBlankPage)}
    <div class="separator"></div>
    <div class="zoom-row">
      <span class="zoom-label">${escapeHtml(t('agentBrowserMenuZoom'))}</span>
      <div class="zoom-controls">
        ${renderZoomButton('zoom-out', '−', AgentBrowserHostMenuAction.ZoomOut, !hasPage || normalizedZoomFactor <= AgentBrowserZoom.Min)}
        ${renderZoomButton('zoom-value', zoomPercent, AgentBrowserHostMenuAction.ResetZoom, !hasPage, 'value')}
        ${renderZoomButton('zoom-in', '+', AgentBrowserHostMenuAction.ZoomIn, !hasPage || normalizedZoomFactor >= AgentBrowserZoom.Max)}
      </div>
    </div>
    <div class="separator"></div>
    ${renderAction(t('agentBrowserMenuClearCookies'), AgentBrowserHostMenuAction.ClearCookies)}
    ${renderAction(t('agentBrowserMenuClearCache'), AgentBrowserHostMenuAction.ClearCache)}
  </div>
</body>
</html>`;
};

const buildZoomUiUpdateScript = (factor: number): string => {
  const normalizedFactor = normalizeZoomFactor(factor);
  const updateButton = (
    id: string,
    action: AgentBrowserHostZoomMenuAction,
    disabled: boolean,
  ): string => `update(${JSON.stringify(id)}, ${JSON.stringify(actionUrl(action))}, ${disabled});`;
  return `(() => {
    const update = (id, href, disabled) => {
      const element = document.getElementById(id);
      if (!element) return;
      element.classList.toggle('disabled', disabled);
      element.setAttribute('aria-disabled', String(disabled));
      if (disabled) element.removeAttribute('href'); else element.setAttribute('href', href);
    };
    const value = document.getElementById('zoom-value');
    if (value) value.textContent = ${JSON.stringify(`${Math.round(normalizedFactor * 100)}%`)};
    ${updateButton('zoom-out', AgentBrowserHostMenuAction.ZoomOut, normalizedFactor <= AgentBrowserZoom.Min)}
    ${updateButton('zoom-value', AgentBrowserHostMenuAction.ResetZoom, false)}
    ${updateButton('zoom-in', AgentBrowserHostMenuAction.ZoomIn, normalizedFactor >= AgentBrowserZoom.Max)}
  })();`;
};

const resolveMenuWindowOptions = (
  targetWindow: BrowserWindow,
  position?: { x?: number; y?: number },
): BrowserWindowConstructorOptions => {
  const targetBounds = targetWindow.getContentBounds();
  const width = Math.min(AGENT_BROWSER_MENU_WIDTH, Math.max(1, targetBounds.width));
  const height = Math.min(AGENT_BROWSER_MENU_HEIGHT, Math.max(1, targetBounds.height));
  const localX = Math.max(0, Math.min(
    Math.round(position?.x ?? 0),
    Math.max(0, targetBounds.width - width),
  ));
  const localY = Math.max(0, Math.min(
    Math.round(position?.y ?? 0),
    Math.max(0, targetBounds.height - height),
  ));
  return {
    parent: targetWindow,
    x: targetBounds.x + localX,
    y: targetBounds.y + localY,
    width,
    height,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      spellcheck: false,
    },
  };
};

export const showAgentBrowserHostMenu = ({
  targetWindow,
  position,
  hasPage,
  zoomFactor: requestedZoomFactor,
  darkMode,
  onZoomAction,
}: AgentBrowserHostMenuOptions): Promise<AgentBrowserHostMenuResponse> => {
  if (activeMenuWindow && !activeMenuWindow.isDestroyed()) activeMenuWindow.close();

  return new Promise(resolve => {
    let menuWindow: BrowserWindow;
    let selectedAction: AgentBrowserHostMenuActionValue | undefined;
    let finalError: string | undefined;
    let currentZoomFactor = normalizeZoomFactor(requestedZoomFactor);
    let allowBlurClose = false;
    let zoomActionQueue = Promise.resolve();

    try {
      menuWindow = new BrowserWindow(resolveMenuWindowOptions(targetWindow, position));
      activeMenuWindow = menuWindow;
      menuWindow.setMenuBarVisibility(false);
      menuWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    } catch (error) {
      console.error('[AgentBrowserHost] Failed to create browser menu window:', error);
      resolve({ success: false, error: t('agentBrowserMenuOpenFailed') });
      return;
    }

    const closeMenu = (): void => {
      if (!menuWindow.isDestroyed()) menuWindow.close();
    };
    const closeParentListener = (): void => closeMenu();
    targetWindow.once('closed', closeParentListener);

    menuWindow.on('closed', () => {
      targetWindow.removeListener('closed', closeParentListener);
      if (activeMenuWindow === menuWindow) activeMenuWindow = null;
      resolve(finalError
        ? { success: false, error: finalError }
        : {
            success: true,
            zoomFactor: currentZoomFactor,
            ...(selectedAction ? { action: selectedAction } : {}),
          });
    });
    menuWindow.on('blur', () => {
      if (allowBlurClose) closeMenu();
    });
    menuWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    });
    menuWindow.webContents.on('will-navigate', (event, url) => {
      const action = parseAgentBrowserHostMenuActionUrl(url);
      if (!action) return;
      event.preventDefault();

      if (!isZoomAction(action)) {
        selectedAction = action;
        closeMenu();
        return;
      }

      zoomActionQueue = zoomActionQueue.then(async () => {
        if (menuWindow.isDestroyed()) return;
        try {
          currentZoomFactor = normalizeZoomFactor(await onZoomAction(action));
          if (!menuWindow.isDestroyed()) {
            await menuWindow.webContents.executeJavaScript(
              buildZoomUiUpdateScript(currentZoomFactor),
              true,
            );
          }
        } catch (error) {
          console.error('[AgentBrowserHost] Failed to apply browser menu zoom:', error);
          finalError = t('agentBrowserZoomFailed');
          closeMenu();
        }
      });
    });

    const html = buildAgentBrowserHostMenuHtml({
      hasPage,
      zoomFactor: currentZoomFactor,
      darkMode: darkMode ?? nativeTheme.shouldUseDarkColors,
    });
    void menuWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`).then(() => {
      if (menuWindow.isDestroyed()) return;
      menuWindow.show();
      menuWindow.focus();
      setTimeout(() => {
        allowBlurClose = true;
      }, AGENT_BROWSER_MENU_BLUR_GUARD_MS);
    }).catch(error => {
      console.error('[AgentBrowserHost] Failed to load browser menu window:', error);
      finalError = t('agentBrowserMenuOpenFailed');
      closeMenu();
    });
  });
};
