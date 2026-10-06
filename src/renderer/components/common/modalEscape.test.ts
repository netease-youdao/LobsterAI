import { afterEach, describe, expect, test } from 'vitest';

import {
  createModalEscapeLayerId,
  isDismissEscapeEvent,
  isTopModalEscapeLayer,
  registerModalEscapeLayer,
  unregisterModalEscapeLayer,
} from './modalEscape';

const openedLayers: number[] = [];

const openLayer = (): number => {
  const layerId = createModalEscapeLayerId();
  registerModalEscapeLayer(layerId);
  openedLayers.push(layerId);
  return layerId;
};

afterEach(() => {
  while (openedLayers.length > 0) {
    unregisterModalEscapeLayer(openedLayers.pop() as number);
  }
});

describe('modal escape layers', () => {
  test('a single open layer is the top layer', () => {
    const layerId = openLayer();
    expect(isTopModalEscapeLayer(layerId)).toBe(true);
  });

  test('an unregistered layer is never the top layer', () => {
    const layerId = createModalEscapeLayerId();
    expect(isTopModalEscapeLayer(layerId)).toBe(false);
  });

  test('a nested layer takes over from the panel behind it', () => {
    const panel = openLayer();
    const nested = openLayer();

    expect(isTopModalEscapeLayer(panel)).toBe(false);
    expect(isTopModalEscapeLayer(nested)).toBe(true);
  });

  test('closing the nested layer hands control back to the panel', () => {
    const panel = openLayer();
    const nested = openLayer();

    unregisterModalEscapeLayer(nested);
    openedLayers.pop();

    expect(isTopModalEscapeLayer(panel)).toBe(true);
  });

  test('ids rank by creation order, not by registration order', () => {
    // Mount effects run child-first, so the nested layer can register first.
    const panel = createModalEscapeLayerId();
    const nested = createModalEscapeLayerId();
    registerModalEscapeLayer(nested);
    registerModalEscapeLayer(panel);
    openedLayers.push(panel, nested);

    expect(isTopModalEscapeLayer(nested)).toBe(true);
    expect(isTopModalEscapeLayer(panel)).toBe(false);
  });
});

describe('isDismissEscapeEvent', () => {
  test('accepts a plain Escape press', () => {
    expect(isDismissEscapeEvent({ key: 'Escape' })).toBe(true);
  });

  test('ignores other keys', () => {
    expect(isDismissEscapeEvent({ key: 'Enter' })).toBe(false);
  });

  test('ignores Escape already handled by an inner control', () => {
    expect(isDismissEscapeEvent({ key: 'Escape', defaultPrevented: true })).toBe(false);
  });

  test('ignores Escape during IME composition', () => {
    expect(isDismissEscapeEvent({ key: 'Escape', isComposing: true })).toBe(false);
    expect(isDismissEscapeEvent({ key: 'Escape', keyCode: 229 })).toBe(false);
  });
});
