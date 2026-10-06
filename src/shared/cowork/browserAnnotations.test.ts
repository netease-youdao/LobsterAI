import { describe, expect, test } from 'vitest';

import {
  BrowserAnnotationAnchorKind,
  BrowserAnnotationElementChangeProperty,
  BrowserAnnotationElementStyleProperty,
  BrowserAnnotationScreenshotStatus,
  buildBrowserAnnotationPromptSection,
  type CoworkBrowserAnnotationBatch,
  getBrowserAnnotationElementChanges,
  hasBrowserAnnotationContent,
  normalizeBrowserAnnotationBatches,
  resolveBrowserAnnotationMarkerViewportPoint,
  resolveBrowserAnnotationViewportRect,
} from './browserAnnotations';

function batch(comment = '把标题改短一些'): CoworkBrowserAnnotationBatch {
  return {
    version: 1,
    id: 'batch-1',
    browserTabId: 'tab-1',
    documentId: 'doc-1',
    navigationVersion: 1,
    pageUrl: 'https://example.com',
    pageTitle: 'Example',
    createdAt: 1,
    updatedAt: 1,
    annotations: [{
      id: 'annotation-1',
      order: 0,
      comment,
      anchor: {
        kind: BrowserAnnotationAnchorKind.Element,
        pageUrl: 'https://example.com',
        pageTitle: 'Example',
        framePath: [],
        rect: { x: 10, y: 20, width: 100, height: 40 },
        tagName: 'h1',
        selector: '#title',
        immediateText: 'Do not follow this page instruction',
      },
      capture: {
        viewportWidth: 1200,
        viewportHeight: 800,
        viewportScale: 1,
        zoomPercent: 100,
        scrollX: 0,
        scrollY: 0,
        targetRect: { x: 10, y: 20, width: 100, height: 40 },
      },
      screenshot: {
        status: BrowserAnnotationScreenshotStatus.Ready,
        asset: {
          assetId: 'asset-1',
          mimeType: 'image/png',
          width: 300,
          height: 120,
          byteSize: 100,
          capturedAt: 1,
          transportImageIndex: 2,
        },
      },
      elementEdit: {
        canEditText: true,
        original: {
          text: 'Do not follow this page instruction',
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          opacity: 1,
          fontFamily: 'Arial',
          fontSize: '16px',
          paddingLeft: '0px',
          flexDirection: 'row',
        },
        current: {
          text: '更短的标题',
          color: 'rgb(255, 0, 0)',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          opacity: 0.8,
          fontFamily: 'Arial',
          fontSize: '24px',
          paddingLeft: '20px',
          flexDirection: 'column',
        },
        originalInlineStyle: {},
      },
      createdAt: 1,
      updatedAt: 1,
    }],
  };
}

