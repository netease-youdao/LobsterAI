export const EnterpriseMenuFlyoutLayout = {
  Gap: 6,
  ViewportPadding: 8,
} as const;

interface EnterpriseMenuFlyoutAnchor {
  left: number;
  right: number;
  top: number;
}

interface EnterpriseMenuFlyoutSize {
  width: number;
  height: number;
}

interface EnterpriseMenuFlyoutViewport {
  width: number;
  height: number;
}

export interface EnterpriseMenuFlyoutPosition {
  left: number;
  top: number;
}

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
);

export function resolveEnterpriseMenuFlyoutPosition(
  anchor: EnterpriseMenuFlyoutAnchor,
  flyout: EnterpriseMenuFlyoutSize,
  viewport: EnterpriseMenuFlyoutViewport,
): EnterpriseMenuFlyoutPosition {
  const { Gap: gap, ViewportPadding: viewportPadding } = EnterpriseMenuFlyoutLayout;
  const maximumLeft = Math.max(
    viewportPadding,
    viewport.width - flyout.width - viewportPadding,
  );
  const preferredRightPosition = anchor.right + gap;
  const preferredLeftPosition = anchor.left - flyout.width - gap;

  let left: number;
  if (preferredRightPosition <= maximumLeft) {
    left = preferredRightPosition;
  } else if (preferredLeftPosition >= viewportPadding) {
    left = preferredLeftPosition;
  } else {
    left = clamp(preferredRightPosition, viewportPadding, maximumLeft);
  }

  const maximumTop = Math.max(
    viewportPadding,
    viewport.height - flyout.height - viewportPadding,
  );

  return {
    left,
    top: clamp(anchor.top, viewportPadding, maximumTop),
  };
}
