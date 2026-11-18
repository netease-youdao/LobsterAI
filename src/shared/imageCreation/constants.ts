export const ImageCreation = {
  SchemaVersion: 1,
  ConfigKey: 'image-creation-examples',
  TabId: 'image-creation',
  HomeDraft: '__home__',
  RefreshMs: 5 * 60 * 1000,
  MaxReferenceBytes: 10 * 1024 * 1024,
  MaxReferencePixels: 40_000_000,
} as const;

export const ImageCreationIpc = {
  GetCatalog: 'image-creation:get-catalog',
  GetReference: 'image-creation:get-reference',
} as const;

export interface ImageExampleText { zh: string; en: string }
export interface ImageCreationExample {
  id: string;
  title: ImageExampleText;
  description: ImageExampleText;
  prompt: ImageExampleText;
  imageUrl: string;
  referenceImageUrl?: string;
  showReferencePreview?: boolean;
  modelName: string;
}
export interface ImageCreationCatalog {
  schemaVersion: 1;
  version: string;
  enabled: boolean;
  expertPresetId: string;
  examples: ImageCreationExample[];
}
export interface ImageExampleReference {
  name: string;
  mimeType: string;
  base64Data: string;
}
export const emptyImageCreationCatalog = (): ImageCreationCatalog => ({
  schemaVersion: 1, version: 'unconfigured', enabled: false, expertPresetId: 'image-creation-partner', examples: [],
});

const IMAGE_CDN_HOSTS = new Set(['shared.ydstatic.com', 'ydhardwarecommon.nosdn.127.net', 'ydschool-video.nosdn.127.net']);
export function isImageExampleUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && IMAGE_CDN_HOSTS.has(url.hostname)
      && !url.port && !url.username && !url.password && !url.hash && !url.search;
  } catch { return false; }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid image examples object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid image examples text');
  return value.trim();
}
function identifier(value: unknown): string {
  const result = text(value, 100);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(result)) throw new Error('Invalid image examples identifier');
  return result;
}
function localized(value: unknown, max: number): ImageExampleText {
  const item = record(value);
  return { zh: text(item.zh, max), en: text(item.en, max) };
}
export function parseImageCreationCatalog(value: unknown): ImageCreationCatalog {
  const item = record(value);
  if (item.schemaVersion !== ImageCreation.SchemaVersion || typeof item.enabled !== 'boolean'
    || !Array.isArray(item.examples) || item.examples.length > 24) throw new Error('Invalid image examples schema');
  const examples = item.examples.map(value => {
    const example = record(value);
    if (!isImageExampleUrl(example.imageUrl)
      || (example.referenceImageUrl !== undefined && !isImageExampleUrl(example.referenceImageUrl))) {
      throw new Error('Invalid image examples asset URL');
    }
    if (example.showReferencePreview !== undefined && (typeof example.showReferencePreview !== 'boolean'
      || (example.showReferencePreview && !example.referenceImageUrl))) {
      throw new Error('Invalid image examples reference preview');
    }
    return {
      id: identifier(example.id), title: localized(example.title, 80), description: localized(example.description, 200),
      prompt: localized(example.prompt, 6000), imageUrl: example.imageUrl,
      ...(example.referenceImageUrl ? { referenceImageUrl: example.referenceImageUrl as string } : {}),
      ...(example.showReferencePreview !== undefined ? { showReferencePreview: example.showReferencePreview as boolean } : {}),
      modelName: text(example.modelName, 120),
    };
  });
  if (new Set(examples.map(example => example.id)).size !== examples.length || (item.enabled && !examples.length)) {
    throw new Error('Empty or duplicate image examples');
  }
  return { schemaVersion: 1, enabled: item.enabled, version: text(item.version, 100),
    expertPresetId: identifier(item.expertPresetId), examples };
}
