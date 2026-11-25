import {
  type AgentAvatarSvg,
  DefaultAgentAvatar,
  parseAgentAvatarIcon,
  parseAgentAvatarImageUrl,
} from '@shared/agent/avatar';

export const AgentAvatarPickerVariant = {
  Compact: 'compact',
  Hero: 'hero',
} as const;
export type AgentAvatarPickerVariant =
  typeof AgentAvatarPickerVariant[keyof typeof AgentAvatarPickerVariant];

export const AgentAvatarPickerAlign = {
  Start: 'start',
  Center: 'center',
} as const;
export type AgentAvatarPickerAlign =
  typeof AgentAvatarPickerAlign[keyof typeof AgentAvatarPickerAlign];

export const AVATAR_PICKER_POPOVER_WIDTH_PX = 324;
export const AVATAR_PICKER_ESTIMATED_HEIGHT_PX = 316;
export const AVATAR_PICKER_EDGE_GAP_PX = 8;
export const AVATAR_PICKER_TRIGGER_GAP_PX = 8;

export interface AvatarPopoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface AvatarPopoverPosition {
  top: number;
  left: number;
}

/**
 * Resolve which SVG option should appear active in the picker grid.
 * Preset image URLs and managed preset fallback avatars do not highlight
 * a fallback SVG icon because no SVG icon is currently displayed.
 */
export function resolveSelectedAvatarSvg(
  value: string | null | undefined,
  expertFallback = false,
): AgentAvatarSvg | null {
  if (expertFallback || parseAgentAvatarImageUrl(value)) {
    return null;
  }
  return (parseAgentAvatarIcon(value) ?? DefaultAgentAvatar).svg;
}

export function computeAvatarPopoverPosition({
  anchorRect,
  popoverWidth,
  popoverHeight,
  viewportWidth,
  viewportHeight,
  align = AgentAvatarPickerAlign.Start,
  gap = AVATAR_PICKER_TRIGGER_GAP_PX,
  edgePadding = AVATAR_PICKER_EDGE_GAP_PX,
}: {
  anchorRect: AvatarPopoverRect;
  popoverWidth: number;
  popoverHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  align?: AgentAvatarPickerAlign;
  gap?: number;
  edgePadding?: number;
}): AvatarPopoverPosition {
  const preferredLeft = align === AgentAvatarPickerAlign.Center
    ? anchorRect.left + (anchorRect.width - popoverWidth) / 2
    : anchorRect.left;
  const maxLeft = Math.max(edgePadding, viewportWidth - popoverWidth - edgePadding);
  const left = Math.max(edgePadding, Math.min(preferredLeft, maxLeft));

  const spaceBelow = viewportHeight - anchorRect.bottom;
  const openAbove = spaceBelow < popoverHeight + gap + edgePadding && anchorRect.top > spaceBelow;
  const preferredTop = openAbove
    ? anchorRect.top - popoverHeight - gap
    : anchorRect.bottom + gap;
  const maxTop = Math.max(edgePadding, viewportHeight - popoverHeight - edgePadding);
  const top = Math.max(edgePadding, Math.min(preferredTop, maxTop));

  return { top, left };
}
