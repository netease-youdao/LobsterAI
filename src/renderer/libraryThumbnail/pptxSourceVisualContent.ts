type UnknownRecord = Record<string, unknown>;

interface PptxFillLike {
  type?: unknown;
  color?: unknown;
  alpha?: unknown;
  gsList?: unknown;
}

interface PptxSourceNodeLike {
  background?: unknown;
  border?: unknown;
  extend?: unknown;
  nodes?: unknown;
  options?: unknown;
  path?: unknown;
  source?: unknown;
  tr?: unknown;
  userDrawn?: unknown;
}

interface PptxSlideContextLike {
  background?: unknown;
  nodes?: unknown;
  slideMaster?: unknown;
}

export interface PptxSlideSourceLike extends PptxSlideContextLike {
  slideLayout?: unknown;
  slideMaster?: unknown;
}

export interface PptxDocumentSourceLike {
  slides?: PptxSlideSourceLike[];
}

export interface PptxSourceVisualContent {
  sourceHasVisualContent: boolean;
  sourceVisualElementCount: number;
}

const VISUAL_SOURCE_KEYS = new Set([
  'a:blip',
  'a:gradFill',
  'p:cxnSp',
  'p:graphicFrame',
  'p:pic',
]);

const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const getFillType = (value: unknown): string => {
  if (!isRecord(value) || typeof value.type !== 'string') return 'none';
  return value.type.trim();
};

const parseHexColor = (value: unknown): [number, number, number] | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^#/, '');
  const expanded = normalized.length === 3
    ? normalized.split('').map(character => character.repeat(2)).join('')
    : normalized;
  if (!/^[\da-f]{6}$/i.test(expanded)) return undefined;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
};

const isNearWhite = (value: unknown): boolean => {
  const rgb = parseHexColor(value);
  return Boolean(rgb && rgb.every(channel => channel >= 245));
};

const isVisibleFill = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const fill = value as PptxFillLike;
  const type = getFillType(fill);
  if (!type || type === 'none') return false;
  if (typeof fill.alpha === 'number' && fill.alpha <= 0.01) return false;
  if (type === 'blipFill') return true;
  if (type === 'solidFill') return !isNearWhite(fill.color);
  if (type === 'gradFill') {
    if (!Array.isArray(fill.gsList) || fill.gsList.length === 0) return true;
    return fill.gsList.some(stop => (
      !isRecord(stop)
      || !isRecord(stop.color)
      || !isNearWhite(stop.color.color)
    ));
  }
  return true;
};

const hasDeepSourceSignal = (
  value: unknown,
  matchKey: (key: string, child: unknown) => boolean,
  seen = new WeakSet<object>(),
): boolean => {
  if (Array.isArray(value)) {
    return value.some(child => hasDeepSourceSignal(child, matchKey, seen));
  }
  if (!isRecord(value)) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, child]) => (
    matchKey(key, child) || hasDeepSourceSignal(child, matchKey, seen)
  ));
};

const containsDrawingText = (source: unknown): boolean => hasDeepSourceSignal(
  source,
  (key, value) => key === 'a:t'
    && (
      (typeof value === 'string' && value.trim().length > 0)
      || (Array.isArray(value) && value.some(item => typeof item === 'string' && item.trim()))
    ),
);

const containsVisualSourceMarker = (source: unknown): boolean => hasDeepSourceSignal(
  source,
  key => VISUAL_SOURCE_KEYS.has(key),
);

const containsPlaceholderMarker = (source: unknown): boolean => hasDeepSourceSignal(
  source,
  key => key === 'p:ph',
);

const isVisibleBorder = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length === 0 || value.type === 'none') return false;
  if (typeof value.alpha === 'number' && value.alpha <= 0.01) return false;
  if (typeof value.width === 'number' && value.width <= 0) return false;
  const color = isRecord(value.color) ? value.color.color : value.color;
  return color === undefined || !isNearWhite(color);
};

const hasPositiveExtent = (value: unknown): boolean => (
  isRecord(value)
  && typeof value.w === 'number'
  && typeof value.h === 'number'
  && value.w > 0
  && value.h > 0
);

const countVisualNodes = (
  nodes: unknown,
  inheritedOnly: boolean,
): number => {
  if (!Array.isArray(nodes)) return 0;
  return nodes.reduce<number>((count, value) => {
    if (!isRecord(value)) return count;
    const node = value as PptxSourceNodeLike;
    if (inheritedOnly && node.userDrawn !== true) return count;

    const nestedCount = countVisualNodes(node.nodes, false);
    if (nestedCount > 0) return count + nestedCount;
    if (typeof node.path === 'string') return count + 1;
    if (Array.isArray(node.tr)) return count + 1;
    if (isRecord(node.options)) return count + 1;
    if (containsDrawingText(node.source)) return count + 1;
    if (isVisibleFill(node.background) || isVisibleBorder(node.border)) return count + 1;
    if (containsVisualSourceMarker(node.source)) return count + 1;
    if (
      node.userDrawn === true
      && hasPositiveExtent(node.extend)
      && !containsPlaceholderMarker(node.source)
    ) {
      return count + 1;
    }
    return count;
  }, 0);
};

const asSlideContext = (value: unknown): PptxSlideContextLike | undefined => (
  isRecord(value) ? value as PptxSlideContextLike : undefined
);

const getEffectiveBackground = (
  slide: PptxSlideSourceLike,
  layout: PptxSlideContextLike | undefined,
  master: PptxSlideContextLike | undefined,
): unknown => [slide.background, layout?.background, master?.background]
  .find(background => getFillType(background) !== 'none');

export const analyzePptxFirstSlideSource = (
  presentation: PptxDocumentSourceLike | undefined,
): PptxSourceVisualContent => {
  const slide = presentation?.slides?.[0];
  if (!slide) {
    return { sourceHasVisualContent: false, sourceVisualElementCount: 0 };
  }

  const layout = asSlideContext(slide.slideLayout);
  const master = asSlideContext(slide.slideMaster ?? layout?.slideMaster);
  const sourceVisualElementCount = (
    (isVisibleFill(getEffectiveBackground(slide, layout, master)) ? 1 : 0)
    + countVisualNodes(slide.nodes, false)
    + countVisualNodes(layout?.nodes, true)
    + countVisualNodes(master?.nodes, true)
  );
  return {
    sourceHasVisualContent: sourceVisualElementCount > 0,
    sourceVisualElementCount,
  };
};
