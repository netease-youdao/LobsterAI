import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import LibraryShareDeleteDialog from './LibraryShareDeleteDialog';

const renderDialog = (showFreeQuotaNotice: boolean): string => renderToStaticMarkup(
  React.createElement(LibraryShareDeleteDialog, {
    fileName: 'manifest.md',
    busy: false,
    showFreeQuotaNotice,
    onCancel: () => undefined,
    onConfirm: () => undefined,
  }),
);

describe('LibraryShareDeleteDialog', () => {
  test('shows the historical free quota warning for a free user', () => {
    expect(renderDialog(true)).toContain(i18nService.t('libraryShareDeleteQuotaNotice'));
  });

  test('hides the historical free quota warning for non-free or unknown users', () => {
    expect(renderDialog(false)).not.toContain(i18nService.t('libraryShareDeleteQuotaNotice'));
  });
});
