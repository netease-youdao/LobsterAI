import { describe, expect, test } from 'vitest';

import type { CoworkContextUsage } from '../../types/cowork';
import {
  buildContextUsagePopoverViewModel,
  ContextBarSegmentKind,
  ContextBreakdownSegmentKey,
  resolveContextCompactActionState,
} from './contextUsagePopover';

const makeUsage = (overrides: Partial<CoworkContextUsage> = {}): CoworkContextUsage => ({
  sessionId: 'session-1',
  usedTokens: 40_000,
  contextTokens: 200_000,
  percent: 20,
  status: 'normal',
  updatedAt: 1_000,
  ...overrides,
});

describe('buildContextUsagePopoverViewModel', () => {
  test('returns null when usage or finite percent is missing', () => {
    expect(buildContextUsagePopoverViewModel(undefined)).toBeNull();
    expect(buildContextUsagePopoverViewModel(makeUsage({ percent: undefined }))).toBeNull();
    expect(buildContextUsagePopoverViewModel(makeUsage({ percent: Number.NaN }))).toBeNull();
  });

  test('computes proportional breakdown bar segments and omits zero-width segments', () => {
    const viewModel = buildContextUsagePopoverViewModel(makeUsage({
      percent: 40,
      usedTokens: 80_000,
      contextTokens: 200_000,
      breakdown: {
        systemTokens: 10_000,
        toolsTokens: 0,
        messageTokens: 30_000,
      },
    }));

    expect(viewModel).toEqual({
      percent: 40,
      usedTokens: 80_000,
      contextTokens: 200_000,
      rows: [
        {
          key: ContextBreakdownSegmentKey.System,
          labelKey: 'coworkContextBreakdownSystem',
          tokens: 10_000,
          widthPercent: 10,
        },
        {
          key: ContextBreakdownSegmentKey.Tools,
          labelKey: 'coworkContextBreakdownTools',
          tokens: 0,
          widthPercent: 0,
        },
        {
          key: ContextBreakdownSegmentKey.Messages,
          labelKey: 'coworkContextBreakdownMessages',
          tokens: 30_000,
          widthPercent: 30,
        },
      ],
      barSegments: [
        { key: ContextBarSegmentKind.System, widthPercent: 10 },
        { key: ContextBarSegmentKind.Messages, widthPercent: 30 },
      ],
    });
  });

  test('falls back to a single total bar segment when breakdown is absent or zero', () => {
    expect(buildContextUsagePopoverViewModel(makeUsage({ percent: 135.4 }))).toEqual({
      percent: 100,
      usedTokens: 40_000,
      contextTokens: 200_000,
      rows: [],
      barSegments: [{ key: ContextBarSegmentKind.Total, widthPercent: 100 }],
    });

    expect(buildContextUsagePopoverViewModel(makeUsage({
      percent: 0,
      breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
    }))).toEqual({
      percent: 0,
      usedTokens: 40_000,
      contextTokens: 200_000,
      rows: [],
      barSegments: [],
    });
  });
});

describe('resolveContextCompactActionState', () => {
  test('hides manual compaction when no session is active or session is remote-managed', () => {
    expect(resolveContextCompactActionState({
      hasSession: false,
      remoteManaged: false,
      compacting: false,
      isSessionBusy: false,
      isSessionRunning: false,
    })).toEqual({ visible: false, disabled: true, blockedReasonKey: null });

    expect(resolveContextCompactActionState({
      hasSession: true,
      remoteManaged: true,
      compacting: false,
      isSessionBusy: false,
      isSessionRunning: false,
    })).toEqual({ visible: false, disabled: true, blockedReasonKey: null });
  });

  test('disables manual compaction with appropriate reason when compacting or running', () => {
    expect(resolveContextCompactActionState({
      hasSession: true,
      remoteManaged: false,
      compacting: true,
      isSessionBusy: false,
      isSessionRunning: false,
    })).toEqual({
      visible: true,
      disabled: true,
      blockedReasonKey: 'coworkContextCompacting',
    });

    expect(resolveContextCompactActionState({
      hasSession: true,
      remoteManaged: false,
      compacting: false,
      isSessionBusy: true,
      isSessionRunning: false,
    })).toEqual({
      visible: true,
      disabled: true,
      blockedReasonKey: 'coworkContextCompactBlockedRunning',
    });

    expect(resolveContextCompactActionState({
      hasSession: true,
      remoteManaged: false,
      compacting: false,
      isSessionBusy: false,
      isSessionRunning: true,
    })).toEqual({
      visible: true,
      disabled: true,
      blockedReasonKey: 'coworkContextCompactBlockedRunning',
    });
  });

  test('enables manual compaction when idle on a local session', () => {
    expect(resolveContextCompactActionState({
      hasSession: true,
      remoteManaged: false,
      compacting: false,
      isSessionBusy: false,
      isSessionRunning: false,
    })).toEqual({ visible: true, disabled: false, blockedReasonKey: null });
  });
});
