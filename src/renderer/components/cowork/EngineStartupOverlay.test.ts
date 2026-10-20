import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import type { OpenClawEngineStatus } from '../../types/cowork';
import EngineStartupOverlay from './EngineStartupOverlay';

const snapshot = vi.hoisted(() => ({ status: null as OpenClawEngineStatus | null }));

vi.mock('../../services/cowork', () => ({
  coworkService: { getOpenClawEngineStatusSnapshot: () => snapshot.status },
}));
vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

describe('EngineStartupOverlay account recovery', () => {
  test('keeps normal engine startup covered', () => {
    snapshot.status = { phase: OpenClawEnginePhase.Starting, version: null, canRetry: false };
    const html = renderToStaticMarkup(React.createElement(EngineStartupOverlay));
    expect(html).toContain('engineStartingTitle');
    expect(html).toContain('coworkOpenClawStarting');
  });

  test('reuses the gateway restart overlay during account recovery without stale process progress', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Starting, version: null, canRetry: false,
      accountRecoveryPending: true, message: 'Restoring the current account AI engine.', progressPercent: 100,
    };
    const html = renderToStaticMarkup(React.createElement(EngineStartupOverlay));
    expect(html).toContain('engineStartingTitle');
    expect(html).toContain(snapshot.status.message);
    expect(html).not.toContain('>100%</span>');
    expect(html).not.toContain('coworkOpenClawReadyNotice');
  });

  test.each([OpenClawEnginePhase.Running, OpenClawEnginePhase.Error])('closes the startup overlay when recovery leaves starting: %s', phase => {
    snapshot.status = {
      phase, version: null, canRetry: phase === OpenClawEnginePhase.Error,
      accountRecoveryPending: phase === OpenClawEnginePhase.Error,
    };
    expect(renderToStaticMarkup(React.createElement(EngineStartupOverlay))).toBe('');
  });

  test('shows the account recovery message during renderer bootstrap instead of the stopped-engine notice', () => {
    snapshot.status = {
      phase: OpenClawEnginePhase.Ready, version: null, canRetry: false,
      accountRecoveryPending: true, message: 'Restoring the current account AI engine.',
    };
    const html = renderToStaticMarkup(React.createElement(EngineStartupOverlay, { bootstrapping: true }));
    expect(html).toContain(snapshot.status.message);
    expect(html).not.toContain('coworkOpenClawReadyNotice');
  });
});
