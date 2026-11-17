import { describe, expect, test } from 'vitest';

import {
  getMacTrafficLightPosition,
  getNextZoomFactor,
  MAC_TRAFFIC_LIGHT_POSITION,
  MAIN_WINDOW_ZOOM_FACTORS,
  MainWindowZoomAction,
  resolveZoomShortcut,
  scaleRendererCoordinates,
  type ZoomShortcutInput,
} from './mainWindowZoom';

const keyDown = (overrides: Partial<ZoomShortcutInput>): ZoomShortcutInput => ({
  type: 'keyDown',
  key: '',
  code: '',
  control: false,
  meta: false,
  alt: false,
  ...overrides,
});

describe('resolveZoomShortcut', () => {
  test('maps Ctrl on Windows and Cmd on macOS to browser zoom keys', () => {
    expect(resolveZoomShortcut(keyDown({ key: '=', control: true }), false)).toBe(MainWindowZoomAction.In);
    expect(resolveZoomShortcut(keyDown({ key: '+', control: true }), false)).toBe(MainWindowZoomAction.In);
    expect(resolveZoomShortcut(keyDown({ key: '-', control: true }), false)).toBe(MainWindowZoomAction.Out);
    expect(resolveZoomShortcut(keyDown({ key: '0', control: true }), false)).toBe(MainWindowZoomAction.Reset);
    expect(resolveZoomShortcut(keyDown({ key: '=', meta: true }), true)).toBe(MainWindowZoomAction.In);
    expect(resolveZoomShortcut(keyDown({ key: '_', meta: true }), true)).toBe(MainWindowZoomAction.Out);
    expect(resolveZoomShortcut(keyDown({ key: '0', meta: true }), true)).toBe(MainWindowZoomAction.Reset);
  });

  test('accepts the numpad plus and minus keys', () => {
    expect(resolveZoomShortcut(keyDown({ key: '+', code: 'NumpadAdd', control: true }), false)).toBe(MainWindowZoomAction.In);
    expect(resolveZoomShortcut(keyDown({ key: '-', code: 'NumpadSubtract', control: true }), false)).toBe(MainWindowZoomAction.Out);
  });

  test('ignores other modifiers, AltGr, key up and unrelated keys', () => {
    expect(resolveZoomShortcut(keyDown({ key: '=' }), false)).toBeNull();
    expect(resolveZoomShortcut(keyDown({ key: '=', meta: true }), false)).toBeNull();
    expect(resolveZoomShortcut(keyDown({ key: '=', control: true }), true)).toBeNull();
    expect(resolveZoomShortcut(keyDown({ key: '=', control: true, alt: true }), false)).toBeNull();
    expect(resolveZoomShortcut(keyDown({ type: 'keyUp', key: '=', control: true }), false)).toBeNull();
    expect(resolveZoomShortcut(keyDown({ key: '1', control: true }), false)).toBeNull();
  });
});

describe('getNextZoomFactor', () => {
  test('steps through the zoom levels', () => {
    expect(getNextZoomFactor(1, MainWindowZoomAction.In)).toBe(1.1);
    expect(getNextZoomFactor(1, MainWindowZoomAction.Out)).toBe(0.9);
    expect(getNextZoomFactor(0.67, MainWindowZoomAction.Out)).toBe(0.5);
  });

  test('tolerates read-back noise and values between levels', () => {
    expect(getNextZoomFactor(0.6700000001, MainWindowZoomAction.In)).toBe(0.75);
    expect(getNextZoomFactor(0.6699999, MainWindowZoomAction.Out)).toBe(0.5);
    expect(getNextZoomFactor(1.3, MainWindowZoomAction.In)).toBe(1.5);
    expect(getNextZoomFactor(1.3, MainWindowZoomAction.Out)).toBe(1.25);
  });

  test('stays at the limits and resets to 100%', () => {
    const min = MAIN_WINDOW_ZOOM_FACTORS[0];
    const max = MAIN_WINDOW_ZOOM_FACTORS[MAIN_WINDOW_ZOOM_FACTORS.length - 1];
    expect(getNextZoomFactor(min, MainWindowZoomAction.Out)).toBe(min);
    expect(getNextZoomFactor(max, MainWindowZoomAction.In)).toBe(max);
    expect(getNextZoomFactor(1.75, MainWindowZoomAction.Reset)).toBe(1);
    expect(getNextZoomFactor(Number.NaN, MainWindowZoomAction.In)).toBe(1);
  });
});

describe('getMacTrafficLightPosition', () => {
  test('keeps the configured position at 100% and follows the title bar center when zoomed', () => {
    expect(getMacTrafficLightPosition(1)).toEqual(MAC_TRAFFIC_LIGHT_POSITION);
    expect(getMacTrafficLightPosition(0.5)).toEqual({ x: 12, y: 7 });
    expect(getMacTrafficLightPosition(2)).toEqual({ x: 12, y: 47 });
  });
});

describe('scaleRendererCoordinates', () => {
  test('scales rect and point fields and keeps the rest', () => {
    expect(scaleRendererCoordinates({ x: 10, y: 20, width: 100, height: 50 }, 1.5))
      .toEqual({ x: 15, y: 30, width: 150, height: 75 });
    expect(scaleRendererCoordinates({ x: 100, y: 40, darkMode: true, sessionId: 's1' }, 0.5))
      .toEqual({ x: 50, y: 20, darkMode: true, sessionId: 's1' });
  });

  test('returns the input unchanged at 100%, for invalid factors and for missing values', () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    expect(scaleRendererCoordinates(rect, 1)).toBe(rect);
    expect(scaleRendererCoordinates(rect, 0)).toBe(rect);
    expect(scaleRendererCoordinates(rect, Number.NaN)).toBe(rect);
    expect(scaleRendererCoordinates(undefined, 1.5)).toBeUndefined();
    expect(scaleRendererCoordinates({ x: undefined, y: 3 }, 2)).toEqual({ x: undefined, y: 6 });
  });
});
