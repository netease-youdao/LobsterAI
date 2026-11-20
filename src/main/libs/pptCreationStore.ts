import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import JSZip from 'jszip';

import { emptyPptCatalog, parsePptCatalog, PptAssetKind, type PptAssetRequest, type PptCatalog, PptCreation, type PptPreparedFile } from '../../shared/pptCreation/constants';
import { readOfficeZip } from '../office/core/officeZip';

const MAX_CONFIG_BYTES = 1024 * 1024;
const RETRY_MS = 30_000;
const OFFICE_PARTS: Partial<Record<PptAssetKind, string>> = {
  [PptAssetKind.Pptx]: 'ppt/presentation.xml',
  [PptAssetKind.Xlsx]: 'xl/workbook.xml',
  [PptAssetKind.Docx]: 'word/document.xml',
};
const MIME_TYPES: Record<PptAssetKind, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
};
async function download(url: string, maxBytes: number): Promise<{ bytes: Buffer; status: number }> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) { await response.body?.cancel(); return { bytes: Buffer.alloc(0), status: 404 }; }
  if (!response.ok || !response.body) throw new Error(`PPT catalog HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body.cancel(); throw new Error('PPT asset is too large'); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('PPT asset is too large');
    chunks.push(Buffer.from(chunk));
  }
  return { bytes: Buffer.concat(chunks), status: response.status };
}
export async function validatePptAsset(bytes: Buffer, kind: PptAssetKind): Promise<void> {
  if (!bytes.length || bytes.length > PptCreation.MaxAssetBytes) throw new Error('Invalid PPT asset size');
  const officePart = OFFICE_PARTS[kind];
  if (officePart) {
    const contents = readOfficeZip(bytes, { maxFileBytes: PptCreation.MaxAssetBytes, maxParts: 5000, maxPartBytes: 30 * 1024 * 1024, maxExpandedBytes: 150 * 1024 * 1024 });
    if (!contents.xml.has('[Content_Types].xml') || !contents.xml.has(officePart)
      || contents.names.some(name => /vbaProject|activeX/i.test(name))
      || /macroEnabled/i.test(contents.xml.get('[Content_Types].xml') ?? '')) throw new Error('Invalid or active-content PPT asset');
    const embedded = contents.names.filter(name => /embeddings\//i.test(name) && !name.endsWith('/'));
    if (embedded.length) {
      // Native charts store their editable data in an embedded workbook. Refuse
      // other embedded objects and validate each workbook as an Office package.
      if (kind !== PptAssetKind.Pptx || embedded.length > 20 || embedded.some(name => !/\.xlsx$/i.test(name))) {
        throw new Error('Unsupported embedded PPT asset');
      }
      const zip = await JSZip.loadAsync(bytes);
      for (const name of embedded) {
        const workbook = await zip.file(name)!.async('nodebuffer');
        await validatePptAsset(workbook, PptAssetKind.Xlsx);
      }
    }
  } else if (kind === PptAssetKind.Pdf) {
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid PDF asset');
  } else {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('Invalid text asset');
  }
}
interface Entry { catalog?: PptCatalog; refreshAfter: number; pending?: Promise<PptCatalog> }
export class PptCreationStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly options: { getEndpoint: () => string; cacheDirectory: string; download?: typeof download; now?: () => number }) {}
  getCatalog(): Promise<PptCatalog> {
    const endpoint = this.options.getEndpoint();
    const entry = this.entries.get(endpoint) ?? { refreshAfter: 0 };
    this.entries.set(endpoint, entry);
    if (entry.pending) return entry.pending;
    if (entry.catalog && entry.refreshAfter > this.now()) return Promise.resolve(entry.catalog);
    entry.pending = this.load(endpoint, entry).finally(() => { entry.pending = undefined; });
    return entry.pending;
  }
  async getAsset(request: PptAssetRequest): Promise<PptPreparedFile> {
    if (!request || typeof request.version !== 'string' || typeof request.assetId !== 'string'
      || request.assetId.length > 100 || Boolean(request.exampleId) === Boolean(request.templateId)) throw new Error('Invalid PPT asset request');
    const endpoint = this.options.getEndpoint();
    const catalog = await this.getCatalog();
    if (!catalog.enabled || catalog.version !== request.version) throw new Error('PPT catalog changed');
    const asset = request.templateId
      ? catalog.templates.find(item => item.id === request.templateId)?.file
      : (() => {
        const example = catalog.examples.find(item => item.id === request.exampleId);
        return example?.materials.find(item => item.id === request.assetId)
          ?? (example?.cover?.file.id === request.assetId ? example.cover.file : undefined);
      })();
    if (!asset || asset.id !== request.assetId) throw new Error('PPT asset unavailable');
    const response = await (this.options.download ?? download)(asset.url, PptCreation.MaxAssetBytes);
    if (endpoint !== this.options.getEndpoint()) throw new Error('PPT environment changed');
    if (response.status !== 200 || createHash('sha256').update(response.bytes).digest('hex') !== asset.sha256) throw new Error('PPT asset checksum mismatch');
    await validatePptAsset(response.bytes, asset.kind);
    if (endpoint !== this.options.getEndpoint()) throw new Error('PPT environment changed');
    return { name: asset.name, mimeType: MIME_TYPES[asset.kind], base64Data: response.bytes.toString('base64') };
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private async load(endpoint: string, entry: Entry): Promise<PptCatalog> {
    const cacheFile = path.join(this.options.cacheDirectory, createHash('sha256').update(endpoint).digest('hex') + '.json');
    if (!entry.catalog) {
      try {
        const text = await readFile(cacheFile, 'utf8');
        if (Buffer.byteLength(text) <= MAX_CONFIG_BYTES) entry.catalog = parsePptCatalog(JSON.parse(text));
      } catch { /* Missing or invalid cache is replaced only by a valid catalog. */ }
    }
    try {
      const response = await (this.options.download ?? download)(endpoint, MAX_CONFIG_BYTES);
      const payload = response.status === 404 ? null : JSON.parse(response.bytes.toString('utf8'));
      if (response.status !== 404 && (payload?.code !== 0 || !payload?.data)) throw new Error('Invalid PPT catalog response');
      const value = payload?.data?.value;
      const catalog = value == null ? emptyPptCatalog() : parsePptCatalog(typeof value === 'string' ? JSON.parse(value) : value);
      entry.catalog = catalog;
      entry.refreshAfter = this.now() + PptCreation.RefreshMs;
      try {
        await mkdir(this.options.cacheDirectory, { recursive: true });
        await writeFile(cacheFile + '.tmp', JSON.stringify(catalog));
        await rename(cacheFile + '.tmp', cacheFile);
      } catch (error) { console.warn('[PptCreation] Could not persist catalog:', error); }
      return catalog;
    } catch (error) {
      entry.refreshAfter = this.now() + RETRY_MS;
      if (!entry.catalog) throw error;
      console.warn('[PptCreation] Using cached catalog after refresh failure:', error);
      return entry.catalog;
    }
  }
}
