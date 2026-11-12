import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  emptyImageCreationCatalog, ImageCreation, type ImageCreationCatalog, type ImageExampleReference,
  parseImageCreationCatalog,
} from '../../shared/imageCreation/constants';
import { imageEditingHeader } from './imageEditingHeader';

const MAX_CONFIG_BYTES = 256 * 1024;
const RETRY_MS = 30_000;

async function download(url: string, maxBytes: number): Promise<{ bytes: Buffer; mimeType: string; status: number }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (response.status === 404) { await response.body?.cancel(); return { bytes: Buffer.alloc(0), mimeType: '', status: 404 }; }
  if (!response.ok || !response.body) throw new Error(`Image examples HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body.cancel(); throw new Error('Image examples response too large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Image examples response too large');
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), mimeType: response.headers.get('content-type')?.split(';')[0] || '', status: response.status };
}

interface Entry { catalog?: ImageCreationCatalog; refreshAfter: number; pending?: Promise<ImageCreationCatalog> }
export class ImageCreationStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly options: {
    getEndpoint: () => string;
    cacheDirectory: string;
    download?: typeof download;
    now?: () => number;
  }) {}

  getCatalog(): Promise<ImageCreationCatalog> {
    const endpoint = this.options.getEndpoint();
    const entry = this.entries.get(endpoint) ?? { refreshAfter: 0 };
    this.entries.set(endpoint, entry);
    if (entry.pending) return entry.pending;
    if (entry.catalog && entry.refreshAfter > this.now()) return Promise.resolve(entry.catalog);
    entry.pending = this.load(endpoint, entry).finally(() => { entry.pending = undefined; });
    return entry.pending;
  }

  async getReference(exampleId: string): Promise<ImageExampleReference> {
    const endpoint = this.options.getEndpoint();
    const catalog = await this.getCatalog();
    const example = catalog.enabled ? catalog.examples.find(item => item.id === exampleId) : undefined;
    if (!example?.referenceImageUrl) throw new Error('Image example reference unavailable');
    const response = await (this.options.download ?? download)(example.referenceImageUrl, ImageCreation.MaxReferenceBytes);
    if (endpoint !== this.options.getEndpoint()) throw new Error('Image examples environment changed');
    if (response.status !== 200 || !response.bytes.length) throw new Error('Invalid image example reference');
    // NOS may serve valid images as application/octet-stream. Validate the file
    // header instead of trusting either the CDN content type or URL extension.
    let header: ReturnType<typeof imageEditingHeader>;
    try { header = imageEditingHeader(response.bytes); }
    catch (error) { throw new Error('Invalid image example reference', { cause: error }); }
    if (!header.width || !header.height || header.width * header.height > ImageCreation.MaxReferencePixels) {
      throw new Error('Invalid image example dimensions');
    }
    return { name: `${example.id}-reference.${header.extension}`, mimeType: header.mime, base64Data: response.bytes.toString('base64') };
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private async load(endpoint: string, entry: Entry): Promise<ImageCreationCatalog> {
    const cacheFile = path.join(this.options.cacheDirectory, `${createHash('sha256').update(endpoint).digest('hex')}.json`);
    if (!entry.catalog) {
      try {
        const content = await readFile(cacheFile, 'utf8');
        if (Buffer.byteLength(content) <= MAX_CONFIG_BYTES) entry.catalog = parseImageCreationCatalog(JSON.parse(content));
      } catch { /* A fresh install or invalid cache must fetch a valid configuration. */ }
    }
    try {
      const response = await (this.options.download ?? download)(endpoint, MAX_CONFIG_BYTES);
      const payload = response.status === 404 ? null : JSON.parse(response.bytes.toString('utf8'));
      const value = payload?.data?.value;
      if (response.status !== 404 && (payload?.code !== 0 || !payload?.data)) throw new Error('Invalid image examples response');
      const catalog = value == null ? emptyImageCreationCatalog()
        : parseImageCreationCatalog(typeof value === 'string' ? JSON.parse(value) : value);
      entry.catalog = catalog;
      entry.refreshAfter = this.now() + ImageCreation.RefreshMs;
      try {
        await mkdir(this.options.cacheDirectory, { recursive: true });
        await writeFile(`${cacheFile}.tmp`, JSON.stringify(catalog));
        await rename(`${cacheFile}.tmp`, cacheFile);
      } catch (error) { console.warn('[ImageCreation] Could not persist examples:', error); }
      return catalog;
    } catch (error) {
      entry.refreshAfter = this.now() + RETRY_MS;
      if (!entry.catalog) throw error;
      console.warn('[ImageCreation] Using cached examples after refresh failure:', error);
      return entry.catalog;
    }
  }
}
