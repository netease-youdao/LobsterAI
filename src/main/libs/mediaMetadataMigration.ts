import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  compactMessageMetadataMedia,
  INLINE_MEDIA_SOURCE_KEY_PREFIX,
  isInlineDataUrl,
  isRecord,
  MEDIA_DETAILS_FIELDS,
  mediaAssetFilePath,
  mediaSourceKey,
} from './mediaMetadataCompaction';

/**
 * Older builds stored every generated image as an inline data URL in several message rows
 * (one 13-image session held 1.1 GB). New writes keep file references only; this pass rewrites
 * the rows already stored, in the background and resumably.
 */
export const MEDIA_METADATA_MIGRATION_KEY = 'cowork.mediaMetadataCompaction.v1';

/** Rows are visited by rowid range so each scan step stays a few milliseconds long. */
const SCAN_WINDOW_ROWS = 2000;
/** Metadata smaller than this cannot hold a generated image. */
const MIN_CANDIDATE_METADATA_BYTES = 64 * 1024;
const INLINE_MARKER = ';base64,';
const IMAGE_DATA_URL_PATTERN = /^\s*data:(image\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,/i;
const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

interface MigrationState {
  lastRowId: number;
  done?: boolean;
}

export interface MediaMetadataMigrationDeps {
  db: Database.Database;
  kv: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void };
  /** Where an image whose saved file is gone is written back, per session. */
  recoveryDirectory: (sessionId: string) => string;
  /** Lets other main-process work run between rows. */
  pause?: () => Promise<void>;
  /**
   * Reading one bloated row takes the main process up to ~150ms; rows are only rewritten while
   * the user is not typing or clicking, so that never lands on an interaction.
   */
  isIdle?: () => boolean;
  /** How long to wait before checking for idleness again. */
  waitForIdle?: () => Promise<void>;
  shouldStop?: () => boolean;
}

export interface MediaMetadataMigrationResult {
  done: boolean;
  compactedRows: number;
  rescuedImages: number;
  skippedRows: number;
  bytesBefore: number;
  bytesAfter: number;
}

type AssetRescue =
  | { kind: 'unchanged' }
  | { kind: 'rescued'; asset: Record<string, unknown> }
  | { kind: 'blocked' };

const defaultPause = () => new Promise<void>(resolve => setTimeout(resolve, 10));
const defaultWaitForIdle = () => new Promise<void>(resolve => setTimeout(resolve, 1000));

/**
 * Compaction drops the inline copy of a saved image. When that file no longer exists (moved or
 * deleted) or was never written, the inline copy is the only one left: write it to the recovery
 * directory first and point the asset at it.
 */
function rescueAsset(asset: Record<string, unknown>, recoveryDirectory: string): AssetRescue {
  const source = [asset.url, asset.originalUrl].find(isInlineDataUrl);
  if (!source) return { kind: 'unchanged' };
  const filePath = mediaAssetFilePath(asset);
  if (filePath && fs.existsSync(filePath)) return { kind: 'unchanged' };

  const match = IMAGE_DATA_URL_PATTERN.exec(source);
  const extension = match ? IMAGE_EXTENSION_BY_MIME[match[1].toLowerCase()] : undefined;
  if (!extension) return { kind: 'blocked' };

  const hash = mediaSourceKey(source).slice(INLINE_MEDIA_SOURCE_KEY_PREFIX.length);
  const target = path.join(recoveryDirectory, `recovered-${hash.slice(0, 32)}${extension}`);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(recoveryDirectory, { recursive: true });
    const tempPath = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, Buffer.from(source.slice(source.indexOf(',') + 1), 'base64'));
    fs.renameSync(tempPath, target);
  }
  return {
    kind: 'rescued',
    asset: {
      ...asset,
      filePath: target,
      localPath: target,
      filename: typeof asset.filename === 'string' && asset.filename.trim() ? asset.filename : path.basename(target),
      savedToRecoveryDirectory: true,
    },
  };
}

type RowOutcome =
  | { kind: 'none' }
  | { kind: 'skipped' }
  | { kind: 'compacted'; rescued: number; before: number; after: number };