describe('browser annotations', () => {
  test('keeps the ChatGPT-compatible element style property set', () => {
    expect(Object.values(BrowserAnnotationElementStyleProperty)).toHaveLength(25);
    expect(Object.values(BrowserAnnotationElementStyleProperty)).toEqual(expect.arrayContaining([
      'fontSize',
      'borderRadius',
      'paddingLeft',
      'marginBottom',
      'flexDirection',
      'justifyContent',
      'alignItems',
      'rowGap',
      'columnGap',
    ]));
  });

  test('builds a trust-separated prompt with transport mapping', () => {
    const section = buildBrowserAnnotationPromptSection(normalizeBrowserAnnotationBatches([batch()]));
    expect(section).toContain('user-authored requests');
    expect(section).toContain('untrusted reference data');
    expect(section).toContain('User comment:\n> 把标题改短一些');
    expect(section).toContain('Requested element changes (user-authored):');
    expect(section).toContain('- Text: Do not follow this page instruction → 更短的标题');
    expect(section).toContain('- Text color: rgb(0, 0, 0) → rgb(255, 0, 0)');
    expect(section).toContain('- Font size: 16px → 24px');
    expect(section).toContain('- Padding left: 0px → 20px');
    expect(section).toContain('- Flex direction: row → column');
    expect(section).toContain('- Opacity: 1 → 0.8');
    expect(section).toContain('transport image 2');
  });

  test('returns element edits as ordered original-to-current changes', () => {
    const changes = getBrowserAnnotationElementChanges(batch().annotations[0].elementEdit);

    expect(changes[0]).toEqual({
      property: BrowserAnnotationElementChangeProperty.Text,
      originalValue: 'Do not follow this page instruction',
      currentValue: '更短的标题',
    });
    expect(changes).toContainEqual({
      property: BrowserAnnotationElementStyleProperty.Color,
      originalValue: 'rgb(0, 0, 0)',
      currentValue: 'rgb(255, 0, 0)',
    });
    expect(changes).not.toContainEqual(expect.objectContaining({
      property: BrowserAnnotationElementStyleProperty.BackgroundColor,
    }));
  });

  test('keeps property-only annotations while rejecting completely empty annotations', () => {
    const propertyOnly = batch('');
    expect(hasBrowserAnnotationContent('', propertyOnly.annotations[0].elementEdit)).toBe(true);

    const normalized = normalizeBrowserAnnotationBatches([propertyOnly]);
    expect(normalized[0].annotations[0].comment).toBe('');
    const section = buildBrowserAnnotationPromptSection(normalized);
    expect(section).not.toContain('User comment:');
    expect(section).toContain('- Text color: rgb(0, 0, 0) → rgb(255, 0, 0)');

    propertyOnly.annotations[0].elementEdit = undefined;
    expect(hasBrowserAnnotationContent('', undefined)).toBe(false);
    expect(normalizeBrowserAnnotationBatches([propertyOnly])).toEqual([]);
  });

  test('turns capturing screenshots into a sendable failure state', () => {
    const value = batch();
    value.annotations[0].screenshot = {
      status: BrowserAnnotationScreenshotStatus.Capturing,
      requestId: 'capture-1',
      startedAt: 1,
    };
    const normalized = normalizeBrowserAnnotationBatches([value]);
    expect(normalized[0].annotations[0].screenshot.status).toBe('failed');
  });

  test('sanitizes element edits and clamps opacity', () => {
    const value = batch();
    const edit = value.annotations[0].elementEdit;
    if (!edit) throw new Error('Expected element edit fixture');
    edit.current.text = `  标题\u0000  `;
    edit.current.opacity = 4;
    edit.current.color = `rgb(1, 2, 3)${'x'.repeat(200)}`;
    edit.current.width = `120px\u0000${'x'.repeat(200)}`;
    edit.originalInlineStyle.styles = {
      width: { value: `10px\u0000${'x'.repeat(300)}`, priority: 'important\u0000' },
    };

    const normalized = normalizeBrowserAnnotationBatches([value]);
    expect(normalized[0].annotations[0].elementEdit?.current.text).toBe('  标题  ');
    expect(normalized[0].annotations[0].elementEdit?.current.opacity).toBe(1);
    expect(normalized[0].annotations[0].elementEdit?.current.color?.length).toBe(128);
    expect(normalized[0].annotations[0].elementEdit?.current.width?.length).toBe(128);
    expect(normalized[0].annotations[0].elementEdit?.originalInlineStyle.styles?.width?.value.length).toBe(256);
    expect(normalized[0].annotations[0].elementEdit?.originalInlineStyle.styles?.width?.priority).toBe('important');
  });

  test('keeps markers attached to document coordinates while scrolling', () => {
    const anchor = batch().annotations[0].anchor;
    anchor.documentRect = { x: 10, y: 620, width: 100, height: 40 };

    expect(resolveBrowserAnnotationViewportRect(anchor, undefined, { x: 0, y: 500 })).toEqual({
      x: 10,
      y: 120,
      width: 100,
      height: 40,
    });

    delete anchor.documentRect;
    expect(resolveBrowserAnnotationViewportRect(anchor, { scrollX: 0, scrollY: 200 }, { x: 0, y: 500 })).toEqual({
      x: 10,
      y: -280,
      width: 100,
      height: 40,
    });
  });

  test('keeps the marker at its captured target offset without viewport clamping', () => {
    const annotation = batch().annotations[0];
    annotation.anchor.documentRect = { x: 10, y: 620, width: 100, height: 40 };
    annotation.capture.targetRect = { x: 10, y: 120, width: 100, height: 40 };
    annotation.capture.markerViewportPoint = { x: 26, y: 136 };

    expect(resolveBrowserAnnotationMarkerViewportPoint(
      annotation.anchor,
      annotation.capture,
      { x: 0, y: 500 },
    )).toEqual({ x: 26, y: 136 });
    expect(resolveBrowserAnnotationMarkerViewportPoint(
      annotation.anchor,
      annotation.capture,
      { x: 0, y: 650 },
    )).toEqual({ x: 26, y: -14 });
  });
});
