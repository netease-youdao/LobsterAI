import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { RemoteConnectionReleaseState, type RemoteConnectionsSnapshot, RemoteDeviceAdmissionState, type RemoteDeviceConnection, RemoteDeviceConnectionState } from '../../../shared/remote/connections';
import { i18nService } from '../../services/i18n';
import type { DeviceConnectionsState } from '../../services/remoteDeviceConnections';
import { RemoteDeviceConnectionList, RemoteDeviceConnectionSummary } from './RemoteDeviceConnectionList';

const current: RemoteDeviceConnection = { deviceId: 'current', name: 'Current', connectionVersion: '1', connectionState: RemoteDeviceConnectionState.Allowed, admissionState: RemoteDeviceAdmissionState.Online, slotOccupied: true };
const data: RemoteConnectionsSnapshot = { supported: true, observedAt: '2026-09-18T06:00:00Z', presenceAvailable: true, quota: { maxOnlineDesktops: 5, onlineSlotsUsed: 1, scope: 'account_scope' }, currentDevice: current, connections: [current] };
const snapshot: DeviceConnectionsState = { accountEpoch: 'a', data, loading: false, error: null, operations: {} };
const renderList = (value = snapshot) => renderToStaticMarkup(React.createElement(RemoteDeviceConnectionList, { snapshot: value, sectionRef: React.createRef<HTMLElement>() }));
const renderSummary = (value = snapshot) => renderToStaticMarkup(React.createElement(RemoteDeviceConnectionSummary, { snapshot: value }));
const render = (value = snapshot) => renderSummary(value) + renderList(value);
beforeEach(() => {
  const original = console.error;
  vi.spyOn(console, 'error').mockImplementation((message: unknown, ...args: unknown[]) => {
    if (typeof message === 'string' && message.includes('useLayoutEffect does nothing on the server')) return;
    original(message, ...args);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('connected computer list', () => {
  test('keeps refresh without a count and excludes the current computer from other rows', () => {
    const html = render();
    expect(html).not.toContain('1 / 5');
    expect(html).not.toContain(i18nService.t('remoteConnectionsIncludeCurrent'));
    expect(html).not.toContain(i18nService.t('remoteNoOtherConnections'));
    expect(renderList()).toBe('');
    expect(html).toContain(`aria-label="${i18nService.t('remoteRefreshConnections')}"`);
    expect(html).not.toContain('title="Current"');
  });
  test('shows every other computer during reconnection and capacity reductions without displaying quota', () => {
    const html = render({ ...snapshot, data: { ...data, quota: { ...data.quota, onlineSlotsUsed: 6 }, currentDevice: { ...current, slotOccupied: false },
      connections: Array.from({ length: 6 }, (_, index) => ({ ...current, deviceId: `other-${index}`, name: `Computer-${index}`, admissionState: RemoteDeviceAdmissionState.Reconnecting })) } });
    expect(html).not.toContain('6 / 5');
    expect(html).toContain(i18nService.t('remoteOtherConnectedComputers'));
    expect(renderList({ ...snapshot, data })).not.toContain('1 / 5');
    expect(html.match(/Computer-/g)).toHaveLength(18);
    expect(html).toContain(i18nService.t('remoteConnectionReconnecting'));
    expect(html).not.toContain(i18nService.t('remoteConnectionsIncludeCurrent'));
  });
  test('pending slot release stays visible without a count or actionable remove button', () => {
    const html = render({ ...snapshot, data: { ...data, connections: [{ ...current, deviceId: 'other', name: 'Releasing', canRemove: true, connectionState: RemoteDeviceConnectionState.Removed, releaseState: RemoteConnectionReleaseState.Pending }] } });
    expect(html).not.toContain('1 / 5');
    expect(html).toContain(i18nService.t('remoteRemovingConnection'));
    expect(html).toMatch(/disabled="" aria-label=/);
  });
  test('unavailable presence shows an error without a misleading connection count', () => {
    for (const value of [{ ...snapshot, data: { ...data, presenceAvailable: false, quota: { ...data.quota, onlineSlotsUsed: null } } }, { ...snapshot, error: 'remoteConnectionsUnavailable' }]) {
      const html = render(value);
      expect(html).not.toContain('— / 5');
      expect(html).not.toContain('0 / 5');
      expect(html).toContain(i18nService.t('remoteConnectionsUnavailable'));
    }
  });
  test('loading refresh remains accessible while the empty devices list stays hidden', () => {
    const loading = { ...snapshot, loading: true, data: null };
    const html = renderSummary(loading);
    expect(html).not.toContain('— / —');
    expect(html).toContain('disabled=""');
    expect(html).toContain('animate-spin');
    expect(renderList(loading)).toBe('');
  });
  test('list errors remain visible even without other connected devices', () => {
    const html = renderList({ ...snapshot, data: null, error: 'remoteConnectionsUnavailable' });
    expect(html).toContain('role="alert"');
    expect(html).toContain(i18nService.t('remoteConnectionsUnavailable'));
    expect(html).not.toContain(i18nService.t('remoteNoOtherConnections'));
  });
  test('older servers retain the current-device page without a broken connections list', () => {
    expect(render({ ...snapshot, data: { ...data, supported: false } })).toBe('');
  });
  test('disambiguates equal host names with equal default instance labels', () => {
    const html = render({ ...snapshot, data: { ...data, connections: [
      { ...current, deviceId: 'device-aaaaaa', name: 'Mac', instanceLabel: '默认配置' },
      { ...current, deviceId: 'device-bbbbbb', name: 'Mac', instanceLabel: '默认配置' },
    ] } });
    expect(html).toContain('aaaaaa'); expect(html).toContain('bbbbbb');
  });

});
