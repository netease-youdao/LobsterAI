import type { CoworkContextUsage } from '../../types/cowork';

export const ContextBreakdownSegmentKey = {
  System: 'system',
  Tools: 'tools',
  Messages: 'messages',
} as const;
export type ContextBreakdownSegmentKey =
  typeof ContextBreakdownSegmentKey[keyof typeof ContextBreakdownSegmentKey];

export const ContextBarSegmentKind = {
  System: ContextBreakdownSegmentKey.System,
  Tools: ContextBreakdownSegmentKey.Tools,
  Messages: ContextBreakdownSegmentKey.Messages,
  Total: 'total',
} as const;
export type ContextBarSegmentKind =
  typeof ContextBarSegmentKind[keyof typeof ContextBarSegmentKind];

export interface ContextBreakdownRow {
  key: ContextBreakdownSegmentKey;
  labelKey: string;
  tokens: number;
  widthPercent: number;
}

export interface ContextBarSegment {
  key: ContextBarSegmentKind;
  widthPercent: number;
}

export interface ContextUsagePopoverViewModel {
  percent: number;
  usedTokens?: number;
  contextTokens?: number;
  rows: ContextBreakdownRow[];
  barSegments: ContextBarSegment[];
}

const BREAKDOWN_ROW_DEFS: ReadonlyArray<{
  key: ContextBreakdownSegmentKey;
  field: 'systemTokens' | 'toolsTokens' | 'messageTokens';
  labelKey: string;
}> = [
  {
    key: ContextBreakdownSegmentKey.System,
    field: 'systemTokens',
    labelKey: 'coworkContextBreakdownSystem',
  },
  {
    key: ContextBreakdownSegmentKey.Tools,
    field: 'toolsTokens',
    labelKey: 'coworkContextBreakdownTools',
  },
  {
    key: ContextBreakdownSegmentKey.Messages,
    field: 'messageTokens',
    labelKey: 'coworkContextBreakdownMessages',
  },
];

export function buildContextUsagePopoverViewModel(
  usage: CoworkContextUsage | undefined,
): ContextUsagePopoverViewModel | null {
  if (!usage || typeof usage.percent !== 'number' || !Number.isFinite(usage.percent)) {
    return null;
  }

  const percent = Math.min(100, Math.max(0, Math.round(usage.percent)));
  const breakdown = usage.breakdown;
  const breakdownTotal = breakdown
    ? Math.max(0, breakdown.systemTokens) + Math.max(0, breakdown.toolsTokens) + Math.max(0, breakdown.messageTokens)
    : 0;

  if (!breakdown || breakdownTotal <= 0) {
    return {
      percent,
      usedTokens: usage.usedTokens,
      contextTokens: usage.contextTokens,
      rows: [],
      barSegments: percent > 0 ? [{ key: ContextBarSegmentKind.Total, widthPercent: percent }] : [],
    };
  }

  const rows: ContextBreakdownRow[] = BREAKDOWN_ROW_DEFS.map((def) => {
    const tokens = Math.max(0, breakdown[def.field]);
    return {
      key: def.key,
      labelKey: def.labelKey,
      tokens,
      widthPercent: percent > 0 ? (percent * tokens) / breakdownTotal : 0,
    };
  });

  const barSegments: ContextBarSegment[] = rows
    .filter((row) => row.widthPercent > 0)
    .map((row) => ({
      key: row.key,
      widthPercent: row.widthPercent,
    }));

  return {
    percent,
    usedTokens: usage.usedTokens,
    contextTokens: usage.contextTokens,
    rows,
    barSegments,
  };
}

export interface ContextCompactActionState {
  visible: boolean;
  disabled: boolean;
  blockedReasonKey: string | null;
}

export function resolveContextCompactActionState(input: {
  hasSession: boolean;
  remoteManaged: boolean;
  compacting: boolean;
  isSessionBusy: boolean;
  isSessionRunning: boolean;
}): ContextCompactActionState {
  if (!input.hasSession || input.remoteManaged) {
    return {
      visible: false,
      disabled: true,
      blockedReasonKey: null,
    };
  }
  if (input.compacting) {
    return {
      visible: true,
      disabled: true,
      blockedReasonKey: 'coworkContextCompacting',
    };
  }
  if (input.isSessionBusy || input.isSessionRunning) {
    return {
      visible: true,
      disabled: true,
      blockedReasonKey: 'coworkContextCompactBlockedRunning',
    };
  }
  return {
    visible: true,
    disabled: false,
    blockedReasonKey: null,
  };
}
