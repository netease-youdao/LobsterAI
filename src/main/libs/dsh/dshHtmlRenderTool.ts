import { existsSync, realpathSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  DSH_HTML_RENDER_TOOL,
  HTML_RENDER_LIMITS,
  HtmlRenderFormat,
} from '../../../shared/dshEngine/hostConstants';
import type { HtmlRenderItemResult, HtmlRenderJob } from '../htmlOffscreenRenderer';
import type { HostToolProvider } from './dshHostBridgeWiring';
import type { DshHostToolDescriptor } from './dshHostManager';

export interface HtmlRenderToolOptions {
  resolveAllowedRoots: (context: { coworkSessionId?: string; agentId: string }) => string[];
  render: (jobs: readonly HtmlRenderJob[], signal?: AbortSignal) => Promise<HtmlRenderItemResult[]>;
}

const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

function isInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedRoot = path.resolve(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalizeIfExists(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function canonicalizeAncestor(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  let current = resolved;
  const trailing: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    trailing.unshift(path.basename(current));
    current = parent;
  }
  const base = canonicalizeIfExists(current);
  return trailing.length > 0 ? path.join(base, ...trailing) : base;
}

function assertAllowedLocalPath(
  rawPath: unknown,
  label: string,
  baseDir: string,
  allowedRoots: readonly string[],
  mustExist: boolean,
  allowedExts: ReadonlySet<string>,
): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error(`${label} must be a non-empty local file path.`);
  }
  const trimmed = rawPath.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    throw new Error(`${label} must be a local filesystem path, not a URL: ${trimmed}`);
  }

  const candidate = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(baseDir, trimmed);
  const ext = path.extname(candidate).toLowerCase();
  if (!allowedExts.has(ext)) {
    throw new Error(`${label} has unsupported extension "${ext || '(none)'}". Allowed: ${[...allowedExts].join(', ')}.`);
  }

  if (mustExist) {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new Error(`${label} does not exist or is not a file: ${candidate}`);
    }
  }

  const canonicalTarget = mustExist ? canonicalizeIfExists(candidate) : canonicalizeAncestor(candidate);
  const canonicalRoots = allowedRoots.filter(Boolean).map(root => canonicalizeIfExists(root));
  if (!canonicalRoots.some(root => isInsideRoot(canonicalTarget, root))) {
    throw new Error(`${label} must be inside the session workspace, agent workspace, or temp directory.`);
  }

  return canonicalTarget;
}

function parseDimension(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (parsed < HTML_RENDER_LIMITS.MinDimension || parsed > HTML_RENDER_LIMITS.MaxDimension) {
    throw new Error(
      `${label} must be between ${HTML_RENDER_LIMITS.MinDimension} and ${HTML_RENDER_LIMITS.MaxDimension}.`,
    );
  }
  return parsed;
}

function parseFormat(value: unknown, outputPath: string): HtmlRenderFormat {
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (normalized === HtmlRenderFormat.Png) return HtmlRenderFormat.Png;
    if (normalized === HtmlRenderFormat.Jpeg || normalized === 'jpg') return HtmlRenderFormat.Jpeg;
    throw new Error(`Unsupported format "${value}". Use "png" or "jpeg".`);
  }
  const ext = path.extname(outputPath).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? HtmlRenderFormat.Jpeg : HtmlRenderFormat.Png;
}

function parseQuality(value: unknown): number {
  if (value === undefined || value === null) return HTML_RENDER_LIMITS.DefaultQuality;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('quality must be a number between 1 and 100.');
  }
  return Math.round(parsed);
}

function parseWaitMs(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > HTML_RENDER_LIMITS.MaxWaitMs) {
    throw new Error(`waitMs must be between 0 and ${HTML_RENDER_LIMITS.MaxWaitMs}.`);
  }
  return Math.round(parsed);
}

