export const RAIL_MAX_VISUAL_TICKS = 20;
export const RAIL_MAX_PLACEHOLDER_ITEMS = 20;
export const RAIL_OUTLINE_FILTER_THRESHOLD = 10;
export const RAIL_LINE_DEFAULT_WIDTH = 8;
export const RAIL_LINE_ACTIVE_WIDTH = 28;
export const RAIL_LINE_HOVER_STEPS = [28, 18, 13, 10] as const;
export const RAIL_LINE_HEIGHT = 3;

export const RAIL_OUTLINE_WIDTH_PX = 336;
export const RAIL_OUTLINE_MAX_HEIGHT_PX = 460;
export const RAIL_OUTLINE_MIN_HEIGHT_PX = 180;
export const RAIL_OUTLINE_VIEWPORT_PADDING_PX = 16;
export const RAIL_OUTLINE_GAP_PX = 10;

export interface ConversationRailItem {
  key: string;
  messageId: string | null;
  turnIndex: number;
  absoluteIndex: number;
  label: string;
  summary: string;
  timestamp: number | null;
  contentLen: number;
  isUser: boolean;
  isLoaded: boolean;
  isPlaceholder?: boolean;
}

export interface RailVisualTick {
  slotIndex: number;
  /** Real rail index navigated to when clicking this tick. */
  targetRailIndex: number;
  /** Inclusive range of real rail indices represented by this tick. */
  startRailIndex: number;
  endRailIndex: number;
  isActive: boolean;
}

export interface FilteredRailOutlineEntry {
  item: ConversationRailItem;
  railIndex: number;
}

export interface RailOutlinePopoverGeometry {
  top: number;
  right: number;
  width: number;
  maxHeight: number;
}

/**
 * Cap placeholder turn count before `messageRailIndex` arrives so sessions
 * heavy on tool calls do not flash hundreds of phantom ticks.
 */
export const computeCappedPlaceholderRailCount = (
  totalMessages: number,
  localItemCount: number,
  maxPlaceholders = RAIL_MAX_PLACEHOLDER_ITEMS,
): number => {
  const safeTotal = Math.max(0, Math.floor(totalMessages));
  const safeLocal = Math.max(0, Math.floor(localItemCount));
  if (safeTotal <= safeLocal) return safeLocal;
  const estimatedTurns = Math.max(safeLocal, Math.ceil(safeTotal / 2));
  return Math.min(estimatedTurns, Math.max(safeLocal, Math.max(1, Math.floor(maxPlaceholders))));
};

/**
 * Project any number of conversation turns onto at most `maxTicks` visual lines.
 * - Short/medium chats (<= maxTicks): 1-to-1 mapping.
 * - Long chats (> maxTicks): contiguous buckets spanning [0, totalItems - 1],
 *   with the active bucket anchored to `resolvedActiveIndex`, top tick mapped
 *   to the first turn, and bottom tick mapped to the latest turn.
 */
export const buildVisualRailTicks = (
  totalItems: number,
  resolvedActiveIndex: number,
  maxTicks = RAIL_MAX_VISUAL_TICKS,
): RailVisualTick[] => {
  const safeTotal = Math.max(0, Math.floor(totalItems));
  const safeMaxTicks = Math.max(2, Math.floor(maxTicks));
  if (safeTotal === 0) return [];

  const active = Math.max(0, Math.min(safeTotal - 1, Math.floor(resolvedActiveIndex)));

  if (safeTotal <= safeMaxTicks) {
    return Array.from({ length: safeTotal }, (_, index) => ({
      slotIndex: index,
      targetRailIndex: index,
      startRailIndex: index,
      endRailIndex: index,
      isActive: index === active,
    }));
  }

  return Array.from({ length: safeMaxTicks }, (_, slotIndex) => {
    const startRailIndex = Math.floor((slotIndex * safeTotal) / safeMaxTicks);
    const endRailIndex = Math.max(
      startRailIndex,
      Math.floor(((slotIndex + 1) * safeTotal) / safeMaxTicks) - 1,
    );
    const isActive = active >= startRailIndex && active <= endRailIndex;
    let targetRailIndex: number;
    if (isActive) {
      targetRailIndex = active;
    } else if (slotIndex === 0) {
      targetRailIndex = 0;
    } else if (slotIndex === safeMaxTicks - 1) {
      targetRailIndex = safeTotal - 1;
    } else {
      targetRailIndex = Math.floor((startRailIndex + endRailIndex) / 2);
    }

    return {
      slotIndex,
      targetRailIndex,
      startRailIndex,
      endRailIndex,
      isActive,
    };
  });
};

export const getVisualRailLineWidth = (
  slotIndex: number,
  activeSlotIndex: number,
  hoveredSlotIndex: number | null,
): number => {
  if (hoveredSlotIndex !== null) {
    const hoverDistance = Math.abs(slotIndex - hoveredSlotIndex);
    if (hoverDistance < RAIL_LINE_HOVER_STEPS.length) {
      return RAIL_LINE_HOVER_STEPS[hoverDistance];
    }
    return RAIL_LINE_DEFAULT_WIDTH;
  }

  return slotIndex === activeSlotIndex ? RAIL_LINE_ACTIVE_WIDTH : RAIL_LINE_DEFAULT_WIDTH;
};

export const filterRailOutlineItems = (
  items: readonly ConversationRailItem[],
  query: string,
): FilteredRailOutlineEntry[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return items.map((item, railIndex) => ({ item, railIndex }));
  }

  const numericQuery = normalized.startsWith('#') ? normalized.slice(1) : normalized;
  const isTurnNumberQuery = /^\d+$/.test(numericQuery);

  const matches: FilteredRailOutlineEntry[] = [];
  for (let railIndex = 0; railIndex < items.length; railIndex += 1) {
    const item = items[railIndex];
    const turnNumber = String(railIndex + 1);
    const matchesNumber = isTurnNumberQuery && turnNumber.includes(numericQuery);
    const matchesText = (
      item.label.toLowerCase().includes(normalized)
      || item.summary.toLowerCase().includes(normalized)
    );
    if (matchesNumber || matchesText) {
      matches.push({ item, railIndex });
    }
  }
  return matches;
};

export const getRailOutlinePopoverGeometry = (
  railRect: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
): RailOutlinePopoverGeometry => {
  const right = Math.max(
    RAIL_OUTLINE_VIEWPORT_PADDING_PX,
    viewport.width - railRect.left + RAIL_OUTLINE_GAP_PX,
  );
  const availableWidth = Math.max(
    220,
    viewport.width - right - RAIL_OUTLINE_VIEWPORT_PADDING_PX,
  );
  const width = Math.min(RAIL_OUTLINE_WIDTH_PX, availableWidth);
  const maxHeight = Math.min(
    RAIL_OUTLINE_MAX_HEIGHT_PX,
    Math.max(RAIL_OUTLINE_MIN_HEIGHT_PX, viewport.height - RAIL_OUTLINE_VIEWPORT_PADDING_PX * 4),
  );
  const railMidY = (railRect.top + railRect.bottom) / 2;
  const halfHeight = maxHeight / 2;
  const minCenterY = RAIL_OUTLINE_VIEWPORT_PADDING_PX + halfHeight;
  const maxCenterY = Math.max(minCenterY, viewport.height - RAIL_OUTLINE_VIEWPORT_PADDING_PX - halfHeight);
  const top = Math.max(minCenterY, Math.min(maxCenterY, railMidY));

  return { top, right, width, maxHeight };
};
