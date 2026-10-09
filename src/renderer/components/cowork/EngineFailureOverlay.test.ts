import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { OpenClawEngineErrorCode, OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import type { OpenClawEngineStatus } from '../../types/cowork';
import EngineFailureOverlay from './EngineFailureOverlay';

const snapshot = vi.hoisted(() => ({ status: null as OpenClawEngineStatus | null }));

vi.mock('../../services/cowork', () => ({
  coworkService: { getOpenClawEngineStatusSnapshot: () => snapshot.status },
}));
vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('../../services/logReporter', () => ({ LogReporterAction: {}, reportYdAnalyzer: vi.fn() }));

describe('EngineFailureOverlay', () => {
  test('shows the initial startup cause without requiring a repair attempt', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Error,
      version: '2026.8.1',
      message: 'Cannot find package openclaw imported from discord/dist/owner-access.js',
      canRetry: true,
    };

    const html = renderToStaticMarkup(React.createElement(EngineFailureOverlay));

    expect(html).toContain('role="dialog"');
    expect(html).toContain(snapshot.status.message);
    expect(html).toContain('coworkOpenClawQuickRepair');
  });

  test('does not offer repair while the supervisor is recovering', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Starting,
      version: '2026.8.1',
      message: 'Restarting OpenClaw gateway (attempt 1/5)...',
      canRetry: false,
    };

    expect(renderToStaticMarkup(React.createElement(EngineFailureOverlay))).toBe('');
  });

  test('guides reinstall instead of config repair when runtime workers are missing', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Error,
      version: '2026.8.1',
      errorCode: OpenClawEngineErrorCode.RuntimeFilesMissing,
      canRetry: false,
    };
    const html = renderToStaticMarkup(React.createElement(EngineFailureOverlay));
    expect(html).toContain('coworkOpenClawRuntimeDamagedRepairHint');
    expect(html).not.toContain('coworkOpenClawQuickRepair');
    expect(html).not.toContain('coworkOpenClawRestartGateway');
  });

  test('tells the user to handle the listed legacy data when startup migrations were refused', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Error,
      version: '2026.8.1',
      errorCode: OpenClawEngineErrorCode.StartupMigrationRefused,
      message: 'OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.\n'
        + '- Legacy channel allowFrom channel/account is unresolved; left in place at credentials/openclaw-weixin-a74391227cd8-im-bot-allowFrom.json',
      canRetry: true,
    };
    const html = renderToStaticMarkup(React.createElement(EngineFailureOverlay));
    expect(html).toContain('openClawStartupMigrationRefusedHint');
    expect(html).toContain('openclaw-weixin-a74391227cd8-im-bot-allowFrom.json');
    expect(html).toContain('coworkOpenClawQuickRepair');
  });

  test('offers the loopback firewall rule instead of config repair when local connections are dropped', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Error,
      version: '2026.9.23',
      errorCode: OpenClawEngineErrorCode.LoopbackBlocked,
      message: 'Local connection self-test failed (ETIMEDOUT). AI engine startup is paused.',
      canRetry: true,
    };
    const html = renderToStaticMarkup(React.createElement(EngineFailureOverlay));
    expect(html).toContain('coworkOpenClawLoopbackBlockedTitle');
    expect(html).toContain('coworkOpenClawLoopbackBlockedHint');
    expect(html).toContain('ETIMEDOUT');
    expect(html).toContain('coworkOpenClawAllowLoopback');
    expect(html).toContain('coworkOpenClawLoopbackRecheck');
    expect(html).not.toContain('coworkOpenClawQuickRepair');
    expect(html).not.toContain('coworkOpenClawRestartGateway');
  });

  test('explains a stalled config apply and leads with Quick Repair', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Error,
      version: '2026.8.1',
      errorCode: OpenClawEngineErrorCode.ConfigApplyStalled,
      message: 'config.apply failed: gateway request timeout for config.apply',
      canRetry: false,
    };
    const html = renderToStaticMarkup(React.createElement(EngineFailureOverlay));
    expect(html).toContain('coworkOpenClawConfigStalledTitle');
    expect(html).toContain('coworkOpenClawConfigStalledHint');
    expect(html).toContain('gateway request timeout for config.apply');
    expect(html).toContain('coworkOpenClawQuickRepair');
    expect(html).toContain('coworkOpenClawRestartGateway');
  });
});
