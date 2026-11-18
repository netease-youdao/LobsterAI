import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

import { parseExpertCatalog, parseExpertStoreManifest } from '../../shared/agent/expertCatalogValidation';
import type { ExpertCatalog, ExpertStoreManifest } from '../../shared/agent/presets';
import { usageFailureCode, type UsageParams } from '../../shared/analytics/usage';

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const RETRY_INTERVAL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

export function fetchExpertStoreText(url: string, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Deliberately do not follow redirects: both allowed origins and size limits
    // remain enforced at the actual download endpoint.
    const request = https.get(url, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Expert store HTTP ${response.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) request.destroy(new Error('Expert store response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    const timeout = setTimeout(() => request.destroy(new Error('Expert store request timed out')), REQUEST_TIMEOUT_MS);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timeout));
  });
}

interface CachedCatalog {
  endpoint: string;
  manifest: ExpertStoreManifest;
  content: string;
}

interface ExpertStoreOptions {
  getEndpoint: () => string;
  cacheDirectory: string;
  fetchText?: typeof fetchExpertStoreText;
  now?: () => number;
  onLoad?: (fields: UsageParams) => void;
}

interface StoreEntry {
  cached?: CachedCatalog;
  catalog?: ExpertCatalog;
  refreshAfter: number;
  pending?: Promise<ExpertCatalog>;
}

function validateContent(manifest: ExpertStoreManifest, content: string): ExpertCatalog {
  if (Buffer.byteLength(content) > MAX_CATALOG_BYTES
    || createHash('sha256').update(content).digest('hex') !== manifest.sha256) {
    throw new Error('Expert catalog integrity check failed');
  }
  const catalog = parseExpertCatalog(JSON.parse(content));
  if (catalog.version !== manifest.version) throw new Error('Expert catalog version mismatch');
  return catalog;
}

/** Overmind selects a versioned CDN catalog. Caches never cross environments. */
export class ExpertStore {
  private readonly entries = new Map<string, StoreEntry>();
  private readonly fetchText: typeof fetchExpertStoreText;
  private readonly now: () => number;

  constructor(private readonly options: ExpertStoreOptions) {
    this.fetchText = options.fetchText ?? fetchExpertStoreText;
    this.now = options.now ?? Date.now;
  }

  getCatalog(): Promise<ExpertCatalog> {
    const endpoint = this.options.getEndpoint();
    let entry = this.entries.get(endpoint);
    if (!entry) {
      entry = { refreshAfter: 0 };
      this.entries.set(endpoint, entry);
    }
    if (entry.pending) return entry.pending;
    if (entry.catalog && entry.refreshAfter > this.now()) return Promise.resolve(entry.catalog);
    const activeEntry = entry;
    activeEntry.pending = this.load(endpoint, activeEntry).finally(() => { activeEntry.pending = undefined; });
    return activeEntry.pending;
  }

  private async load(endpoint: string, entry: StoreEntry): Promise<ExpertCatalog> {
    const startedAt = this.now();
    let phase: ExpertCatalogLoadPhase = ExpertCatalogLoadPhase.Manifest;
    const cachePath = path.join(this.options.cacheDirectory, `${createHash('sha256').update(endpoint).digest('hex')}.json`);
    if (!entry.cached) {
      try {
        const serialized = await readFile(cachePath, 'utf8');
        // The file wraps raw JSON content, so allow escaping overhead.
        if (Buffer.byteLength(serialized) > MAX_CATALOG_BYTES * 2) throw new Error('Expert cache too large');
        const cached = JSON.parse(serialized) as CachedCatalog;
        if (cached.endpoint !== endpoint || typeof cached.content !== 'string') throw new Error('Invalid expert cache');
        cached.manifest = parseExpertStoreManifest(cached.manifest);
        entry.catalog = validateContent(cached.manifest, cached.content);
        entry.cached = cached;
      } catch {
        // A missing/corrupt cache is replaced only after a fully validated fetch.
      }
    }
    try {
      const response = JSON.parse(await this.fetchText(endpoint, MAX_MANIFEST_BYTES));
      const value = response?.data?.value;
      const manifest = parseExpertStoreManifest(typeof value === 'string' ? JSON.parse(value) : value);
      if (entry.cached?.manifest.sha256 !== manifest.sha256 || entry.cached.manifest.version !== manifest.version) {
        phase = ExpertCatalogLoadPhase.Catalog;
        const content = await this.fetchText(manifest.catalogUrl, MAX_CATALOG_BYTES);
        phase = ExpertCatalogLoadPhase.Validation;
        const catalog = validateContent(manifest, content);
        const cached = { endpoint, manifest, content };
        // Keep the previous valid file if download, parsing or persistence fails.
        try {
          await mkdir(this.options.cacheDirectory, { recursive: true });
          await writeFile(`${cachePath}.tmp`, JSON.stringify(cached), 'utf8');
          await rename(`${cachePath}.tmp`, cachePath);
        } catch (error) {
          console.warn('[ExpertStore] Failed to persist catalog:', error);
        }
        entry.catalog = catalog;
        entry.cached = cached;
      }
      entry.refreshAfter = this.now() + REFRESH_INTERVAL_MS;
      this.reportLoad({ outcome: 'succeeded', catalogVersion: entry.catalog?.version, durationMs: this.now() - startedAt, cacheFallback: false });
      return entry.catalog!;
    } catch (error) {
      this.reportLoad({ outcome: 'failed', failureStage: phase, failureCode: usageFailureCode(error),
        cacheFallback: Boolean(entry.catalog), catalogVersion: entry.catalog?.version, durationMs: this.now() - startedAt });
      if (!entry.catalog) throw error;
      entry.refreshAfter = this.now() + RETRY_INTERVAL_MS;
      console.warn('[ExpertStore] Using cached catalog after refresh failure:', error);
      return entry.catalog;
    }
  }

  private reportLoad(fields: UsageParams): void {
    try { this.options.onLoad?.(fields); } catch { /* Reporting must not affect catalog availability. */ }
  }
}

const ExpertCatalogLoadPhase = { Manifest: 'manifest', Catalog: 'catalog', Validation: 'validation' } as const;
type ExpertCatalogLoadPhase = typeof ExpertCatalogLoadPhase[keyof typeof ExpertCatalogLoadPhase];
