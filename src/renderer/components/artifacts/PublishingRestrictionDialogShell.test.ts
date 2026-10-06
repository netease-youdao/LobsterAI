import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import PublishingRestrictionDialogShell from './PublishingRestrictionDialogShell';

describe('PublishingRestrictionDialogShell', () => {
  test('renders the publishing restriction dialog with rounded corners and a close control', () => {
    const html = renderToStaticMarkup(React.createElement(
      PublishingRestrictionDialogShell,
      {
        titleId: 'restriction-title',
        descriptionId: 'restriction-description',
        onClose: () => {},
        children: [
          React.createElement('h2', { id: 'restriction-title', key: 'title' }, '分享功能'),
          React.createElement(
            'p',
            { id: 'restriction-description', key: 'description' },
            '已达到使用上限',
          ),
        ],
      },
    ));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="restriction-title"');
    expect(html).toContain('aria-describedby="restriction-description"');
    expect(html).toContain('rounded-2xl');
    expect(html).toContain('max-h-[calc(100vh-2rem)]');
    expect(html).toContain('aria-label="关闭"');
    expect(html).not.toContain('rounded-none');
  });
});
