export interface CoworkBtwPanelGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CoworkBtwPanelViewport {
  width: number;
  height: number;
}

export interface CoworkBtwPanelAnchor {
  top: number;
  right: number;
  width: number;
  height: number;
}

export const CoworkBtwResizeDirection = {
  Top: 'top',
  TopRight: 'top-right',
  Right: 'right',
  BottomRight: 'bottom-right',
  Bottom: 'bottom',
  BottomLeft: 'bottom-left',
  Left: 'left',
  TopLeft: 'top-left',
} as const;
export type CoworkBtwResizeDirection =
  typeof CoworkBtwResizeDirection[keyof typeof CoworkBtwResizeDirection];

export const COWORK_BTW_PANEL_MARGIN = 16;
export const COWORK_BTW_PANEL_DEFAULT_WIDTH = 340;
export const COWORK_BTW_PANEL_DEFAULT_HEIGHT = 380;
export const COWORK_BTW_PANEL_MIN_WIDTH = 320;
export const COWORK_BTW_PANEL_MIN_HEIGHT = 320;
export const COWORK_BTW_PANEL_ANCHOR_GAP = 16;

const clamp = (value: number, minimum: number, maximum: number): number => (
  Math.min(Math.max(value, minimum), maximum)
);

const getAvailableSize = (value: number): number => (
  Math.max(1, value - COWORK_BTW_PANEL_MARGIN * 2)
);

const isUsableAnchor = (
  anchor: CoworkBtwPanelAnchor | undefined,
): anchor is CoworkBtwPanelAnchor => Boolean(
  anchor
  && Number.isFinite(anchor.top)
  && Number.isFinite(anchor.right)
  && Number.isFinite(anchor.width)
  && Number.isFinite(anchor.height)
  && anchor.width > 0
  && anchor.height > 0
);

export const clampCoworkBtwPanelGeometry = (
  geometry: CoworkBtwPanelGeometry,
  viewport: CoworkBtwPanelViewport,
): CoworkBtwPanelGeometry => {
  const availableWidth = getAvailableSize(viewport.width);
  const availableHeight = getAvailableSize(viewport.height);
  const minimumWidth = Math.min(COWORK_BTW_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(COWORK_BTW_PANEL_MIN_HEIGHT, availableHeight);
  const width = clamp(geometry.width, minimumWidth, availableWidth);
  const height = clamp(geometry.height, minimumHeight, availableHeight);
  return {
    x: clamp(
      geometry.x,
      COWORK_BTW_PANEL_MARGIN,
      Math.max(COWORK_BTW_PANEL_MARGIN, viewport.width - width - COWORK_BTW_PANEL_MARGIN),
    ),
    y: clamp(
      geometry.y,
      COWORK_BTW_PANEL_MARGIN,
      Math.max(COWORK_BTW_PANEL_MARGIN, viewport.height - height - COWORK_BTW_PANEL_MARGIN),
    ),
    width,
    height,
  };
};

export const getInitialCoworkBtwPanelGeometry = (
  viewport: CoworkBtwPanelViewport,
  anchor?: CoworkBtwPanelAnchor,
): CoworkBtwPanelGeometry => {
  const usableAnchor = isUsableAnchor(anchor) ? anchor : undefined;
  return clampCoworkBtwPanelGeometry({
    x: usableAnchor
      ? usableAnchor.right - COWORK_BTW_PANEL_DEFAULT_WIDTH
      : viewport.width - COWORK_BTW_PANEL_DEFAULT_WIDTH - COWORK_BTW_PANEL_MARGIN,
    y: usableAnchor
      ? usableAnchor.top - COWORK_BTW_PANEL_DEFAULT_HEIGHT - COWORK_BTW_PANEL_ANCHOR_GAP
      : viewport.height - COWORK_BTW_PANEL_DEFAULT_HEIGHT - COWORK_BTW_PANEL_MARGIN,
    width: COWORK_BTW_PANEL_DEFAULT_WIDTH,
    height: COWORK_BTW_PANEL_DEFAULT_HEIGHT,
  }, viewport);
};

export const resizeCoworkBtwPanelGeometry = (
  geometry: CoworkBtwPanelGeometry,
  deltaX: number,
  deltaY: number,
  direction: CoworkBtwResizeDirection,
  viewport: CoworkBtwPanelViewport,
): CoworkBtwPanelGeometry => {
  const start = clampCoworkBtwPanelGeometry(geometry, viewport);
  const availableWidth = getAvailableSize(viewport.width);
  const availableHeight = getAvailableSize(viewport.height);
  const minimumWidth = Math.min(COWORK_BTW_PANEL_MIN_WIDTH, availableWidth);
  const minimumHeight = Math.min(COWORK_BTW_PANEL_MIN_HEIGHT, availableHeight);
  const startRight = start.x + start.width;
  const startBottom = start.y + start.height;
  let left = start.x;
  let right = startRight;
  let top = start.y;
  let bottom = startBottom;

  if (
    direction === CoworkBtwResizeDirection.Left
    || direction === CoworkBtwResizeDirection.TopLeft
    || direction === CoworkBtwResizeDirection.BottomLeft
  ) {
    left = clamp(
      start.x + deltaX,
      COWORK_BTW_PANEL_MARGIN,
      startRight - minimumWidth,
    );
  } else if (
    direction === CoworkBtwResizeDirection.Right
    || direction === CoworkBtwResizeDirection.TopRight
    || direction === CoworkBtwResizeDirection.BottomRight
  ) {
    right = clamp(
      startRight + deltaX,
      start.x + minimumWidth,
      viewport.width - COWORK_BTW_PANEL_MARGIN,
    );
  }

  if (
    direction === CoworkBtwResizeDirection.Top
    || direction === CoworkBtwResizeDirection.TopLeft
    || direction === CoworkBtwResizeDirection.TopRight
  ) {
    top = clamp(
      start.y + deltaY,
      COWORK_BTW_PANEL_MARGIN,
      startBottom - minimumHeight,
    );
  } else if (
    direction === CoworkBtwResizeDirection.Bottom
    || direction === CoworkBtwResizeDirection.BottomLeft
    || direction === CoworkBtwResizeDirection.BottomRight
  ) {
    bottom = clamp(
      startBottom + deltaY,
      start.y + minimumHeight,
      viewport.height - COWORK_BTW_PANEL_MARGIN,
    );
  }

  return clampCoworkBtwPanelGeometry({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }, viewport);
};
