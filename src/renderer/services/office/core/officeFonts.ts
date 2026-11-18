/**
 * Office fonts are often missing on macOS and Linux, and a wider fallback changes where text
 * wraps: numbers overflow into "#####" in a grid, lines break differently on a slide. Where a
 * bundled, metric-compatible twin exists (OFL fonts with identical advance widths), it is
 * registered under the Office family name before the text is laid out.
 */

const fontUrls = import.meta.glob('../../../assets/office-fonts/*.{ttf,otf}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** Office family → bundled file prefix with identical advance widths. */
const METRIC_TWINS: Record<string, string> = {
  calibri: 'Carlito',
  cambria: 'Caladea',
  arial: 'LiberationSans',
  'times new roman': 'LiberationSerif',
  'courier new': 'LiberationMono',
};
const FACES = [
  { suffix: 'Regular', weight: '400', style: 'normal' },
  { suffix: 'Bold', weight: '700', style: 'normal' },
  { suffix: 'Italic', weight: '400', style: 'italic' },
  { suffix: 'BoldItalic', weight: '700', style: 'italic' },
] as const;
const SAMPLE = 'mmmmmmmmmmlli0123456789WQ';

const registered = new Map<string, Promise<void>>();

function isInstalled(family: string): boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return true;
  return ['monospace', 'serif', 'sans-serif'].some(base => {
    context.font = `72px ${base}`;
    const fallback = context.measureText(SAMPLE).width;
    context.font = `72px "${family}", ${base}`;
    return context.measureText(SAMPLE).width !== fallback;
  });
}

function urlOf(prefix: string, suffix: string): string | undefined {
  return Object.entries(fontUrls).find(([file]) => file.endsWith(`/${prefix}-${suffix}.ttf`))?.[1];
}

/** Register stand-ins for the document's missing Office fonts and wait until they can paint. */
export async function prepareOfficeFonts(families: Iterable<string>): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const family of new Set([...families].map(name => name.trim()).filter(Boolean))) {
    const key = family.toLowerCase();
    const twin = METRIC_TWINS[key];
    if (!twin) continue;
    let loading = registered.get(key);
    if (!loading) {
      loading = isInstalled(family) ? Promise.resolve() : Promise.all(FACES.map(async face => {
        const url = urlOf(twin, face.suffix);
        if (!url) return;
        const font = new FontFace(family, `url("${url}")`, { weight: face.weight, style: face.style });
        document.fonts.add(font);
        await font.load();
      })).then(() => undefined, error => { console.warn(`[OfficeFonts] Could not load a stand-in for ${family}:`, error); });
      registered.set(key, loading);
    }
    pending.push(loading);
  }
  await Promise.all(pending);
}
