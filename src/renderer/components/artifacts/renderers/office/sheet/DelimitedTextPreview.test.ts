import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';
import { DelimitedTextEncoding, rememberDelimitedTextEncoding } from '@/services/office/sheet/delimitedTextEncoding';

import { DelimitedTextPreview } from './DelimitedTextPreview';

// Exercise decoding and its controls independently of the grid's async import/virtualized layout.
vi.mock('./SheetFallbackRenderer', () => ({
  SheetFallbackRenderer: ({ data }: { data: string }) => React.createElement('pre', null, data),
}));

const FILE_KEY = 'encoding-controls-test';
const GBK = Uint8Array.from([0xc9, 0xcc, 0xc6, 0xb7]); // 商品
const render = (bytes: Uint8Array = GBK, fileKey = FILE_KEY) => renderToStaticMarkup(React.createElement(DelimitedTextPreview, {
  data: Uint8Array.from(bytes).buffer, fileName: 'products.csv', fileKey,
}));

afterEach(() => {
  rememberDelimitedTextEncoding(FILE_KEY, DelimitedTextEncoding.Auto);
  i18nService.setLanguage('zh', { persist: false });
});

describe('CSV encoding controls', () => {
  test.each(['zh', 'en'] as const)('shows decoded text, an inferred encoding and the read-only notice in %s', language => {
    i18nService.setLanguage(language, { persist: false });
    const html = render();
    expect(html).toContain('<pre>商品</pre>');
    expect(html).toContain(i18nService.t('artifactEncoding'));
    expect(html).toContain(i18nService.t('artifactEncodingPreviewOnly'));
    expect(html).toContain(i18nService.t('artifactEncodingFallback').replace('{encoding}', i18nService.t('artifactEncodingGb18030')));
    expect(html).toContain(`value="${DelimitedTextEncoding.Auto}" selected=""`);
    expect(html).not.toContain('role="alert"');
  });

  test('keeps all encoding options accessible on failure, then recovers after selecting a compatible encoding', () => {
    rememberDelimitedTextEncoding(FILE_KEY, DelimitedTextEncoding.Utf8);
    const failed = render();
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(i18nService.t('artifactEncodingInvalid'));
    expect(failed).not.toContain('<pre>');
    for (const encoding of Object.values(DelimitedTextEncoding)) expect(failed).toContain(`value="${encoding}"`);
    expect(failed).not.toContain('disabled');

    rememberDelimitedTextEncoding(FILE_KEY, DelimitedTextEncoding.Gb18030);
    const recovered = render();
    expect(recovered).toContain('<pre>商品</pre>');
    expect(recovered).not.toContain('role="alert"');
    expect(recovered).toContain(`value="${DelimitedTextEncoding.Gb18030}" selected=""`);
  });

  test('restores the per-file choice after remount without applying it to a UTF-8 tab', () => {
    rememberDelimitedTextEncoding(FILE_KEY, DelimitedTextEncoding.Gb18030);
    const other = render(new TextEncoder().encode('耳机'), 'other-encoding-controls-file');
    expect(other).toContain('<pre>耳机</pre>');
    expect(other).toContain(`value="${DelimitedTextEncoding.Auto}" selected=""`);
    expect(render()).toContain(`value="${DelimitedTextEncoding.Gb18030}" selected=""`);
  });

  test('surfaces unsupported UTF-32 explicitly instead of a misleading table', () => {
    const html = render(Uint8Array.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]));
    expect(html).toContain(i18nService.t('artifactEncodingUnsupported'));
    expect(html).not.toContain('<pre>');
  });
});
