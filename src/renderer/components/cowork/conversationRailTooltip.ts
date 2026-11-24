import { formatMessageDateTime } from '../../utils/tokenFormat';

export interface RailTooltipItemLike {
  label: string;
  summary: string;
  timestamp: number | null;
  isPlaceholder?: boolean;
}

export interface RailTooltipLabels {
  unloadedTitle: string;
  unloadedHint: string;
  turnPositionTemplate: string;
}

export interface RailTooltipContent {
  title: string;
  summary: string;
  turnPosition: string;
  timestampText: string;
}

const isValidPositiveTimestamp = (value: number | null | undefined): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

export const resolveRailTurnTimestamp = (
  userTimestamp: number | null | undefined,
  assistantTimestamp: number | null | undefined,
): number | null => {
  if (isValidPositiveTimestamp(userTimestamp)) {
    return userTimestamp;
  }
  if (isValidPositiveTimestamp(assistantTimestamp)) {
    return assistantTimestamp;
  }
  return null;
};

export const formatRailTurnPosition = (
  railIndex: number,
  totalCount: number,
  template: string,
): string => {
  if (!Number.isInteger(railIndex) || !Number.isInteger(totalCount)) return '';
  if (totalCount <= 0 || railIndex < 0 || railIndex >= totalCount) return '';
  return template
    .replace('{current}', String(railIndex + 1))
    .replace('{total}', String(totalCount));
};

export const formatRailTooltipTimestamp = (
  timestamp: number | null | undefined,
): string => {
  if (!isValidPositiveTimestamp(timestamp)) return '';
  return formatMessageDateTime(timestamp);
};

export const buildRailTooltipContent = ({
  item,
  railIndex,
  totalCount,
  hasPlaceholderItems,
  labels,
}: {
  item: RailTooltipItemLike;
  railIndex: number;
  totalCount: number;
  hasPlaceholderItems: boolean;
  labels: RailTooltipLabels;
}): RailTooltipContent => {
  if (item.isPlaceholder) {
    return {
      title: labels.unloadedTitle,
      summary: labels.unloadedHint,
      turnPosition: '',
      timestampText: '',
    };
  }

  return {
    title: item.label,
    summary: item.summary,
    turnPosition: hasPlaceholderItems
      ? ''
      : formatRailTurnPosition(railIndex, totalCount, labels.turnPositionTemplate),
    timestampText: formatRailTooltipTimestamp(item.timestamp),
  };
};
