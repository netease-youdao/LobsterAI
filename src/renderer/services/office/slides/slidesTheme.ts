import { el, elements, NS, num } from './slidesXml';

/** A theme's colors and fonts, and the style lists that shape style references point into. */
export interface ThemeView {
  /** dk1, lt1, dk2, lt2, accent1–6, hlink, folHlink → RRGGBB. */
  colors: Record<string, string>;
  fonts: { majorLatin: string; majorEastAsian: string; minorLatin: string; minorEastAsian: string };
  fillStyles: Element[];
  lineStyles: Element[];
  backgroundFillStyles: Element[];
}

/** Scheme color names as a slide uses them (bg1, tx1, …) → theme color names (lt1, dk1, …). */
export type ColorMap = Record<string, string>;

export interface Rgba {
  hex: string;
  alpha: number;
}

export const DEFAULT_COLOR_MAP: ColorMap = {
  bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2', accent3: 'accent3',
  accent4: 'accent4', accent5: 'accent5', accent6: 'accent6', hlink: 'hlink', folHlink: 'folHlink',
};

const PRESET_COLORS: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', orange: 'FFA500',
  gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', silver: 'C0C0C0', navy: '000080', purple: '800080',
};

const fontOf = (font: Element | undefined, script: string): string => {
  const eastAsian = el(font, 'a:ea')?.getAttribute('typeface');
  if (eastAsian) return eastAsian;
  return elements(font, 'a:font').find(item => item.getAttribute('script') === script)?.getAttribute('typeface') ?? '';
};

export function readTheme(doc: Document | undefined): ThemeView {
  const elementsRoot = doc ? el(doc.documentElement, 'a:themeElements') : undefined;
  const colors: Record<string, string> = {};
  for (const color of elements(el(elementsRoot, 'a:clrScheme'))) {
    const value = elements(color)[0];
    const hex = value?.localName === 'sysClr' ? value.getAttribute('lastClr') : value?.getAttribute('val');
    if (hex) colors[color.localName] = hex.toUpperCase();
  }
  const fontScheme = el(elementsRoot, 'a:fontScheme');
  const major = el(fontScheme, 'a:majorFont');
  const minor = el(fontScheme, 'a:minorFont');
  const format = el(elementsRoot, 'a:fmtScheme');
  return {
    colors,
    fonts: {
      majorLatin: el(major, 'a:latin')?.getAttribute('typeface') ?? 'Calibri Light',
      majorEastAsian: fontOf(major, 'Hans'),
      minorLatin: el(minor, 'a:latin')?.getAttribute('typeface') ?? 'Calibri',
      minorEastAsian: fontOf(minor, 'Hans'),
    },
    fillStyles: elements(el(format, 'a:fillStyleLst')),
    lineStyles: elements(el(format, 'a:lnStyleLst')),
    backgroundFillStyles: elements(el(format, 'a:bgFillStyleLst')),
  };
}

/** A `p:clrMap`, or a slide's `p:clrMapOvr` over the master's map. */
export function readColorMap(element: Element | undefined, base: ColorMap = DEFAULT_COLOR_MAP): ColorMap {
  const override = element?.localName === 'clrMapOvr' ? el(element, 'a:overrideClrMapping') : element;
  if (!override || !override.attributes.length) return base;
  const map: ColorMap = { ...base };
  for (const name of Object.keys(DEFAULT_COLOR_MAP)) {
    const value = override.getAttribute(name);
    if (value) map[name] = value;
  }
  return map;
}

const clamp = (value: number, low = 0, high = 1): number => Math.min(high, Math.max(low, value));

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue = (p: number, q: number, t: number): number => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
}

