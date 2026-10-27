import { OwnershipContentSyncReason, OwnershipContentSyncState, OwnershipSyncState, OwnershipTargetKind } from '@shared/ownership/constants';
import type { OwnershipDetail } from '@shared/ownership/types';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { OwnershipPanelState } from '../../services/ownership';

const harness = vi.hoisted(() => ({
  detail: null as OwnershipDetail | null, panel: null as OwnershipPanelState | null,
  open: vi.fn(), retry: vi.fn(), close: vi.fn(),
  buttons: [] as React.ButtonHTMLAttributes<HTMLButtonElement>[],
  states: [] as unknown[], stateIndex: 0, sequence: 0,
}));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  return { ...original, useState: (initial: unknown) => {
    const index = harness.stateIndex++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [harness.states[index], (value: unknown) => {
      harness.states[index] = typeof value === 'function' ? value(harness.states[index]) : value;
    }];
  } };
});
vi.mock('../../services/auth', () => ({ authService: { login: vi.fn() } }));
vi.mock('../../services/ownership', () => ({
  OwnershipView: { Detail: 'detail', Preview: 'preview', Unknown: 'unknown' },
  ownershipService: { subscribe: () => () => undefined, getSnapshot: () => harness.panel,
    getSequence: () => harness.sequence, start: () => () => undefined, open: harness.open, retrySync: harness.retry, close: harness.close },
}));
vi.mock('./useOwnershipDetail', () => ({ useOwnershipDetail: () => harness.detail }));
vi.mock('../common/Modal', () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const original = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof original.jsxDEV = (...args) => {
    const element = original.jsxDEV(...args);
    if (element.type === 'button') harness.buttons.push(element.props as React.ButtonHTMLAttributes<HTMLButtonElement>);
    return element;
  };
  return { ...original, jsxDEV };
});

import { i18nService } from '../../services/i18n';
import OwnershipHost from './OwnershipHost';
import OwnershipMenuItems from './OwnershipMenuItems';
import OwnershipTaskSyncButton from './OwnershipTaskSyncButton';

const target = { kind: OwnershipTargetKind.Task, id: 'task-a' };
const detail: OwnershipDetail = { ...target, title: 'Local task',
  ownership: { kind: 'owned', label: 'Account', scopeLabel: 'Personal' }, deviceName: 'Desktop',
  syncState: OwnershipSyncState.Failed, canAssociate: false, accountPartition: 'account-a',
  contentSync: { state: OwnershipContentSyncState.Failed, reason: OwnershipContentSyncReason.Content, retryable: true },
};
const text = (value: React.ReactNode): string => React.Children.toArray(value).map(item => typeof item === 'string'
  ? item : React.isValidElement<{ children?: React.ReactNode }>(item) ? text(item.props.children) : '').join('');
const button = (key: string) => harness.buttons.find(item => text(item.children) === i18nService.t(key));
const click = (props: React.ButtonHTMLAttributes<HTMLButtonElement> | undefined) => {
  expect(props).toBeDefined(); props?.onClick?.({ stopPropagation: vi.fn() } as unknown as React.MouseEvent<HTMLButtonElement>);
};
function render(element: React.ReactElement) {
  harness.buttons.length = 0; harness.stateIndex = 0;
  return renderToStaticMarkup(element);
}
function setDetail(next: OwnershipDetail) {
  harness.detail = next;
  harness.panel = { view: 'detail', target: { kind: next.kind, id: next.id }, detail: next };
}
beforeEach(() => {
  vi.clearAllMocks(); harness.states = []; harness.sequence = 0;
  harness.close.mockImplementation(() => { harness.sequence++; harness.panel = null; });
  setDetail(detail);
});

describe('task sync entry points', () => {
  test.each([OwnershipContentSyncReason.Content, OwnershipContentSyncReason.History])('opens task detail for %s failures without retrying', reason => {
    harness.detail = { ...detail, contentSync: { ...detail.contentSync!, reason } };
    const html = render(React.createElement(OwnershipTaskSyncButton, { sessionId: target.id }));
    expect(html).toContain(i18nService.t('ownershipContentSyncEntryFailed'));
    click(button('ownershipContentSyncEntryFailed'));
    expect(harness.open).toHaveBeenCalledExactlyOnceWith(target);
    expect(harness.retry).not.toHaveBeenCalled();
  });
  test('shows a neutral partial-content entry', () => {
    harness.detail = { ...detail, contentSync: { state: OwnershipContentSyncState.Partial, retryable: false } };
    const html = render(React.createElement(OwnershipTaskSyncButton, { sessionId: target.id }));
    expect(html).toContain(i18nService.t('ownershipContentSyncEntryPartial'));
    expect(html).not.toContain('text-amber');
    click(button('ownershipContentSyncEntryPartial'));
    expect(harness.open).toHaveBeenCalledExactlyOnceWith(target);
  });
  test.each([undefined, OwnershipContentSyncState.Unknown, OwnershipContentSyncState.Waiting,
    OwnershipContentSyncState.Pending, OwnershipContentSyncState.Synced, OwnershipContentSyncState.Local])('leaves no header placeholder for %s', state => {
    harness.detail = { ...detail, contentSync: state ? { state, retryable: false } : undefined };
    expect(render(React.createElement(OwnershipTaskSyncButton, { sessionId: target.id }))).toBe('');
  });
  test.each([undefined, OwnershipContentSyncReason.Connection, OwnershipContentSyncReason.Unavailable])('does not present an unclassified %s failure as a content fault', reason => {
    harness.detail = { ...detail, contentSync: { state: OwnershipContentSyncState.Failed, retryable: true, reason } };
    expect(render(React.createElement(OwnershipTaskSyncButton, { sessionId: target.id }))).toBe('');
  });
  test('adds an accessible task details menu item even without a snapshot', () => {
    harness.detail = null;
    const closeMenu = vi.fn();
    render(React.createElement(OwnershipMenuItems, { target, onAction: closeMenu, className: '' }));
    expect(button('ownershipDetails')?.role).toBe('menuitem');
    click(button('ownershipDetails'));
    expect(closeMenu).toHaveBeenCalledOnce();
    expect(harness.open).toHaveBeenCalledExactlyOnceWith(target, 'detail');
    expect(button('ownershipRetrySync')).toBeUndefined();
  });
});

