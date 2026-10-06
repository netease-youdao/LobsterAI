import {
  SkinParticleDensity,
  type SkinParticleDensity as SkinParticleDensityValue,
  SkinPreferredAppearance,
  type SkinPreferredAppearance as SkinPreferredAppearanceValue,
  SkinPresentationMode,
  type SkinPresentationMode as SkinPresentationModeValue,
} from './constants';

export interface SkinPresentationPalette {
  canvas: string;
  panel: string;
  panelRaised: string;
  accent: string;
  accentForeground: string;
  accentAlt: string;
  foreground: string;
  muted: string;
  border: string;
}

export interface SkinPresentationArt {
  focusX: number;
  focusY: number;
}

export interface SkinPresentationEffects {
  particleDensity: SkinParticleDensityValue;
}

export interface SkinPresentation {
  mode: SkinPresentationModeValue;
  preferredAppearance: SkinPreferredAppearanceValue;
  palette: SkinPresentationPalette;
  art?: SkinPresentationArt;
  effects?: SkinPresentationEffects;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasOnlyKeys = (record: Record<string, unknown>, allowedKeys: readonly string[]): boolean => {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every(key => allowed.has(key));
};

const normalizeHexColor = (value: unknown): string | null => (
  typeof value === 'string' && HEX_COLOR_PATTERN.test(value) ? value.toLowerCase() : null
);

const parseRgb = (color: string): [number, number, number] => [
  Number.parseInt(color.slice(1, 3), 16),
  Number.parseInt(color.slice(3, 5), 16),
  Number.parseInt(color.slice(5, 7), 16),
];

const linearizeChannel = (channel: number): number => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const relativeLuminance = (color: string): number => {
  const [red, green, blue] = parseRgb(color).map(linearizeChannel);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

export const inferSkinPreferredAppearance = (
  palette: SkinPresentationPalette,
): SkinPreferredAppearanceValue => {
  const surfaceLuminance = [
    palette.canvas,
    palette.panel,
    palette.panelRaised,
  ].reduce((total, color) => total + relativeLuminance(color), 0) / 3;
  return relativeLuminance(palette.foreground) > surfaceLuminance
    ? SkinPreferredAppearance.Dark
    : SkinPreferredAppearance.Light;
};

export const getSkinColorContrast = (left: string, right: string): number => {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
};

const hasAccessiblePalette = (palette: SkinPresentationPalette): boolean => {
  const surfaces = [palette.canvas, palette.panel, palette.panelRaised];
  return surfaces.every(surface => getSkinColorContrast(palette.foreground, surface) >= 4.5)
    && surfaces.every(surface => getSkinColorContrast(palette.muted, surface) >= 3)
    && surfaces.every(surface => getSkinColorContrast(palette.accent, surface) >= 3)
    && getSkinColorContrast(palette.accentForeground, palette.accent) >= 4.5;
};

const parsePalette = (value: unknown): SkinPresentationPalette | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'canvas',
    'panel',
    'panelRaised',
    'accent',
    'accentForeground',
    'accentAlt',
    'foreground',
    'muted',
    'border',
  ])) {
    return null;
  }

  const palette = {
    canvas: normalizeHexColor(value.canvas),
    panel: normalizeHexColor(value.panel),
    panelRaised: normalizeHexColor(value.panelRaised),
    accent: normalizeHexColor(value.accent),
    accentForeground: normalizeHexColor(value.accentForeground),
    accentAlt: normalizeHexColor(value.accentAlt),
    foreground: normalizeHexColor(value.foreground),
    muted: normalizeHexColor(value.muted),
    border: normalizeHexColor(value.border),
  };
  if (Object.values(palette).some(color => color === null)) return null;

  const normalized = palette as SkinPresentationPalette;
  return hasAccessiblePalette(normalized) ? normalized : null;
};

const parseArt = (value: unknown): SkinPresentationArt | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['focusX', 'focusY'])) return null;
  if (
    typeof value.focusX !== 'number'
    || !Number.isFinite(value.focusX)
    || value.focusX < 0
    || value.focusX > 1
    || typeof value.focusY !== 'number'
    || !Number.isFinite(value.focusY)
    || value.focusY < 0
    || value.focusY > 1
  ) {
    return null;
  }
  return { focusX: value.focusX, focusY: value.focusY };
};

const parseEffects = (value: unknown): SkinPresentationEffects | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['particleDensity'])) return null;
  if (!Object.values(SkinParticleDensity).includes(value.particleDensity as SkinParticleDensityValue)) {
    return null;
  }
  return { particleDensity: value.particleDensity as SkinParticleDensityValue };
};

export const parseSkinPresentation = (value: unknown): SkinPresentation | null => {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'mode',
    'preferredAppearance',
    'palette',
    'art',
    'effects',
  ])) {
    return null;
  }
  if (value.mode !== SkinPresentationMode.ImmersiveShell) return null;

  const palette = parsePalette(value.palette);
  if (!palette) return null;
  const preferredAppearance = inferSkinPreferredAppearance(palette);
  if (
    value.preferredAppearance !== undefined
    && value.preferredAppearance !== preferredAppearance
  ) {
    return null;
  }

  const art = value.art === undefined ? undefined : parseArt(value.art);
  if (value.art !== undefined && !art) return null;

  const effects = value.effects === undefined ? undefined : parseEffects(value.effects);
  if (value.effects !== undefined && !effects) return null;

  return {
    mode: SkinPresentationMode.ImmersiveShell,
    preferredAppearance,
    palette,
    ...(art ? { art } : {}),
    ...(effects ? { effects } : {}),
  };
};
