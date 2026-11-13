import fs from 'fs';
import path from 'path';

export type GatewayClientModuleLoader = (modulePath: string) => Record<string, unknown>;

export type GatewayClientChunkRef = {
  /** Absolute path of the bundler chunk that defines GatewayClient. */
  modulePath: string;
  /** The chunk's (minified) export name for GatewayClient. */
  exportName: string;
};

// `import { t as GatewayClient } from "../client-BRtMXpmK.js";` in the
// plugin-sdk barrel. The chunk name carries a build hash, so it is read from
// the barrel instead of being hard-coded.
const IMPORT_STATEMENT = /import\s*\{([^}]*)\}\s*from\s*["'](\.{1,2}\/[^"']+)["']/g;
const GATEWAY_CLIENT_SPECIFIER = /^\s*([A-Za-z_$][\w$]*)\s+as\s+GatewayClient\s*$|^\s*(GatewayClient)\s*$/;

const ctorCache = new Map<string, Promise<unknown>>();

/**
 * Finds the chunk the plugin-sdk barrel imports GatewayClient from. Loading
 * that chunk directly skips the barrel's other re-exports: 142 instead of 642
 * modules on v2026.8.1, about 0.4 s instead of 1.3 s of blocking main-thread
 * work on Windows.
 */
export function resolveGatewayClientChunk(barrelPath: string, barrelSource: string): GatewayClientChunkRef | null {
  for (const match of barrelSource.matchAll(IMPORT_STATEMENT)) {
    for (const specifier of match[1].split(',')) {
      const named = GATEWAY_CLIENT_SPECIFIER.exec(specifier);
      if (named) {
        return {
          modulePath: path.resolve(path.dirname(barrelPath), match[2]),
          exportName: named[1] ?? named[2],
        };
      }
    }
  }
  return null;
}

function isGatewayClientCtor(candidate: unknown): boolean {
  if (typeof candidate !== 'function') return false;
  const proto = (candidate as { prototype?: Record<string, unknown> }).prototype;
  return !!proto
    && typeof proto.start === 'function'
    && typeof proto.stop === 'function'
    && typeof proto.request === 'function';
}

function findCtorInModule(loaded: Record<string, unknown>): unknown {
  if (typeof loaded.GatewayClient === 'function') return loaded.GatewayClient;
  for (const candidate of Object.values(loaded)) {
    if (typeof candidate !== 'function') continue;
    if ((candidate as { name?: string }).name === 'GatewayClient' || isGatewayClientCtor(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function loadFromChunk(entryPath: string, load: GatewayClientModuleLoader): unknown {
  let source: string;
  try {
    source = fs.readFileSync(entryPath, 'utf8');
  } catch {
    return undefined;
  }
  const chunk = resolveGatewayClientChunk(entryPath, source);
  if (!chunk || chunk.modulePath === entryPath || !fs.existsSync(chunk.modulePath)) return undefined;
  try {
    const candidate = load(chunk.modulePath)[chunk.exportName];
    return isGatewayClientCtor(candidate) ? candidate : undefined;
  } catch (error) {
    console.warn(`[OpenClaw] gateway client chunk failed to load, using ${path.basename(entryPath)}:`, error);
    return undefined;
  }
}

function loadCtor(entryPath: string, load: GatewayClientModuleLoader): unknown {
  const fromChunk = loadFromChunk(entryPath, load);
  if (fromChunk) return fromChunk;
  const loaded = load(entryPath);
  const ctor = findCtorInModule(loaded);
  if (ctor) return ctor;
  const exportKeysPreview = Object.keys(loaded).slice(0, 20).join(', ');
  throw new Error(
    `Invalid OpenClaw gateway client module: ${entryPath} (exports: ${exportKeysPreview || 'none'})`,
  );
}

/**
 * Loads the GatewayClient constructor for a runtime's client entry, once per
 * entry path. Falls back to the entry module itself when its GatewayClient
 * import cannot be resolved or does not look like the client class.
 */
export function loadGatewayClientCtor<T>(entryPath: string, load: GatewayClientModuleLoader): Promise<T> {
  let cached = ctorCache.get(entryPath);
  if (!cached) {
    cached = new Promise((resolve) => resolve(loadCtor(entryPath, load)));
    ctorCache.set(entryPath, cached);
    // A failed load (for example a runtime that is mid-replacement) may succeed later.
    cached.catch(() => {
      if (ctorCache.get(entryPath) === cached) ctorCache.delete(entryPath);
    });
  }
  return cached as Promise<T>;
}

export function clearGatewayClientCtorCacheForTests(): void {
  ctorCache.clear();
}