const hexOf = (rgb: [number, number, number]): string => rgb.map(channel => Math.round(clamp(channel) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Apply DrawingML color transforms (lumMod, tint, shade, alpha, …) in document order. */
function transform(hex: string, color: Element): Rgba {
  let rgb: [number, number, number] = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number];
  let alpha = 1;
  for (const modifier of elements(color)) {
    const value = (num(modifier, 'val') ?? 100000) / 100000;
    switch (modifier.localName) {
      case 'alpha': alpha = value; break;
      case 'tint': rgb = rgb.map(channel => channel + (1 - channel) * (1 - value)) as [number, number, number]; break;
      case 'shade': rgb = rgb.map(channel => channel * value) as [number, number, number]; break;
      case 'lumMod': case 'lumOff': case 'satMod': case 'satOff': case 'hueOff': case 'hueMod': {
        const [h, s, l] = toHsl(...rgb);
        const next: [number, number, number] = [h, s, l];
        if (modifier.localName === 'lumMod') next[2] = l * value;
        if (modifier.localName === 'lumOff') next[2] = l + value;
        if (modifier.localName === 'satMod') next[1] = s * value;
        if (modifier.localName === 'satOff') next[1] = s + value;
        if (modifier.localName === 'hueOff') next[0] = (h + (num(modifier, 'val') ?? 0) / 21600000 + 1) % 1;
        if (modifier.localName === 'hueMod') next[0] = (h * value) % 1;
        rgb = fromHsl(next[0], clamp(next[1]), clamp(next[2]));
        break;
      }
      case 'gray': { const gray = rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11; rgb = [gray, gray, gray]; break; }
      case 'inv': rgb = rgb.map(channel => 1 - channel) as [number, number, number]; break;
      default: break;
    }
  }
  return { hex: hexOf(rgb), alpha: clamp(alpha) };
}

export interface ColorContext {
  theme: ThemeView;
  map: ColorMap;
  /** What `phClr` stands for inside a style reference. */
  placeholder?: Rgba;
}

/** A DrawingML color element (srgbClr, schemeClr, sysClr, …) as RGBA. */
export function resolveColor(color: Element | undefined, context: ColorContext): Rgba | undefined {
  if (!color) return undefined;
  let hex: string | undefined;
  switch (color.localName) {
    case 'srgbClr': hex = color.getAttribute('val') ?? undefined; break;
    case 'sysClr': hex = color.getAttribute('lastClr') ?? (color.getAttribute('val') === 'window' ? 'FFFFFF' : '000000'); break;
    case 'prstClr': hex = PRESET_COLORS[color.getAttribute('val') ?? '']; break;
    case 'scrgbClr': hex = hexOf(['r', 'g', 'b'].map(name => (num(color, name) ?? 0) / 100000) as [number, number, number]); break;
    case 'hslClr': hex = hexOf(fromHsl((num(color, 'hue') ?? 0) / 21600000, (num(color, 'sat') ?? 0) / 100000, (num(color, 'lum') ?? 0) / 100000)); break;
    case 'schemeClr': {
      const name = color.getAttribute('val') ?? '';
      if (name === 'phClr') {
        if (!context.placeholder) return undefined;
        hex = context.placeholder.hex;
        break;
      }
      hex = context.theme.colors[context.map[name] ?? name];
      break;
    }
    default: return undefined;
  }
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? transform(hex.toUpperCase(), color) : undefined;
}

/** The first color element under a fill (a:solidFill) or a style reference. */
export const colorChild = (parent: Element | undefined): Element | undefined => elements(parent).find(child => child.namespaceURI === NS.a && child.localName.endsWith('Clr'));

export function cssColor(color: Rgba | undefined): string | undefined {
  if (!color) return undefined;
  if (color.alpha >= 1) return `#${color.hex}`;
  const [r, g, b] = [0, 2, 4].map(index => parseInt(color.hex.slice(index, index + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${Math.round(color.alpha * 1000) / 1000})`;
}

/** Map theme font aliases (+mj-lt, +mn-ea, …) to family names. */
export function resolveTypeface(typeface: string | null | undefined, theme: ThemeView): string | undefined {
  if (!typeface) return undefined;
  switch (typeface) {
    case '+mj-lt': return theme.fonts.majorLatin;
    case '+mn-lt': return theme.fonts.minorLatin;
    case '+mj-ea': return theme.fonts.majorEastAsian || undefined;
    case '+mn-ea': return theme.fonts.minorEastAsian || undefined;
    case '+mj-cs': case '+mn-cs': return undefined;
    default: return typeface;
  }
}
