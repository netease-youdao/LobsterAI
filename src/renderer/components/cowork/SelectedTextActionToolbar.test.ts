import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import SelectedTextActionToolbar from './SelectedTextActionToolbar';

test('renders add-to-chat and side-chat actions in one selection toolbar', () => {
  const previousLanguage = i18nService.getLanguage();
  i18nService.setLanguage('zh', { persist: false });
  try {
    const html = renderToStaticMarkup(React.createElement(SelectedTextActionToolbar, {
      left: 120,
      top: 80,
      onAddToChat: () => {},
      onAskInSideChat: () => {},
    }));

    expect(html).toContain('data-cowork-selected-text-action');
    expect(html).toContain('添加到对话');
    expect(html).toContain('在侧边聊天中提问');
    expect(html.match(/<button/g)).toHaveLength(2);
  } finally {
    i18nService.setLanguage(previousLanguage, { persist: false });
  }
});