export function parseHtmlRenderJobs(
  args: Record<string, unknown>,
  allowedRoots: readonly string[],
): HtmlRenderJob[] {
  const effectiveRoots = [...allowedRoots.filter(Boolean), os.tmpdir()];
  const baseDir = allowedRoots[0] || os.tmpdir();
  const rawItems = Array.isArray(args.items)
    ? args.items
    : (typeof args.htmlPath === 'string' || typeof args.outputPath === 'string')
      ? [args]
      : [];

  if (rawItems.length === 0) {
    throw new Error('Provide either `items` (non-empty array) or top-level `htmlPath` and `outputPath`.');
  }
  if (rawItems.length > HTML_RENDER_LIMITS.MaxItems) {
    throw new Error(`At most ${HTML_RENDER_LIMITS.MaxItems} HTML render items are allowed per call.`);
  }

  return rawItems.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`items[${index}] must be an object.`);
    }
    const item = entry as Record<string, unknown>;
    const htmlPath = assertAllowedLocalPath(
      item.htmlPath,
      `items[${index}].htmlPath`,
      baseDir,
      effectiveRoots,
      true,
      HTML_EXTENSIONS,
    );
    const outputPath = assertAllowedLocalPath(
      item.outputPath,
      `items[${index}].outputPath`,
      baseDir,
      effectiveRoots,
      false,
      IMAGE_EXTENSIONS,
    );
    const width = parseDimension(
      item.width ?? args.width,
      HTML_RENDER_LIMITS.DefaultWidth,
      `items[${index}].width`,
    );
    const height = parseDimension(
      item.height ?? args.height,
      HTML_RENDER_LIMITS.DefaultHeight,
      `items[${index}].height`,
    );
    const fullPage = item.fullPage === true || (item.fullPage === undefined && args.fullPage === true);
    const format = parseFormat(item.format ?? args.format, outputPath);
    const quality = parseQuality(item.quality ?? args.quality);
    const waitMs = parseWaitMs(item.waitMs ?? args.waitMs);

    return {
      htmlPath,
      outputPath,
      width,
      height,
      fullPage,
      format,
      quality,
      waitMs,
    };
  });
}

const ITEM_SCHEMA = {
  type: 'object',
  required: ['htmlPath', 'outputPath'],
  additionalProperties: false,
  properties: {
    htmlPath: { type: 'string', description: 'Local .html/.htm file path inside the workspace.' },
    outputPath: { type: 'string', description: 'Local output .png/.jpg/.jpeg path to write.' },
    width: { type: 'integer', description: `Viewport width in CSS pixels (default ${HTML_RENDER_LIMITS.DefaultWidth}).` },
    height: { type: 'integer', description: `Viewport height in CSS pixels (default ${HTML_RENDER_LIMITS.DefaultHeight}).` },
    fullPage: { type: 'boolean', description: 'Capture full scroll height beyond viewport height (default false).' },
    format: { type: 'string', enum: Object.values(HtmlRenderFormat), description: 'Output format: png or jpeg.' },
    quality: { type: 'integer', description: 'JPEG quality 1-100 (default 92, ignored for png).' },
    waitMs: { type: 'integer', description: `Optional extra settle delay in ms (0-${HTML_RENDER_LIMITS.MaxWaitMs}).` },
  },
};

export const dshHtmlRenderToolDescriptor: DshHostToolDescriptor = {
  name: DSH_HTML_RENDER_TOOL,
  description: [
    'Render one or more local HTML/CSS files directly to pixel-exact PNG/JPEG images on disk using LobsterAI\'s built-in Chromium offscreen renderer (`deviceScaleFactor: 1`, silent, never disturbs visible browser tabs).',
    'Prefer this tool for deterministic covers, graphic cards, long summary posters, and social post carousels (e.g. 1242x1656 3:4 or 1242x1242 1:1).',
    'Pass `items` to batch-render up to 20 files in one call, or top-level `htmlPath` and `outputPath` for a single file.',
  ].join(' '),
  deferLoading: true,
  timeoutMs: HTML_RENDER_LIMITS.DefaultTimeoutMs,
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `Batch render jobs (1-${HTML_RENDER_LIMITS.MaxItems}).`,
        items: ITEM_SCHEMA,
      },
      htmlPath: ITEM_SCHEMA.properties.htmlPath,
      outputPath: ITEM_SCHEMA.properties.outputPath,
      width: ITEM_SCHEMA.properties.width,
      height: ITEM_SCHEMA.properties.height,
      fullPage: ITEM_SCHEMA.properties.fullPage,
      format: ITEM_SCHEMA.properties.format,
      quality: ITEM_SCHEMA.properties.quality,
      waitMs: ITEM_SCHEMA.properties.waitMs,
    },
  },
};

export function createDshHtmlRenderProvider(options: HtmlRenderToolOptions): HostToolProvider {
  return {
    listDescriptors: () => [dshHtmlRenderToolDescriptor],
    async execute(toolName, args, context) {
      if (toolName !== DSH_HTML_RENDER_TOOL) {
        throw new Error(`Unexpected tool: ${toolName}`);
      }
      const allowedRoots = options.resolveAllowedRoots({
        coworkSessionId: context.coworkSessionId,
        agentId: context.agentId,
      });
      const jobs = parseHtmlRenderJobs(args, allowedRoots);
      const rendered = await options.render(jobs, context.signal);
      return {
        ok: true,
        count: rendered.length,
        results: rendered,
      };
    },
  };
}
