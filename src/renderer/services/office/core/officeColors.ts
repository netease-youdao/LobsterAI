/**
 * Office's theme color palette: each of the ten theme colors (Background 1, Text 1, Background 2,
 * Text 2, Accent 1–6) above five lighter or darker variants, as the color menus of Excel, Word and
 * PowerPoint list them.
 */

/** The tints of the palette under a color, which depend on how light it is. */
function themeVariants(hex: string): number[] {
  const [r, g, b] = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const lightness = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  if (lightness >= 1) return [-0.05, -0.15, -0.25, -0.35, -0.5];
  if (lightness <= 0) return [0.5, 0.35, 0.25, 0.15, 0.05];
  if (lightness > 0.8) return [-0.1, -0.25, -0.5, -0.75, -0.9];
  if (lightness < 0.2) return [0.9, 0.75, 0.5, 0.25, 0.1];
  return [0.8, 0.6, 0.4, -0.25, -0.5];
}

/** Office's tint: scale HSL luminance toward black (negative) or white (positive). */
export function applyTint(hex: string, tint: number): string {
  const [r, g, b] = [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  let rgb: number[];
  if (s === 0) rgb = [l, l, l];
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rgb = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  }
  return rgb.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('');
}

/** Each color (RRGGBB) with its variants, as #RRGGBB columns for the palette. */
export function themeColorGrid(colors: string[]): string[][] {
  return colors.map(base => [base, ...themeVariants(base).map(tint => applyTint(base, tint))].map(color => `#${color.toUpperCase()}`));
}
