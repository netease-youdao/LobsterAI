import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { nativeImage } from 'electron';

import { imageGenerationSize, validImageSize } from '../../shared/imageEditing/geometry';
import { imageEditMessageSnapshot } from '../../shared/imageEditing/messageSnapshot';
import { imageEditPrompt } from '../../shared/imageEditing/prompts';
import {
  IMAGE_EDIT_MAX_BYTES,
  IMAGE_EDIT_MAX_REGIONS,
  IMAGE_EDIT_RATIOS,
  type ImageEditMessageSnapshot,
  ImageEditOperation,
  type ImageEditRequest,
  type ImageEditSnapshotImages,
  type ImageEditStageInput,
  type ImageVersion,
} from '../../shared/imageEditing/types';
import { t } from '../i18n';
import { imageEditingHeader } from './imageEditingHeader';
import { applyForegroundMatte } from './imageEditingMatte';
import type { PersistedGeneratedImageAsset } from './mediaAssetPersistence';

interface ImageEditingDependencies {
  directory: string;
  getCwd: (sessionId: string) => string | undefined;
  get: <T>(key: string) => T | undefined;
  set: (key: string, value: unknown) => void;
  changed: (version: ImageVersion) => void;
  publish: (version: ImageVersion) => void;
  getMessage?: (sessionId: string, messageId: string) => { type: string; metadata?: Record<string, unknown> } | null;
  saveMessageMetadata?: (sessionId: string, messageId: string, metadata: Record<string, unknown>) => void;
}
const STORE_PREFIX = 'image-editing:';
export class ImageEditResultError extends Error {}
interface ImageEditingSession { versions: ImageVersion[]; requests: ImageEditRequest[] }

function imageBytes(dataUrl: string): Buffer {
  if (typeof dataUrl !== 'string' || dataUrl.length > IMAGE_EDIT_MAX_BYTES * 1.4) throw new Error(t('imageEditTooLarge'));
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error(t('imageEditUnsupported'));
  return Buffer.from(match[2], 'base64');
}

function inspect(bytes: Buffer) {
  if (bytes.length > IMAGE_EDIT_MAX_BYTES) throw new Error(t('imageEditTooLarge'));
  let header: ReturnType<typeof imageEditingHeader>;
  try { header = imageEditingHeader(bytes); } catch { throw new Error(t('imageEditUnsupported')); }
  if (!validImageSize(header.width, header.height)) throw new Error(t('imageEditTooLarge'));
  const image = nativeImage.createFromBuffer(bytes);
  const { width, height } = image.getSize();
  if (image.isEmpty() || !validImageSize(width, height)) throw new Error(t('imageEditTooLarge'));
  return { ...header, image, width, height };
}

/** Stores immutable originals, private guide images, and durable version lineage. */
export class ImageEditingService {
  constructor(private readonly deps: ImageEditingDependencies) {}

  private session(sessionId: string): ImageEditingSession {
    if (typeof sessionId !== 'string' || !this.deps.getCwd(sessionId)) throw new Error(t('imageEditFailed'));
    return this.deps.get<ImageEditingSession>(STORE_PREFIX + sessionId) ?? { versions: [], requests: [] };
  }

  private record(version: ImageVersion): ImageVersion {
    const state = this.session(version.sessionId);
    const existing = state.versions.find(value => value.id === version.id || (version.requestId && version.taskId
      && value.requestId === version.requestId && value.taskId === version.taskId && value.outputIndex === version.outputIndex));
    if (existing) return existing;
    state.versions.push(version);
    this.deps.set(STORE_PREFIX + version.sessionId, state);
    this.deps.changed(version);
    return version;
  }

  private version(sessionId: string, id: string): ImageVersion {
    const version = this.session(sessionId).versions.find(v => v.id === id);
    if (!version) throw new Error(t('imageEditFailed'));
    return version;
  }

