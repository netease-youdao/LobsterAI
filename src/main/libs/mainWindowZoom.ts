import type { BrowserWindow, Input, Point } from 'electron';

import { WindowIpcChannel, type WindowZoomChangedPayload } from '../../shared/app/constants';

/** Zoom steps of the main window, as in Chromium's page zoom. */
export const MAIN_WINDOW_ZOOM_FACTORS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_MAIN_WINDOW_ZOOM_FACTOR = 1;

export const MainWindowZoomAction = {
  In: 'in',
  Out: 'out',
  Reset: 'reset',
} as const;
export type MainWindowZoomAction = typeof MainWindowZoomAction[keyof typeof MainWindowZoomAction];

/** Where the macOS traffic lights sit at 100%. */
export const MAC_TRAFFIC_LIGHT_POSITION: Point = { x: 12, y: 20 };
/** Half the height of the traffic light buttons, to keep their center on the zoomed title bar's center. */
const MAC_TRAFFIC_LIGHT_HALF_HEIGHT = 7;

// getZoomFactor() reads back a zoom level, so 0.67 can come back as 0.67000001.
const ZOOM_FACTOR_EPSILON = 0.005;
// Some wheels and touchpads fire several zoom requests per notch; one step per interval keeps zooming controllable.
const WHEEL_ZOOM_INTERVAL_MS = 80;

const ZOOM_IN_KEYS = new Set(['=', '+']);
const ZOOM_OUT_KEYS = new Set(['-', '_']);
const ZOOM_RESET_KEYS = new Set(['0']);
const NUMPAD_ZOOM_IN_CODE = 'NumpadAdd';
const NUMPAD_ZOOM_OUT_CODE = 'NumpadSubtract';

export type ZoomShortcutInput = Pick<Input, 'type' | 'key' | 'code' | 'control' | 'meta' | 'alt'>;

/** Cmd (macOS) or Ctrl (elsewhere) with =/+, -/_ or 0, the same keys as browser zoom. AltGr (Ctrl+Alt) never zooms. */
export const resolveZoomShortcut = (input: ZoomShortcutInput, isMac: boolean): MainWindowZoomAction | null => {
  if (input.type !== 'keyDown' || input.alt) return null;
  const hasModifier = isMac ? input.meta && !input.control : input.control && !input.meta;
  if (!hasModifier) return null;
  if (ZOOM_IN_KEYS.has(input.key) || input.code === NUMPAD_ZOOM_IN_CODE) return MainWindowZoomAction.In;
  if (ZOOM_OUT_KEYS.has(input.key) || input.code === NUMPAD_ZOOM_OUT_CODE) return MainWindowZoomAction.Out;
  if (ZOOM_RESET_KEYS.has(input.key)) return MainWindowZoomAction.Reset;
  return null;
};

export const getNextZoomFactor = (current: number, action: MainWindowZoomAction): number => {
  if (action === MainWindowZoomAction.Reset || !Number.isFinite(current) || current <= 0) {
    return DEFAULT_MAIN_WINDOW_ZOOM_FACTOR;
  }
  const factors = MAIN_WINDOW_ZOOM_FACTORS;
  if (action === MainWindowZoomAction.In) {
    return factors.find(factor => factor > current + ZOOM_FACTOR_EPSILON) ?? factors[factors.length - 1];
  }
  return [...factors].reverse().find(factor => factor < current - ZOOM_FACTOR_EPSILON) ?? factors[0];
};

/** The traffic lights are native and keep their size; moving them keeps them centered on the zoomed title bar. */
export const getMacTrafficLightPosition = (zoomFactor: number): Point => ({
  x: MAC_TRAFFIC_LIGHT_POSITION.x,
  y: Math.max(0, Math.round(
    (MAC_TRAFFIC_LIGHT_POSITION.y + MAC_TRAFFIC_LIGHT_HALF_HEIGHT) * zoomFactor - MAC_TRAFFIC_LIGHT_HALF_HEIGHT,
  )),
});

type RendererCoordinates = Partial<Record<'x' | 'y' | 'width' | 'height', unknown>>;

/**
 * The renderer measures in CSS pixels, while native views, menus and capturePage take window pixels. They
 * differ by the page zoom, so coordinates sent from the main window are scaled before native use.
 */
export function scaleRendererCoordinates<T extends RendererCoordinates>(value: T, zoomFactor: number): T;
export function scaleRendererCoordinates<T extends RendererCoordinates>(value: T | undefined, zoomFactor: number): T | undefined;
export function scaleRendererCoordinates<T extends RendererCoordinates>(value: T | undefined, zoomFactor: number): T | undefined {
  if (!value || !Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor === 1) return value;
  const scaled: Record<string, unknown> = { ...value };
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const coordinate = value[key];
    if (typeof coordinate === 'number' && Number.isFinite(coordinate)) scaled[key] = coordinate * zoomFactor;
  }
  return scaled as T;
}

/**
 * Browser-style zoom for the whole main window: Cmd/Ctrl + =, -, 0 and Cmd/Ctrl + mouse wheel.
 *
 * The preload sets the page zoom once when each page loads. That makes this a per-window zoom: Chromium
 * neither shares it with other windows of the same origin nor saves it, so a restart or reload starts at 100%.
 */
export const installMainWindowZoom = (window: BrowserWindow, { isMac }: { isMac: boolean }): void => {
  const { webContents } = window;
  let lastWheelZoomAt = 0;

  const syncWindowChrome = (zoomFactor: number): void => {
    if (isMac && !window.isDestroyed()) window.setWindowButtonPosition(getMacTrafficLightPosition(zoomFactor));
  };

  const applyZoom = (action: MainWindowZoomAction): void => {
    if (window.isDestroyed()) return;
    const current = webContents.getZoomFactor();
    const next = getNextZoomFactor(current, action);
    if (Math.abs(next - current) > ZOOM_FACTOR_EPSILON) {
      webContents.setZoomFactor(next);
      syncWindowChrome(next);
      console.debug(`[WindowZoom] zoom factor ${current.toFixed(2)} -> ${next}`);
    }
    // Sent at the limits too, so the key press visibly answers.
    const payload: WindowZoomChangedPayload = { zoomFactor: next };
    webContents.send(WindowIpcChannel.ZoomChanged, payload);
  };

  // Handling the keys here also keeps the macOS default View menu from zooming the window a second time.
  webContents.on('before-input-event', (event, input) => {
    const action = resolveZoomShortcut(input, isMac);
    if (!action) return;
    event.preventDefault();
    applyZoom(action);
  });

  webContents.on('zoom-changed', (_event, direction) => {
    const now = Date.now();
    if (now - lastWheelZoomAt < WHEEL_ZOOM_INTERVAL_MS) return;
    lastWheelZoomAt = now;
    applyZoom(direction === 'in' ? MainWindowZoomAction.In : MainWindowZoomAction.Out);
  });

  // A reload starts the page at 100% again, so the traffic lights go back too.
  webContents.on('did-finish-load', () => {
    if (!window.isDestroyed()) syncWindowChrome(webContents.getZoomFactor());
  });
};
