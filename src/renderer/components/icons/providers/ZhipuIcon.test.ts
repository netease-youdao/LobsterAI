import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import ZhipuIcon from './ZhipuIcon';

describe('ZhipuIcon', () => {
  test('renders the supplied light and dark mode artwork', () => {
    const html = renderToStaticMarkup(React.createElement(ZhipuIcon));

    expect(html).toContain('class="dark:hidden"');
    expect(html).toContain('url(#zhipu-icon-light-background)');
    expect(html).toContain('class="hidden dark:block"');
    expect(html).toContain('url(#zhipu-icon-dark-background)');
    expect(html).toContain('fill="#B7BCBF"');
  });
});
