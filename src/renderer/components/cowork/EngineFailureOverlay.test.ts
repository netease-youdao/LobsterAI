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

  test('shows a stalled config apply as a compact notice that leads with Quick Repair', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Running,
      version: '2026.8.1',
      message: 'OpenClaw gateway is running on loopback:18789.',
      canRetry: false,
      configApplyStalled: { detail: 'config.apply failed: gateway request timeout for config.apply' },
    };
    const html = renderToStaticMarkup(React.createElement(EngineFailureOverlay));
    // Tasks keep running during a stall, so nothing modal covers the app.
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('coworkOpenClawConfigStalledShort');
    expect(html).not.toContain('coworkOpenClawErrorShort');
    expect(html).toContain('coworkOpenClawQuickRepair');
  });

  test('stays hidden while the gateway runs without a stalled config', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Running,
      version: '2026.8.1',
      message: 'OpenClaw gateway is running on loopback:18789.',
      canRetry: false,
    };
    expect(renderToStaticMarkup(React.createElement(EngineFailureOverlay))).toBe('');
  });

  test('lets an engine failure take precedence over a stalled config', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Error,
      version: '2026.8.1',
      message: 'OpenClaw gateway failed to become healthy in time.',
      canRetry: true,
      configApplyStalled: { detail: 'config.apply failed: gateway request timeout for config.apply' },
    };
    const html = renderToStaticMarkup(React.createElement(EngineFailureOverlay));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('coworkOpenClawError');
    expect(html).not.toContain('coworkOpenClawConfigStalledTitle');
    expect(html).toContain('failed to become healthy in time');
  });
});
