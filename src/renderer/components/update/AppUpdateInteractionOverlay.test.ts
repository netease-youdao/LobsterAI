import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import AppUpdateInteractionOverlay from './AppUpdateInteractionOverlay';

describe('AppUpdateInteractionOverlay', () => {
  test('centers its update content with viewport-safe bounds', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        AppUpdateInteractionOverlay,
        null,
        React.createElement('span', null, 'Update progress'),
      ),
    );

    expect(html).toContain('items-center');
    expect(html).toContain('justify-center');
    expect(html).toContain('fixed');
    expect(html).toContain('z-[100]');
    expect(html).toContain('bg-surface');
    expect(html).toContain('linear-gradient(360deg');
    expect(html).not.toContain('bg-white/75');
    expect(html).toContain('p-4');
    expect(html).toContain('h-full');
    expect(html).toContain('min-h-0');
    expect(html).toContain('max-w-lg');
    expect(html).toContain('tabindex="-1"');
    expect(html).not.toContain('overflow-y-auto');
    expect(html).toContain('Update progress');
  });
});
