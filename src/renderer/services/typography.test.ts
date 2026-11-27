import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { FontPreferences } from '../config';
import {
  applyTypographyPreferences,
  commitFontSizeDraft,
  parseFontSizeDraft,
  resolveTypographyPreferences,
  stepFontSize,
} from './typography';

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

  test('scales typography smoothly up to the 20px UI upper bound', () => {
    const { mockDocument, properties } = createMockDocument();
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: mockDocument,
    });

    applyTypographyPreferences({
      uiFontSize: FontPreferences.UiFontSizeMax,
      codeFontSize: FontPreferences.CodeFontSizeMax,
    });

    expect(properties.get('--lobster-ui-font-size')).toBe('20px');
    expect(properties.get('--lobster-code-font-size')).toBe('24px');
    expect(properties.get('--lobster-text-sm')).toBe('20px');
    expect(properties.get('--lobster-text-markdown')).toBe('20px');
    expect(properties.get('--lobster-text-sidebarCompact')).toBe('19px');
    expect(properties.get('--lobster-text-sidebarTask')).toBe('19px');
    expect(properties.get('--lobster-text-sidebarMeta')).toBe('16px');
  });
});

describe('resolveTypographyPreferences', () => {
  test('enforces the updated UI (12-20px) and code (10-24px) bounds', () => {
    expect(resolveTypographyPreferences({ uiFontSize: 11, codeFontSize: 8 })).toEqual({
      uiFontSize: 12,
      codeFontSize: 10,
    });
    expect(resolveTypographyPreferences({ uiFontSize: 18, codeFontSize: 20 })).toEqual({
      uiFontSize: 18,
      codeFontSize: 20,
    });
    expect(resolveTypographyPreferences({ uiFontSize: 24, codeFontSize: 32 })).toEqual({
      uiFontSize: 20,
      codeFontSize: 24,
    });
  });
});

describe('font size input helpers', () => {
  test('parseFontSizeDraft skips clamping intermediate typing states while previewing in-range values', () => {
    expect(parseFontSizeDraft('', 12, 20)).toBeNull();
    expect(parseFontSizeDraft('1', 12, 20)).toBeNull();
    expect(parseFontSizeDraft('2', 12, 20)).toBeNull();
    expect(parseFontSizeDraft('18', 12, 20)).toBe(18);
    expect(parseFontSizeDraft(' 20 ', 12, 20)).toBe(20);
    expect(parseFontSizeDraft('25', 12, 20)).toBeNull();
    expect(parseFontSizeDraft('18px', 12, 20)).toBeNull();
  });

  test('commitFontSizeDraft clamps out-of-range numbers and restores fallback on invalid drafts', () => {
    expect(commitFontSizeDraft('', 15, 12, 20)).toBe(15);
    expect(commitFontSizeDraft('abc', 15, 12, 20)).toBe(15);
    expect(commitFontSizeDraft('8', 15, 12, 20)).toBe(12);
    expect(commitFontSizeDraft('-5', 15, 12, 20)).toBe(12);
    expect(commitFontSizeDraft('28', 15, 12, 20)).toBe(20);
    expect(commitFontSizeDraft('17.6', 15, 12, 20)).toBe(18);
  });

  test('stepFontSize steps within bounds without exceeding limits', () => {
    expect(stepFontSize(15, 1, 12, 20)).toBe(16);
    expect(stepFontSize(20, 1, 12, 20)).toBe(20);
    expect(stepFontSize(12, -1, 12, 20)).toBe(12);
    expect(stepFontSize(14, -1, 10, 24)).toBe(13);
  });
});