  private async privateFile(sessionId: string, name: string, bytes: Buffer): Promise<string> {
    const directory = path.join(this.deps.directory, crypto.createHash('sha256').update(sessionId).digest('hex'));
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, name);
    await fs.writeFile(filePath, bytes, { flag: 'wx' });
    return filePath;
  }

  async open(input: { sessionId: string; title: string; filePath?: string; dataUrl?: string }) {
    const state = this.session(input.sessionId);
    const known = input.filePath && state.versions.find(v => v.filePath === input.filePath);
    if (known) return this.read({ sessionId: input.sessionId, versionId: known.id });
    if (input.filePath && (await fs.stat(input.filePath)).size > IMAGE_EDIT_MAX_BYTES) throw new Error(t('imageEditTooLarge'));
    const bytes = input.filePath ? await fs.readFile(input.filePath) : imageBytes(input.dataUrl ?? '');
    const info = inspect(bytes);
    const id = crypto.createHash('sha256').update(input.sessionId).update(input.filePath ?? '').update(bytes).digest('hex');
    const existing = state.versions.find(v => v.id === id);
    if (existing) return this.read({ sessionId: input.sessionId, versionId: id });
    let filePath: string;
    try { filePath = await this.privateFile(input.sessionId, `${id}.${info.extension}`, bytes); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      filePath = path.join(this.deps.directory, crypto.createHash('sha256').update(input.sessionId).digest('hex'), `${id}.${info.extension}`);
    }
    const version = this.record({ id, rootId: id, sessionId: input.sessionId, filePath, originalPath: input.filePath,
      title: input.title, width: info.width, height: info.height, operation: ImageEditOperation.Original, createdAt: Date.now() });
    return { version, dataUrl: `data:${info.mime};base64,${bytes.toString('base64')}` };
  }

  async read(input: { sessionId: string; versionId: string }) {
    const version = this.version(input.sessionId, input.versionId);
    const bytes = await fs.readFile(version.filePath);
    const info = inspect(bytes);
    return { version, dataUrl: `data:${info.mime};base64,${bytes.toString('base64')}` };
  }

  list(input: { sessionId: string; rootId: string }): ImageVersion[] {
    return this.session(input.sessionId).versions.filter(v => v.rootId === input.rootId);
  }

  async save(input: { sessionId: string; sourceId: string; dataUrl: string; operation: ImageEditOperation }) {
    if (input.operation !== ImageEditOperation.Markup && input.operation !== ImageEditOperation.Resize) throw new Error(t('imageEditFailed'));
    const source = this.version(input.sessionId, input.sourceId);
    const info = inspect(imageBytes(input.dataUrl));
    const id = crypto.randomUUID();
    const filename = `image-${input.operation}-${id.slice(0, 8)}.png`;
    const filePath = path.join(this.deps.getCwd(input.sessionId)!, filename);
    await fs.writeFile(filePath, info.image.toPNG(), { flag: 'wx' });
    const version = this.record({ id, rootId: source.rootId, parentId: source.id, sessionId: input.sessionId,
      filePath, title: filename, width: info.width, height: info.height, operation: input.operation, createdAt: Date.now() });
    this.deps.publish(version);
    return version;
  }

  async stage(input: ImageEditStageInput): Promise<ImageEditRequest> {
    const source = this.version(input.sessionId, input.sourceId);
    const regions = input.regions ?? [];
    if (regions.length > IMAGE_EDIT_MAX_REGIONS || regions.some(r => !r.text.trim() || r.text.length > 4000
      || [r.x, r.y, r.width, r.height].some(v => !Number.isFinite(v) || v < 0 || v > 1)
      || r.width <= 0 || r.height <= 0 || r.x + r.width > 1.00001 || r.y + r.height > 1.00001)) throw new Error(t('imageEditFailed'));
    if (input.operation === ImageEditOperation.Comment && !regions.length) throw new Error(t('imageEditFailed'));
    if (input.operation === ImageEditOperation.Reframe && !(IMAGE_EDIT_RATIOS as readonly string[]).includes(input.aspectRatio ?? '')) throw new Error(t('imageEditFailed'));
    const id = crypto.randomUUID();
    const sourceBytes = await fs.readFile(source.filePath);
    const sourceInfo = inspect(sourceBytes);
    const sourceSnapshot = await this.privateFile(input.sessionId, `${id}-source.${sourceInfo.extension}`, sourceBytes);
    let guidePath: string | undefined;
    if (input.operation === ImageEditOperation.Markup || input.operation === ImageEditOperation.Erase) {
      const info = inspect(imageBytes(input.guideDataUrl ?? ''));
      if (info.width !== source.width || info.height !== source.height) throw new Error(t('imageEditInvalidSize'));
      guidePath = await this.privateFile(input.sessionId, `${id}-guide.png`, info.image.toPNG());
    }
    const request: ImageEditRequest = { id, source: { ...source, filePath: sourceSnapshot, originalPath: source.originalPath ?? source.filePath }, operation: input.operation, regions, guidePath,
      sourceVersionNumber: this.list({ sessionId: input.sessionId, rootId: source.rootId }).findIndex(v => v.id === source.id) + 1,
      aspectRatio: input.aspectRatio, instruction: input.instruction?.slice(0, 4000), createdAt: Date.now() };
    imageEditPrompt(request); // Reject local-only/unknown operations before recording a request.
    const state = this.session(input.sessionId);
    state.requests.push(request);
    this.deps.set(STORE_PREFIX + input.sessionId, state);
    return request;
  }

  resolve(sessionId: string, requestId: string): ImageEditRequest {
    const request = this.session(sessionId).requests.find(r => r.id === requestId);
    if (!request) throw new Error(t('imageEditFailed'));
    return request;
  }

  history(input: { sessionId: string; messageId: string }): ImageEditMessageSnapshot[] {
    const state = this.session(input.sessionId);
    const message = this.deps.getMessage?.(input.sessionId, input.messageId);
    if (!message || message.type !== 'user') return [];
    if (Array.isArray(message.metadata?.imageEdits)) return message.metadata.imageEdits as ImageEditMessageSnapshot[];
    // Historical messages have an exact immutable attachment path. Never guess by title or time.
    const previews = message.metadata?.imageAttachmentPreviews;
    if (!Array.isArray(previews)) return [];
    const paths = new Set(previews.map(value => value?.localPath).filter(value => typeof value === 'string'));
    const snapshots = state.requests.filter(request => paths.has(request.source.filePath)).map(request => {
      const versions = state.versions.filter(version => version.rootId === request.source.rootId);
      return imageEditMessageSnapshot({ ...request,
        sourceVersionNumber: request.sourceVersionNumber ?? versions.findIndex(version => version.id === request.source.id) + 1,
      });
    });
    if (snapshots.length) this.deps.saveMessageMetadata?.(input.sessionId, input.messageId, { ...message.metadata, imageEdits: snapshots });
    return snapshots;
  }

  async readSnapshot(input: { sessionId: string; requestId: string; preview?: boolean }): Promise<ImageEditSnapshotImages> {
    const request = this.resolve(input.sessionId, input.requestId);
    const info = inspect(await fs.readFile(request.source.filePath));
    const scale = input.preview ? Math.min(1, 512 / Math.max(info.width, info.height)) : 1;
    const size = { width: Math.max(1, Math.round(info.width * scale)), height: Math.max(1, Math.round(info.height * scale)) };
    const dataUrl = (image: Electron.NativeImage) => `data:image/png;base64,${(scale < 1 ? image.resize(size) : image).toPNG().toString('base64')}`;
    const images: ImageEditSnapshotImages = { dataUrl: dataUrl(info.image) };
    if ((request.operation === ImageEditOperation.Erase || request.operation === ImageEditOperation.Markup) && request.guidePath) {
      try {
        const guide = inspect(await fs.readFile(request.guidePath));
        if (guide.width !== info.width || guide.height !== info.height) throw new Error('Snapshot guide dimensions do not match its source');
        if (request.operation === ImageEditOperation.Erase) images.maskDataUrl = dataUrl(guide.image);
        else images.markupDataUrl = dataUrl(guide.image);
      } catch (error) {
        // Keep the source viewable, with an explicit UI indication that the submitted guide is missing.
        console.warn('[ImageEditing] Snapshot guide unavailable', error);
      }
    }
    return images;
  }

  async downloadDirectory(request: ImageEditRequest): Promise<string> {
    const directory = path.join(this.deps.directory, crypto.createHash('sha256').update(request.source.sessionId).digest('hex'), `result-${request.id}`);
    await fs.mkdir(directory, { recursive: true });
    return directory;
  }

  generation(request: ImageEditRequest, model: { capabilities?: string; parameterSpec?: Record<string, unknown>; pricing?: Record<string, unknown> }, additionalPrompt = '') {
    const spec = model.parameterSpec ?? model.pricing?.parameterSpec as Record<string, unknown> | undefined;
    const maxImages = (spec?.images as { maxItems?: number } | undefined)?.maxItems ?? 0;
    const required = request.guidePath ? 2 : 1;
    if (maxImages < required || !/编辑|edit/i.test(model.capabilities ?? '')) throw new Error(t('imageEditModelUnsupported'));
    return { prompt: imageEditPrompt(request) + (additionalPrompt && request.operation !== ImageEditOperation.RemoveBackground
      ? `\nAdditional instructions: ${additionalPrompt}` : ''), params: {
      images: [request.source.filePath, ...(request.guidePath ? [request.guidePath] : [])],
      n: 1, size: imageGenerationSize(request.source.width, request.source.height, request.aspectRatio),
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}), output_format: 'png', watermark: false,
    } };
  }

  async finalize(request: ImageEditRequest, taskId: string, assets: PersistedGeneratedImageAsset[]) {
    const finalized: PersistedGeneratedImageAsset[] = [];
    const resultAsset = (asset: PersistedGeneratedImageAsset, filePath: string): PersistedGeneratedImageAsset => ({
      ...asset, filePath, localPath: filePath, filename: path.basename(filePath),
      ...(request.operation === ImageEditOperation.RemoveBackground
        ? { url: pathToFileURL(filePath).href, originalUrl: pathToFileURL(filePath).href, mimeType: 'image/png' } : {}),
    });
    for (const [index, asset] of assets.entries()) {
      const existing = this.session(request.source.sessionId).versions.find(v => v.requestId === request.id && v.taskId === taskId && v.outputIndex === index);
      if (existing) { finalized.push(resultAsset(asset, existing.filePath)); continue; }
      let filePath = asset.filePath;
      let info = inspect(await fs.readFile(filePath));
      if (request.operation === ImageEditOperation.RemoveBackground) {
        const original = inspect(await fs.readFile(request.source.filePath));
        const matte = info.image.resize({ width: original.width, height: original.height, quality: 'best' });
        let bytes: Uint8Array;
        try { bytes = applyForegroundMatte(original.image.toBitmap(), matte.toBitmap(), original.width); }
        catch { throw new ImageEditResultError(t('imageEditMaskInvalid')); }
        const cutout = nativeImage.createFromBitmap(Buffer.from(bytes), { width: original.width, height: original.height });
        filePath = path.join(this.deps.getCwd(request.source.sessionId)!, `image-cutout-${request.id}-${index}.png`);
        try { await fs.writeFile(filePath, cutout.toPNG(), { flag: 'wx' }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        info = { ...original, image: cutout };
      }
      const version = this.record({ id: crypto.randomUUID(), rootId: request.source.rootId, parentId: request.source.id,
        sessionId: request.source.sessionId, filePath, title: path.basename(filePath), width: info.width, height: info.height,
        operation: request.operation, requestId: request.id, taskId, outputIndex: index, createdAt: Date.now() });
      finalized.push(resultAsset(asset, version.filePath));
    }
    return finalized;
  }
}
