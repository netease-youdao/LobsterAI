import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import Tooltip, {
  TOOLTIP_DARK_BUBBLE_CLASS_NAME,
  TooltipAlign,
  TooltipPosition,
} from './Tooltip';

describe('Tooltip', () => {
  test('renders its trigger cleanly in SSR with portal enabled without throwing or leaking a visible bubble', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        Tooltip,
        {
          portal: true,
          content: '后退',
          position: TooltipPosition.Bottom,
          align: TooltipAlign.Center,
          bubbleClassName: TOOLTIP_DARK_BUBBLE_CLASS_NAME,
          className: 'non-draggable shrink-0',
          children: React.createElement('button', { type: 'button', 'aria-label': '后退' }, 'Back'),
        },
      ),
    );

    expect(html).toContain('aria-label="后退"');
    expect(html).toContain('non-draggable shrink-0');
    expect(html).not.toContain('role="tooltip"');
  });

  test('exports the dark solid bubble styling for header and toolbar tooltips', () => {
    expect(TOOLTIP_DARK_BUBBLE_CLASS_NAME).toContain('bg-[#262626]');
    expect(TOOLTIP_DARK_BUBBLE_CLASS_NAME).toContain('text-white');
  });
});
