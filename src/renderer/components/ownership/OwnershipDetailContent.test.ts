import { OwnershipContentSyncReason, OwnershipContentSyncState, OwnershipSyncState, OwnershipTargetKind } from '@shared/ownership/constants';
import type { OwnershipDetail } from '@shared/ownership/types';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';

import { i18nService } from '../../services/i18n';
import OwnershipDetailContent, { ownershipSyncLabel } from './OwnershipDetailContent';

const originalLanguage = i18nService.getLanguage();
afterEach(() => i18nService.setLanguage(originalLanguage, { persist: false }));
const detail: OwnershipDetail = { kind: OwnershipTargetKind.Task, id: 'task', title: 'Task',
  ownership: { kind: 'owned', label: 'Current account', scopeLabel: 'Personal' }, deviceName: 'Desktop',
  syncState: OwnershipSyncState.Partial, contentSync: { state: OwnershipContentSyncState.Partial, retryable: false }, canAssociate: false, accountPartition: 'account' };

describe('partial content in ownership details', () => {
  test.each(['zh', 'en'] as const)('shows an informational content limitation in full detail without changing the compact layout (%s)', language => {
    i18nService.setLanguage(language, { persist: false });
    const html = renderToStaticMarkup(React.createElement(OwnershipDetailContent, { detail }));
    expect(ownershipSyncLabel(OwnershipSyncState.Partial)).toBe(i18nService.t('ownershipSync_partial'));
    expect(html).toContain(i18nService.t('ownershipSync_partial'));
    expect(html).not.toContain(i18nService.t('ownershipSync_synced'));
    expect(html).not.toContain(i18nService.t('ownershipSync_failed'));
    expect(html).not.toContain('role="alert"');
    const compact = renderToStaticMarkup(React.createElement(OwnershipDetailContent, { detail, compact: true }));
    expect(compact).not.toContain(i18nService.t('ownershipSync_partial'));
    expect(compact).toBe(renderToStaticMarkup(React.createElement(OwnershipDetailContent, {
      detail: { ...detail, syncState: OwnershipSyncState.Synced }, compact: true,
    })));
  });
});

describe('task content sync detail', () => {
  test.each(['zh', 'en'] as const)('separates execution failure from successfully synced content (%s)', language => {
    i18nService.setLanguage(language, { persist: false });
    const html = renderToStaticMarkup(React.createElement(OwnershipDetailContent, {
      detail: { ...detail, status: 'error', contentSync: { state: OwnershipContentSyncState.Synced, retryable: false } },
    }));
    expect(html).toContain(i18nService.t('ownershipTaskStatus'));
    expect(html).toContain(i18nService.t('ownershipStatus_error'));
    expect(html).toContain(i18nService.t('ownershipMobileContentSync'));
    expect(html).toContain(i18nService.t('ownershipContentSync_synced'));
    expect(html).not.toContain(i18nService.t('ownershipContentSync_failed'));
  });
  test.each([
    [OwnershipContentSyncReason.Content, 'remoteTaskLiveSyncIssue'],
    [OwnershipContentSyncReason.History, 'ownershipContentSyncHistoryHelp'],
  ] as const)('shows bounded content information for %s failure without promising recovery', (reason, key) => {
    const html = renderToStaticMarkup(React.createElement(OwnershipDetailContent, {
      detail: { ...detail, contentSync: { state: OwnershipContentSyncState.Failed, retryable: false, reason, nextRetryAt: Date.now() + 60_000 } },
    }));
    expect(html).toContain(i18nService.t(key));
    expect(html).toContain(i18nService.t('ownershipContentSyncRetryAfter').split('{time}')[0]);
    expect(html).not.toContain(i18nService.t('ownershipRetrySync'));
    expect(html).not.toContain(i18nService.t('ownershipCompactStatus_error'));
  });
  test('treats missing detail as unknown even when legacy syncState says synced', () => {
    const html = renderToStaticMarkup(React.createElement(OwnershipDetailContent, {
      detail: { ...detail, syncState: OwnershipSyncState.Synced, contentSync: undefined },
    }));
    expect(html).toContain(i18nService.t('ownershipContentSync_unknown'));
    expect(html).toContain(i18nService.t('ownershipContentSyncUnavailableHelp'));
    expect(html).not.toContain(i18nService.t('ownershipContentSync_synced'));
  });
  test('keeps waiting and connection guidance separate from content failure', () => {
    const html = renderToStaticMarkup(React.createElement(OwnershipDetailContent, {
      detail: { ...detail, contentSync: { state: OwnershipContentSyncState.Waiting, retryable: false, reason: OwnershipContentSyncReason.Connection } },
    }));
    expect(html).toContain(i18nService.t('ownershipContentSync_waiting'));
    expect(html).toContain(i18nService.t('ownershipContentSyncConnectionHelp'));
    expect(html).not.toContain(i18nService.t('remoteTaskLiveSyncIssue'));
  });
  test.each(Object.values(OwnershipContentSyncState))('keeps compact task hover unchanged for %s', state => {
    const compact = (contentSync: OwnershipDetail['contentSync']) => renderToStaticMarkup(React.createElement(OwnershipDetailContent, {
      detail: { ...detail, status: 'running', updatedAt: 1_800_000_000_000, contentSync }, compact: true,
    }));
    expect(compact({ state, retryable: true, reason: OwnershipContentSyncReason.Content })).toBe(compact(undefined));
  });
});
