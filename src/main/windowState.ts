export const AppWindowStoreKey = {
  State: 'app_window_state',
} as const;

export const DEFAULT_APP_WINDOW_WIDTH = 1280;
export const DEFAULT_APP_WINDOW_HEIGHT = 800;
export const MIN_APP_WINDOW_WIDTH = 800;
export const MIN_APP_WINDOW_HEIGHT = 600;

// Side gutters keep a window from reading as maximized. There is no vertical gutter:
// on laptop screens the dock/taskbar already makes height the tight dimension.
const DEFAULT_WINDOW_SIDE_MARGIN = 24;

export type WindowRectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AppWindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
};

export type ResolvedAppWindowState = WindowRectangle & {
  isMaximized: boolean;
};

const FALLBACK_WORK_AREA: WindowRectangle = {
  x: 0,
  y: 0,
  width: DEFAULT_APP_WINDOW_WIDTH,
  height: DEFAULT_APP_WINDOW_HEIGHT,
};

const toFiniteNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const clamp = (value: number, min: number, max: number): number => {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
};

const normalizeWorkAreas = (workAreas: WindowRectangle[]): WindowRectangle[] => {
  const normalized = workAreas
    .map((area) => ({
      x: Math.round(area.x),
      y: Math.round(area.y),
      width: Math.round(area.width),
      height: Math.round(area.height),
    }))
    .filter((area) => area.width > 0 && area.height > 0);

  return normalized.length > 0 ? normalized : [FALLBACK_WORK_AREA];
};

export const normalizeAppWindowState = (value: unknown): AppWindowState | undefined => {
  if (!value || typeof value !== 'object') return undefined;

  const candidate = value as Record<string, unknown>;
  const width = toFiniteNumber(candidate.width);
  const height = toFiniteNumber(candidate.height);
  if (!width || !height || width <= 0 || height <= 0) return undefined;

  const x = toFiniteNumber(candidate.x);
  const y = toFiniteNumber(candidate.y);

  return {
    ...(x === undefined ? {} : { x: Math.round(x) }),
    ...(y === undefined ? {} : { y: Math.round(y) }),
    width: Math.round(width),
    height: Math.round(height),
    isMaximized: candidate.isMaximized === true,
  };
};

const centerBounds = (
  size: { width: number; height: number },
  workArea: WindowRectangle,
): WindowRectangle => ({
  x: workArea.x + Math.round((workArea.width - size.width) / 2),
  y: workArea.y + Math.round((workArea.height - size.height) / 2),
  width: size.width,
  height: size.height,
});

const resolveMaxWindowSize = (workArea: WindowRectangle): { width: number; height: number } => ({
  width: workArea.width - DEFAULT_WINDOW_SIDE_MARGIN * 2,
  height: workArea.height,
});

const resolveDefaultBounds = (workArea: WindowRectangle): WindowRectangle => {
  const maxSize = resolveMaxWindowSize(workArea);
  // Fit each dimension on its own: scaling proportionally would also narrow the
  // window whenever only the height is short.
  const size = {
    width: clamp(DEFAULT_APP_WINDOW_WIDTH, MIN_APP_WINDOW_WIDTH, maxSize.width),
    height: clamp(DEFAULT_APP_WINDOW_HEIGHT, MIN_APP_WINDOW_HEIGHT, maxSize.height),
  };

  return centerBounds(size, workArea);
};

const containsPoint = (
  area: WindowRectangle,
  point: { x: number; y: number },
): boolean => (
  point.x >= area.x
  && point.x <= area.x + area.width
  && point.y >= area.y
  && point.y <= area.y + area.height
);

const intersects = (a: WindowRectangle, b: WindowRectangle): boolean => (
  a.x < b.x + b.width
  && a.x + a.width > b.x
  && a.y < b.y + b.height
  && a.y + a.height > b.y
);

const selectWorkArea = (
  stored: AppWindowState,
  workAreas: WindowRectangle[],
): WindowRectangle => {
  if (typeof stored.x === 'number' && typeof stored.y === 'number') {
    const storedBounds = {
      x: stored.x,
      y: stored.y,
      width: stored.width,
      height: stored.height,
    };
    const center = {
      x: stored.x + stored.width / 2,
      y: stored.y + stored.height / 2,
    };

    return workAreas.find((area) => containsPoint(area, center))
      ?? workAreas.find((area) => intersects(area, storedBounds))
      ?? workAreas[0];
  }

  return workAreas[0];
};

const fitStoredBounds = (
  stored: AppWindowState,
  workArea: WindowRectangle,
): WindowRectangle => {
  const originalBounds = {
    x: stored.x ?? workArea.x,
    y: stored.y ?? workArea.y,
    width: Math.max(MIN_APP_WINDOW_WIDTH, Math.round(stored.width)),
    height: Math.max(MIN_APP_WINDOW_HEIGHT, Math.round(stored.height)),
  };
  const maxSize = resolveMaxWindowSize(workArea);
  // Keep a size that already fits. Only a dimension that overflows the work area
  // (e.g. bounds saved on a larger display) is fitted the way a fresh window is.
  const width = originalBounds.width <= workArea.width
    ? originalBounds.width
    : clamp(originalBounds.width, MIN_APP_WINDOW_WIDTH, maxSize.width);
  const height = clamp(originalBounds.height, MIN_APP_WINDOW_HEIGHT, maxSize.height);
  const fallback = centerBounds({ width, height }, workArea);
  const hasVisiblePosition = typeof stored.x === 'number'
    && typeof stored.y === 'number'
    && intersects(originalBounds, workArea);
  const x = clamp(
    Math.round(hasVisiblePosition ? stored.x ?? fallback.x : fallback.x),
    workArea.x,
    workArea.x + Math.max(0, workArea.width - width),
  );
  const y = clamp(
    Math.round(hasVisiblePosition ? stored.y ?? fallback.y : fallback.y),
    workArea.y,
    workArea.y + Math.max(0, workArea.height - height),
  );

  return { x, y, width, height };
};

export const resolveInitialAppWindowState = (
  storedValue: unknown,
  workAreas: WindowRectangle[],
): ResolvedAppWindowState => {
  const normalizedWorkAreas = normalizeWorkAreas(workAreas);
  const stored = normalizeAppWindowState(storedValue);

  if (!stored) {
    return {
      ...resolveDefaultBounds(normalizedWorkAreas[0]),
      isMaximized: false,
    };
  }

  return {
    ...fitStoredBounds(stored, selectWorkArea(stored, normalizedWorkAreas)),
    isMaximized: stored.isMaximized === true,
  };
};