/** Synchronous from read to write, so no other writer can interleave with the row. */
function migrateRow(
  db: Database.Database,
  rowId: number,
  recoveryDirectory: (sessionId: string) => string,
): RowOutcome {
  const row = db.prepare('SELECT session_id, metadata FROM cowork_messages WHERE rowid = ?').get(rowId) as
    | { session_id: string; metadata: string | null }
    | undefined;
  if (!row?.metadata || !row.metadata.includes(INLINE_MARKER)) return { kind: 'none' };

  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    return { kind: 'none' };
  }
  if (!isRecord(metadata)) return { kind: 'none' };

  let next = metadata;
  let rescued = 0;
  for (const field of MEDIA_DETAILS_FIELDS) {
    const details = next[field];
    if (!isRecord(details) || !Array.isArray(details.assets)) continue;
    let changed = false;
    const assets: unknown[] = [];
    for (const asset of details.assets) {
      if (!isRecord(asset)) {
        assets.push(asset);
        continue;
      }
      const outcome = rescueAsset(asset, recoveryDirectory(row.session_id));
      if (outcome.kind === 'blocked') return { kind: 'skipped' };
      if (outcome.kind === 'rescued') {
        changed = true;
        rescued += 1;
        assets.push(outcome.asset);
      } else {
        assets.push(asset);
      }
    }
    if (changed) next = { ...next, [field]: { ...details, assets } };
  }

  const compacted = compactMessageMetadataMedia(next);
  if (compacted === metadata) return { kind: 'none' };
  const json = JSON.stringify(compacted);
  db.prepare('UPDATE cowork_messages SET metadata = ? WHERE rowid = ?').run(json, rowId);
  return { kind: 'compacted', rescued, before: row.metadata.length, after: json.length };
}

export async function migrateInlineMediaMetadata(deps: MediaMetadataMigrationDeps): Promise<MediaMetadataMigrationResult> {
  const result: MediaMetadataMigrationResult = {
    done: false, compactedRows: 0, rescuedImages: 0, skippedRows: 0, bytesBefore: 0, bytesAfter: 0,
  };
  const state = deps.kv.get<MigrationState>(MEDIA_METADATA_MIGRATION_KEY) ?? { lastRowId: 0 };
  if (state.done) return { ...result, done: true };

  const pause = deps.pause ?? defaultPause;
  const isIdle = deps.isIdle ?? (() => true);
  const waitForIdle = deps.waitForIdle ?? defaultWaitForIdle;
  const shouldStop = deps.shouldStop ?? (() => false);
  // Rows written after this point already go through compaction.
  const maxRowId = (deps.db.prepare('SELECT MAX(rowid) AS id FROM cowork_messages').get() as { id: number | null }).id ?? 0;
  // octet_length() reads the size from the record header without loading the metadata itself.
  const selectCandidates = deps.db.prepare(`
    SELECT rowid AS row_id
    FROM cowork_messages
    WHERE rowid > ? AND rowid <= ?
      AND type IN ('tool_use', 'tool_result', 'system')
      AND octet_length(metadata) > ?
    ORDER BY rowid
  `);

  let cursor = Math.max(0, state.lastRowId);
  while (cursor < maxRowId) {
    if (shouldStop()) return result;
    const windowEnd = Math.min(cursor + SCAN_WINDOW_ROWS, maxRowId);
    const candidates = selectCandidates.all(cursor, windowEnd, MIN_CANDIDATE_METADATA_BYTES) as Array<{ row_id: number }>;
    for (const { row_id: rowId } of candidates) {
      // An interrupted window is visited again on the next run; rewritten rows are no longer candidates.
      while (!isIdle()) {
        if (shouldStop()) return result;
        await waitForIdle();
      }
      if (shouldStop()) return result;
      // Every candidate is read in full, rewritten or not, so yield after each one.
      const outcome = migrateRow(deps.db, rowId, deps.recoveryDirectory);
      await pause();
      if (outcome.kind === 'skipped') result.skippedRows += 1;
      if (outcome.kind !== 'compacted') continue;
      result.compactedRows += 1;
      result.rescuedImages += outcome.rescued;
      result.bytesBefore += outcome.before;
      result.bytesAfter += outcome.after;
    }
    cursor = windowEnd;
    deps.kv.set(MEDIA_METADATA_MIGRATION_KEY, { lastRowId: cursor } satisfies MigrationState);
    await pause();
  }

  deps.kv.set(MEDIA_METADATA_MIGRATION_KEY, { lastRowId: cursor, done: true } satisfies MigrationState);
  return { ...result, done: true };
}
