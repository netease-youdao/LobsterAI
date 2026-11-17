import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { OpenClawEnginePhase } from '../../../shared/openclawEngine/constants';
import type { OpenClawEngineStatus } from '../../types/cowork';
import EngineStartupOverlay from './EngineStartupOverlay';

const snapshot = vi.hoisted(() => ({ status: null as OpenClawEngineStatus | null }));

vi.mock('../../services/cowork', () => ({
  coworkService: {
    getOpenClawEngineStatusSnapshot: () => snapshot.status,
    getOpenClawEngineStatus: () => Promise.resolve(snapshot.status),
    onOpenClawEngineStatus: () => () => undefined,
  },
}));
vi.mock('../../services/i18n', () => ({
  i18nService: {
    t: (key: string) => (key === 'engineStartingDestination' ? 'Opens {name} when ready' : key),
  },
}));

const startingStatus: OpenClawEngineStatus = {
  phase: OpenClawEnginePhase.Starting,
  version: '2026.8.1',
  canRetry: false,
};

describe('EngineStartupOverlay', () => {
  test('tells the user where a link clicked during startup will land, with a way out', () => {
    snapshot.status = startingStatus;

    const html = renderToStaticMarkup(React.createElement(EngineStartupOverlay, {
      destinationLabel: 'Expert Plaza',
      onCancelDestination: () => undefined,
    }));

    expect(html).toContain('Opens Expert Plaza when ready');
    expect(html).toContain('grid-rows-[1fr]');
    expect(html).toContain('>cancel</button>');
  });

  test('keeps the destination row collapsed and hidden when nothing is pending', () => {
    snapshot.status = startingStatus;

    const html = renderToStaticMarkup(React.createElement(EngineStartupOverlay));

    expect(html).toContain('engineStartingTitle');
    expect(html).toContain('invisible grid-rows-[0fr]');
    expect(html).not.toContain('grid-rows-[1fr]');
  });

  test('renders nothing once the engine is running', () => {
    snapshot.status = { ...startingStatus, phase: OpenClawEnginePhase.Running };

    expect(renderToStaticMarkup(React.createElement(EngineStartupOverlay, {
      destinationLabel: 'Expert Plaza',
    }))).toBe('');
  });
});

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
