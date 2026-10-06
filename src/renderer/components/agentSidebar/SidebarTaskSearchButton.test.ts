import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import SidebarTaskSearchButton from './SidebarTaskSearchButton';

describe('SidebarTaskSearchButton', () => {
  test.each(['Search tasks', '搜索任务'])(
    'renders an accessible icon-only action for label %s with a stable hit target',
    (label) => {
      const html = renderToStaticMarkup(React.createElement(SidebarTaskSearchButton, {
        label,
        onClick: () => undefined,
        className: 'non-draggable',
      }));

      expect(html).toContain('type="button"');
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`title="${label}"`);
      expect(html).toContain('h-8 w-8');
      expect(html).toContain('h-[18px] w-[18px]');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('non-draggable');
      expect(html).not.toContain(`>${label}<`);
    },
  );
});
