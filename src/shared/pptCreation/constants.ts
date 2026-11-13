import { ModelPresetId, parseModelPresetId } from '../modelPresets/constants';
import { defaultCoverStyle, PptCover, type PptCoverRecipe } from './cover';

export const PptCreation = {
  SchemaVersion: 1, ConfigKey: 'ppt-creation-examples', ActionId: 'pptx', HomeDraft: '__home__',
  RefreshMs: 5 * 60 * 1000, MaxAssetBytes: 20 * 1024 * 1024, MaxAttachments: 5,
} as const;
export const PptCreationError = { ModelUnavailable: 'ppt-model-unavailable' } as const;

export const PptCreationIpc = {
  GetCatalog: 'ppt-creation:get-catalog', GetAsset: 'ppt-creation:get-asset',
} as const;
export const PptExampleMode = { Direct: 'direct', Guided: 'guided' } as const;
export type PptExampleMode = typeof PptExampleMode[keyof typeof PptExampleMode];
export const PptWorkflow = { Generate: 'generate', Outline: 'outline', Strict: 'strict' } as const;
export type PptWorkflow = typeof PptWorkflow[keyof typeof PptWorkflow];
export const PptAssetKind = { Pptx: 'pptx', Xlsx: 'xlsx', Docx: 'docx', Pdf: 'pdf', Text: 'txt', Csv: 'csv', Markdown: 'md' } as const;
export type PptAssetKind = typeof PptAssetKind[keyof typeof PptAssetKind];
export interface PptText { zh: string; en: string }
export interface PptAsset { id: string; name: string; kind: PptAssetKind; url: string; sha256: string }
export interface PptTemplate { id: string; title: PptText; description: PptText; previewUrl: string; file: PptAsset }
export interface PptExample {
  id: string; title: PptText; description: PptText; prompt: PptText; customPrompt: PptText;
  defaultMode: PptExampleMode; defaultWorkflow: PptWorkflow; slideCount: number; modelName: string;
  previews: { url: string; slide: number }[];
  materials: PptAsset[];
  templateId?: string;
  requiresMaterial: boolean;
  cover?: PptCoverRecipe;
}
export interface PptCatalog {
  schemaVersion: 1; version: string; enabled: boolean; expertPresetId: string;
  recommendedModelPreset: ModelPresetId;
  coverImageModel?: string; coverStylePrompt?: PptText;
  examples: PptExample[]; templates: PptTemplate[];
}
export interface PptAssetRequest { version: string; exampleId?: string; templateId?: string; assetId: string }
export interface PptPreparedFile { name: string; mimeType: string; base64Data: string }

