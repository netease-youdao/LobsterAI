import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { FontPreferences } from '../config';
import { applyTypographyPreferences } from './typography';

const createMockDocument = () => {
  const properties = new Map<string, string>();
  const mockDocument = {
    documentElement: {
      style: {
        setProperty: (name: string, value: string) => {
          properties.set(name, value);
        },
      },
    },
  };
  return { mockDocument, properties };
};

describe('applyTypographyPreferences', () => {
  const originalDocument = globalThis.document;

  afterEach(() => {
    if (originalDocument === undefined) {
      Reflect.deleteProperty(globalThis, 'document');
    } else {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
    }
  });

  test('keeps sidebar tasks matched with compact nav at 14px and meta at integer 12px for the default UI size', () => {
    const { mockDocument, properties } = createMockDocument();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: mockDocument,
    });

    applyTypographyPreferences({
      uiFontSize: FontPreferences.UiFontSizeDefault,
      codeFontSize: FontPreferences.CodeFontSizeDefault,
    });

    expect(properties.get('--lobster-text-sidebarCompact')).toBe('14px');
    expect(properties.get('--lobster-text-sidebarTask')).toBe('14px');
    expect(properties.get('--lobster-text-sidebarMeta')).toBe('12px');

    const indexCss = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    for (const [name, value] of properties.entries()) {
      expect(indexCss).toContain(`${name}: ${value};`);
    }
  });

  test('keeps sidebar meta an integer 12px at the 14px baseline to avoid Windows half-pixel blur', () => {
    const { mockDocument, properties } = createMockDocument();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: mockDocument,
    });

    applyTypographyPreferences({
      uiFontSize: 14,
      codeFontSize: FontPreferences.CodeFontSizeDefault,
    });

    expect(properties.get('--lobster-text-sidebarCompact')).toBe('13px');
    expect(properties.get('--lobster-text-sidebarTask')).toBe('13px');
    expect(properties.get('--lobster-text-sidebarMeta')).toBe('12px');
  });
});