describe('task sync detail actions', () => {
  test('retries only the authorized task and retains the visible failure until refreshed evidence arrives', () => {
    render(React.createElement(OwnershipHost));
    click(button('ownershipRetrySync'));
    expect(harness.retry).toHaveBeenCalledOnce();
    expect(render(React.createElement(OwnershipHost))).toContain(i18nService.t('ownershipContentSync_failed'));
  });
  test.each(['unknown', 'partial', 'unretryable', 'anonymous', 'unclassified'] as const)('does not offer retry for %s', scenario => {
    const next = { ...detail, contentSync: { ...detail.contentSync! } };
    if (scenario === 'unknown') next.contentSync.state = OwnershipContentSyncState.Unknown;
    if (scenario === 'partial') next.contentSync.state = OwnershipContentSyncState.Partial;
    if (scenario === 'unretryable') next.contentSync.retryable = false;
    if (scenario === 'anonymous') next.ownership = { kind: 'anonymous', label: '', scopeLabel: '' };
    if (scenario === 'unclassified') next.contentSync.reason = undefined;
    setDetail(next);
    render(React.createElement(OwnershipHost));
    expect(button('ownershipRetrySync')).toBeUndefined();
    render(React.createElement(OwnershipMenuItems, { target, onAction: vi.fn(), className: '' }));
    expect(button('ownershipRetrySync')).toBeUndefined();
  });
  test('disables duplicate retry while allowing the detail to close', () => {
    harness.panel!.retrying = true;
    render(React.createElement(OwnershipHost));
    expect(button('ownershipRetryingSync')?.disabled).toBe(true);
    click(button('ownershipRetryingSync'));
    expect(harness.retry).not.toHaveBeenCalled();
    expect(button('close')?.disabled).not.toBe(true);
    click(button('close')); expect(harness.close).toHaveBeenCalledOnce();
  });
  test('preserves the existing agent retry action', () => {
    setDetail({ ...detail, kind: OwnershipTargetKind.Agent, contentSync: undefined });
    render(React.createElement(OwnershipHost));
    click(button('ownershipRetrySync')); expect(harness.retry).toHaveBeenCalledOnce();
  });
  test('keeps task detail visible and reports only a fixed message if navigation fails', async () => {
    const onOpenTask = vi.fn().mockRejectedValue(new Error('private native details'));
    render(React.createElement(OwnershipHost, { onOpenTask }));
    click(button('ownershipViewTask'));
    await Promise.resolve(); await Promise.resolve();
    const html = render(React.createElement(OwnershipHost, { onOpenTask }));
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith(target.id);
    expect(harness.close).not.toHaveBeenCalled();
    expect(html).toContain(detail.title);
    expect(html).toContain(i18nService.t('ownershipOpenTaskFailed'));
    expect(html).not.toContain('private native details');
  });
});

describe('task detail navigation lifetime', () => {
  function pendingOpen() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    return { resolve, reject, onOpenTask: vi.fn(() => promise) };
  }
  test('disables navigation and retry while opening, then closes only after successful loading', async () => {
    const open = pendingOpen();
    render(React.createElement(OwnershipHost, { onOpenTask: open.onOpenTask }));
    click(button('ownershipViewTask'));
    render(React.createElement(OwnershipHost, { onOpenTask: open.onOpenTask }));
    expect(button('ownershipViewTask')?.disabled).toBe(true);
    expect(button('ownershipRetrySync')?.disabled).toBe(true);
    click(button('ownershipViewTask'));
    expect(open.onOpenTask).toHaveBeenCalledOnce();
    expect(harness.close).not.toHaveBeenCalled();
    open.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(harness.close).toHaveBeenCalledOnce();
  });
  test.each(['resolve', 'reject'] as const)('ignores late %s after reopening the same task detail', async outcome => {
    const open = pendingOpen();
    render(React.createElement(OwnershipHost, { onOpenTask: open.onOpenTask }));
    click(button('ownershipViewTask'));
    harness.sequence++;
    setDetail({ ...detail });
    if (outcome === 'resolve') open.resolve(); else open.reject(new Error('private details'));
    await Promise.resolve(); await Promise.resolve();
    const html = render(React.createElement(OwnershipHost, { onOpenTask: open.onOpenTask }));
    expect(harness.close).not.toHaveBeenCalled();
    expect(html).not.toContain(i18nService.t('ownershipOpenTaskFailed'));
    expect(html).toContain(detail.title);
  });
  test('does not close a detail whose account partition changed', async () => {
    const open = pendingOpen();
    render(React.createElement(OwnershipHost, { onOpenTask: open.onOpenTask }));
    click(button('ownershipViewTask'));
    setDetail({ ...detail, accountPartition: 'other-account' });
    open.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(harness.close).not.toHaveBeenCalled();
  });
});
