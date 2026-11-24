import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import ModelSwitchConfirmDialog from './ModelSwitchConfirmDialog';

describe('ModelSwitchConfirmDialog', () => {
  test('renders nothing when closed', () => {
    const html = renderToStaticMarkup(
      React.createElement(ModelSwitchConfirmDialog, {
        isOpen: false,
        previousModelName: 'DeepSeek Flash',
        nextModelName: 'DeepSeek Pro',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(html).toBe('');
  });

  test('renders Chinese confirmation copy, model names, checkbox, and actions when opened', () => {
    i18nService.setLanguage('zh', { persist: false });
    const html = renderToStaticMarkup(
      React.createElement(ModelSwitchConfirmDialog, {
        isOpen: true,
        previousModelName: 'DeepSeek Flash',
        nextModelName: 'DeepSeek Pro',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('z-[10050]');
    expect(html).toContain('切换模型？');
    expect(html).toContain(
      '此会话已为 DeepSeek Flash 缓存。切换到 DeepSeek Pro 意味着 LobsterAI 会在您发送下一条消息时重新读取整个会话，这会消耗您更多的用量。',
    );
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('不再询问');
    expect(html).toContain('>取消</button>');
    expect(html).toContain('>切换模型</button>');
  });

  test('renders English copy and disables controls while confirming', () => {
    i18nService.setLanguage('en', { persist: false });
    const html = renderToStaticMarkup(
      React.createElement(ModelSwitchConfirmDialog, {
        isOpen: true,
        previousModelName: 'Fast',
        nextModelName: 'Flagship',
        confirming: true,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(html).toContain('Switch model?');
    expect(html).toContain(
      'This conversation is cached for Fast. Switching to Flagship means LobsterAI will re-read the entire conversation when you send your next message, which will consume more usage.',
    );
    expect(html).toContain('Don&#x27;t ask again');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Switch model<\/button>/);
  });
});
