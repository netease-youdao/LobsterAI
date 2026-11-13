import type { PptAsset, PptText } from './constants';

export const PptCover = {
  DefaultImageModel: 'doubao-seedream-5-0-pro-260628',
  Width: 1280, Height: 720, Font: 'Microsoft YaHei',
  MaxImageBytes: 20 * 1024 * 1024, MaxPixels: 40_000_000,
  DraftKey: 'ppt-cover.v1',
} as const;
export const PptCoverIpc = { Template: 'ppt-cover:template', Export: 'ppt-cover:export' } as const;
export const CoverIllustration = { Reuse: 'reuse', Generate: 'generate' } as const;
export type CoverIllustration = typeof CoverIllustration[keyof typeof CoverIllustration];
export const CoverStep = { Content: 0, Preview: 1, Export: 2 } as const;
export const CoverTaskState = { Running: 'running', Ready: 'ready', Failed: 'failed' } as const;
export interface PptCoverRecipe {
  file: PptAsset; title: PptText; subtitle: PptText; footer: PptText; subject: PptText;
}
export interface PptCoverFields { title: string; subtitle: string; footer: string }
export interface PptCoverRequest { version: string; exampleId: string }
export interface PptCoverExportRequest extends PptCoverRequest { fields: PptCoverFields; imageBase64?: string }
export interface CoverTextLine { text: string; x: number; y: number; width: number; height: number; size: number; color: string; bold: boolean }

export function validateCoverFields(value: PptCoverFields): PptCoverFields {
  if (!value || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 50
    || typeof value.subtitle !== 'string' || value.subtitle.length > 90
    || typeof value.footer !== 'string' || value.footer.length > 50
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value.title + value.subtitle + value.footer)) throw new Error('Invalid cover text');
  return { title: value.title.trim(), subtitle: value.subtitle.trim(), footer: value.footer.trim() };
}

// Conservative glyph advances keep the same line breaks in the preview and PPTX,
// including on machines where the configured font uses a fallback.
const advance = (character: string) => /[\u0020-\u007e]/.test(character) ? (/[MW@#%]/.test(character) ? 0.94 : 0.64) : 1.05;
function wrap(text: string, capacity: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '', width = 0;
    const words = paragraph.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|\s+|[^\s]/gu) ?? [];
    const tokens = words.flatMap(word => Array.from(word).reduce((sum, char) => sum + advance(char), 0) > capacity ? Array.from(word) : [word]);
    for (const char of tokens) {
      const size = Array.from(char).reduce((sum, letter) => sum + advance(letter), 0);
      if (width + size > capacity && line) { lines.push(line.trim()); line = ''; width = 0; }
      line += char; width += size;
    }
    lines.push(line.trim());
  }
  return lines;
}
function fit(text: string, initial: number, minimum: number, maxLines: number, width: number) {
  for (let size = initial; size >= minimum; size -= 2) {
    const lines = wrap(text, width / size);
    if (lines.length <= maxLines) return { lines, size };
  }
  throw new Error('Cover text does not fit');
}
export function layoutCoverText(value: PptCoverFields): CoverTextLine[] {
  const fields = validateCoverFields(value);
  const title = fit(fields.title, 74, 32, 3, 520);
  const subtitle = fit(fields.subtitle, 25, 18, 3, 520);
  const footer = fit(fields.footer, 16, 14, 2, 520);
  const titleTop = title.lines.length === 1 ? 256 : title.lines.length === 2 ? 205 : 174;
  return [
    ...title.lines.map((text, i) => ({ text, x: 88, y: titleTop + i * (title.size + 16), width: 540,
      height: title.size * 1.4, size: title.size, color: i === 0 ? '183443' : '3C7777', bold: true })),
    ...subtitle.lines.map((text, i) => ({ text, x: 88, y: 447 + i * (subtitle.size + 12), width: 540,
      height: subtitle.size * 1.5, size: subtitle.size, color: '395562', bold: false })),
    ...footer.lines.map((text, i) => ({ text, x: 88, y: 634 + i * 22, width: 540,
      height: 26, size: footer.size, color: '77868B', bold: false })),
  ];
}

export const defaultCoverStyle: PptText = {
  zh: '高级、温暖的立体纸艺与哑光陶土质感，暖米白背景，低饱和鼠尾草绿、青绿色、少量珊瑚橙，自然柔光，精致而克制。',
  en: 'Refined dimensional paper craft and matte clay, warm ivory background, muted sage and teal with a small coral accent, soft natural light.',
};
export function buildCoverImagePrompt(subject: string, style: string): string {
  if (!subject.trim() || subject.length > 800) throw new Error('Invalid cover subject');
  return `Create ONE 16:9 landscape illustration for a PowerPoint cover. Subject: ${subject.trim()}\nStyle: ${style}\nUse the supplied image only as a style and composition reference; replace its subject with the requested subject. All objects must stay in the RIGHT 48% of the canvas. Leave the LEFT 52% completely empty warm ivory for editable text added later. No words, letters, numbers, labels, charts with text, watermarks, logos or title. Do not render a presentation or a mockup. Output one image (n=1), landscape 16:9, size 2848x1600 when supported by the selected model. Use lobsterai_image_generate exactly once with the selected image model. Do not use other models or generate another image automatically. Stop after the image task is submitted; the client will retrieve the result.`;
}