export const emptyPptCatalog = (): PptCatalog => ({
  schemaVersion: 1, version: 'unconfigured', enabled: false, expertPresetId: 'powerpoint-deck-builder',
  recommendedModelPreset: ModelPresetId.Balanced, examples: [], templates: [],
});
const CDN_HOSTS = new Set(['shared.ydstatic.com', 'ydhardwarecommon.nosdn.127.net', 'ydhardwarebusiness.nosdn.127.net', 'ydschool-video.nosdn.127.net']);
export function isPptAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && CDN_HOSTS.has(url.hostname)
      && !url.port && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PPT catalog object');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid PPT catalog text');
  return value.trim();
}
function identifier(value: unknown): string {
  const id = text(value);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Invalid PPT catalog identifier');
  return id;
}
function localized(value: unknown, max: number): PptText {
  const record = object(value);
  return { zh: text(record.zh, max), en: text(record.en, max) };
}
function url(value: unknown): string {
  if (!isPptAssetUrl(value)) throw new Error('Invalid PPT catalog asset URL');
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid PPT catalog list');
  return value;
}
function unique<T extends { id: string }>(items: T[]): T[] {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate PPT catalog identifier');
  return items;
}
function asset(value: unknown): PptAsset {
  const item = object(value);
  const kind = text(item.kind) as PptAssetKind;
  const name = text(item.name, 120);
  const sha256 = text(item.sha256);
  if (!Object.values(PptAssetKind).includes(kind) || !/^[a-zA-Z0-9_\-\u4e00-\u9fff][a-zA-Z0-9_\-\u4e00-\u9fff .]*$/.test(name)
    || name.includes('..') || !name.toLowerCase().endsWith(`.${kind}`) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('Invalid PPT catalog file');
  }
  return { id: identifier(item.id), name, kind, url: url(item.url), sha256 };
}
export function parsePptCatalog(value: unknown): PptCatalog {
  const item = object(value);
  if (item.schemaVersion !== PptCreation.SchemaVersion || typeof item.enabled !== 'boolean') throw new Error('Invalid PPT catalog schema');
  const recommendedModelPreset = item.recommendedModelPreset === undefined ? ModelPresetId.Balanced : parseModelPresetId(item.recommendedModelPreset);
  if (!recommendedModelPreset) throw new Error('Invalid PPT recommended model preset');
  const templates = unique(list(item.templates, 12).map(value => {
    const template = object(value);
    const file = asset(template.file);
    if (file.kind !== PptAssetKind.Pptx) throw new Error('PPT template must be a presentation');
    return { id: identifier(template.id), title: localized(template.title, 80), description: localized(template.description, 300), previewUrl: url(template.previewUrl), file };
  }));
  const examples = unique(list(item.examples, 24).map(value => {
    const example = object(value);
    if (!Object.values(PptExampleMode).includes(example.defaultMode as PptExampleMode)
      || !Object.values(PptWorkflow).includes(example.defaultWorkflow as PptWorkflow)
      || !Number.isInteger(example.slideCount) || Number(example.slideCount) < 3 || Number(example.slideCount) > 40
      || typeof example.requiresMaterial !== 'boolean') throw new Error('Invalid PPT example options');
    const previews = list(example.previews, 6).map(value => {
      const preview = object(value);
      if (!Number.isInteger(preview.slide) || Number(preview.slide) < 1 || Number(preview.slide) > Number(example.slideCount)) throw new Error('Invalid PPT preview slide');
      return { url: url(preview.url), slide: Number(preview.slide) };
    });
    if (!previews.length || new Set(previews.map(preview => preview.slide)).size !== previews.length) throw new Error('Missing or duplicate PPT previews');
    const templateId = example.templateId === undefined ? undefined : identifier(example.templateId);
    if (templateId && !templates.some(template => template.id === templateId)) throw new Error('Unknown PPT template');
    const materials = unique(list(example.materials, PptCreation.MaxAttachments).map(asset));
    if (example.requiresMaterial && !materials.length) throw new Error('PPT example requires demo materials');
    if (materials.length + (templateId ? 1 : 0) > PptCreation.MaxAttachments) throw new Error('Too many PPT example attachments');
    return {
      id: identifier(example.id), title: localized(example.title, 80), description: localized(example.description, 300),
      prompt: localized(example.prompt, 16000), customPrompt: localized(example.customPrompt, 8000),
      defaultMode: example.defaultMode as PptExampleMode, defaultWorkflow: example.defaultWorkflow as PptWorkflow,
      slideCount: Number(example.slideCount), modelName: text(example.modelName, 120),
      previews, materials, requiresMaterial: example.requiresMaterial, ...(templateId ? { templateId } : {}),
      ...(example.cover === undefined ? {} : { cover: parseCoverRecipe(example.cover) }),
    };
  }));
  if (item.enabled && !examples.length) throw new Error('Empty enabled PPT catalog');
  const coverImageModel = item.coverImageModel === undefined ? PptCover.DefaultImageModel : text(item.coverImageModel, 120);
  if (!/^[a-zA-Z0-9._-]+$/.test(coverImageModel)) throw new Error('Invalid cover image model');
  return { schemaVersion: 1, version: text(item.version), enabled: item.enabled, expertPresetId: identifier(item.expertPresetId), recommendedModelPreset, examples, templates,
    ...(examples.some(example => example.cover) || item.coverImageModel !== undefined ? {
      coverImageModel, coverStylePrompt: item.coverStylePrompt === undefined ? defaultCoverStyle : localized(item.coverStylePrompt, 3000),
    } : {}) };
}

function parseCoverRecipe(value: unknown): PptCoverRecipe {
  const item = object(value), file = asset(item.file);
  if (file.kind !== PptAssetKind.Pptx) throw new Error('Cover template must be PPTX');
  return { file, title: localized(item.title, 50), subtitle: localized(item.subtitle, 90), footer: localized(item.footer, 50), subject: localized(item.subject, 800) };
}
