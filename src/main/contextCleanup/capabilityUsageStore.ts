import * as fs from 'node:fs';
import * as path from 'node:path';

import type Database from 'better-sqlite3';

import {
  CleanupCapabilityKind,
  CONTEXT_CLEANUP_DEFAULTS,
  CONTEXT_CLEANUP_KV_KEYS,
  DECISION_MODEL_JEV_ITEM_ID,
} from '../../shared/contextCleanup/constants';
import { DECISION_EVALUATE_TOOL_NAME } from '../../shared/decisionModel/constants';

export interface CapabilityUsageRow {
  kind: CleanupCapabilityKind;
  itemId: string;
  firstSeenAt: number;
  lastUsedAt: number | null;
  useCount: number;
  updatedAt: number;
}

export interface CapabilityUsageKvStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface BackfillFromDshHistoryOptions {
  dshHomeDir: string;
  kvStore: CapabilityUsageKvStore;
  mcpServerNameToId?: ReadonlyMap<string, string>;
  now?: number;
}

const BUILTIN_PROGRESSIVE_MCP_SERVERS = new Set([
  'computer-use',
  'lobster-browser',
  'lobster-word',
  'lobster-excel',
  'lobster-ppt',
]);

const MS_PER_DAY = 86_400_000;

interface PendingUsageDelta {
  kind: CleanupCapabilityKind;
  itemId: string;
  lastUsedAt: number;
  countDelta: number;
}

function makeUsageKey(kind: CleanupCapabilityKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

function parseMcpToolServerName(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  return rest.slice(0, sep);
}

/**
 * Lightweight SQLite store tracking when each capability (skill, MCP server,
 * specialist agent, Jev decision model, DSH plugin) was first seen and last used.
 */
export class CapabilityUsageStore {
  private readonly db: Database.Database;
  private readonly flushDebounceMs: number;
  private readonly pending = new Map<string, PendingUsageDelta>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(db: Database.Database, options?: { flushDebounceMs?: number }) {
    this.db = db;
    this.flushDebounceMs = options?.flushDebounceMs ?? CONTEXT_CLEANUP_DEFAULTS.FlushDebounceMs;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_usage (
        kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, item_id)
      );
    `);
  }

  /**
   * Queue a lightweight usage observation. Writes are debounced in memory and
   * coalesced into a single transaction so hot tool-call paths stay non-blocking.
   */
  recordUsage(kind: CleanupCapabilityKind, itemId: string, now = Date.now()): void {
    const cleanId = itemId.trim();
    if (!cleanId) return;
    const key = makeUsageKey(kind, cleanId);
    const existing = this.pending.get(key);
    if (existing) {
      existing.lastUsedAt = Math.max(existing.lastUsedAt, now);
      existing.countDelta += 1;
    } else {
      this.pending.set(key, { kind, itemId: cleanId, lastUsedAt: now, countDelta: 1 });
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    if (this.flushDebounceMs <= 0) {
      this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.flushDebounceMs);
    this.flushTimer.unref?.();
  }

  /** Immediately flush any buffered usage updates to SQLite. */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();

    const stmt = this.db.prepare(`
      INSERT INTO capability_usage (kind, item_id, first_seen_at, last_used_at, use_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, item_id) DO UPDATE SET
        first_seen_at = MIN(capability_usage.first_seen_at, excluded.first_seen_at),
        last_used_at = CASE
          WHEN capability_usage.last_used_at IS NULL THEN excluded.last_used_at
          ELSE MAX(capability_usage.last_used_at, excluded.last_used_at)
        END,
        use_count = capability_usage.use_count + excluded.use_count,
        updated_at = MAX(capability_usage.updated_at, excluded.updated_at)
    `);
    const tx = this.db.transaction((rows: PendingUsageDelta[]) => {
      for (const row of rows) {
        stmt.run(row.kind, row.itemId, row.lastUsedAt, row.lastUsedAt, row.countDelta, row.lastUsedAt);
      }
    });
    tx(batch);
  }

  /**
   * Ensure each currently enabled item has a `first_seen_at` baseline without
   * overwriting existing usage history.
   */
  ensureFirstSeen(
    entries: ReadonlyArray<{ kind: CleanupCapabilityKind; itemId: string; firstSeenAt: number }>,
    now = Date.now(),
  ): void {
    if (entries.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO capability_usage (kind, item_id, first_seen_at, last_used_at, use_count, updated_at)
      VALUES (?, ?, ?, NULL, 0, ?)
    `);
    const tx = this.db.transaction(
      (rows: ReadonlyArray<{ kind: CleanupCapabilityKind; itemId: string; firstSeenAt: number }>) => {
        for (const row of rows) {
          const cleanId = row.itemId.trim();
          if (!cleanId) continue;
          const ts = Number.isFinite(row.firstSeenAt) && row.firstSeenAt > 0 ? Math.floor(row.firstSeenAt) : now;
          stmt.run(row.kind, cleanId, ts, now);
        }
      },
    );
    tx(entries);
  }

  getUsageMap(): Map<string, CapabilityUsageRow> {
    this.flush();
    const rows = this.db.prepare(`
      SELECT kind, item_id, first_seen_at, last_used_at, use_count, updated_at
      FROM capability_usage
    `).all() as Array<{
      kind: CleanupCapabilityKind;
      item_id: string;
      first_seen_at: number;
      last_used_at: number | null;
      use_count: number;
      updated_at: number;
    }>;
    const map = new Map<string, CapabilityUsageRow>();
    for (const row of rows) {
      map.set(makeUsageKey(row.kind, row.item_id), {
        kind: row.kind,
        itemId: row.item_id,
        firstSeenAt: row.first_seen_at,
        lastUsedAt: row.last_used_at,
        useCount: row.use_count,
        updatedAt: row.updated_at,
      });
    }
    return map;
  }

  /**
   * One-time cold-start backfill reading recent DSH persisted projection caches
   * and SQLite `cowork_sessions` so upgrading users get accurate idle metrics
   * immediately without waiting 30 days.
   */
  backfillFromDshHistoryOnce(options: BackfillFromDshHistoryOptions): boolean {
    if (options.kvStore.get<number>(CONTEXT_CLEANUP_KV_KEYS.BackfilledV1)) {
      return false;
    }
    const now = options.now ?? Date.now();
    const cutoffMs = now - CONTEXT_CLEANUP_DEFAULTS.BackfillWindowDays * MS_PER_DAY;
    const aggregated = new Map<string, PendingUsageDelta>();

    const merge = (kind: CleanupCapabilityKind, itemId: string, usedAt: number, count: number) => {
      const cleanId = itemId.trim();
      if (!cleanId || count <= 0) return;
      const key = makeUsageKey(kind, cleanId);
      const prev = aggregated.get(key);
      if (prev) {
        prev.lastUsedAt = Math.max(prev.lastUsedAt, usedAt);
        prev.countDelta += count;
      } else {
        aggregated.set(key, { kind, itemId: cleanId, lastUsedAt: usedAt, countDelta: count });
      }
    };

    // 1. Scan DSH persisted projection caches (`contextTimeline`).
    const sessionsDir = path.join(options.dshHomeDir, 'storages', 'session_projcache', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      let fileNames: string[] = [];
      try {
        fileNames = fs.readdirSync(sessionsDir);
      } catch {
        fileNames = [];
      }
      for (const fileName of fileNames) {
        if (!fileName.endsWith('.json')) continue;
        const fullPath = path.join(sessionsDir, fileName);
        let mtimeMs = 0;
        try {
          const stat = fs.statSync(fullPath);
          mtimeMs = stat.mtimeMs;
          if (mtimeMs < cutoffMs) continue;
        } catch {
          continue;
        }
        try {
          const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as {
            record?: {
              rows?: {
                contextTimeline?: {
                  val?: {
                    totals?: { skills?: Record<string, unknown> };
                    timing?: { tools?: Record<string, unknown> };
                  };
                };
              };
            };
          };
          const ct = parsed?.record?.rows?.contextTimeline?.val;
          if (!ct) continue;

          const skills = ct.totals?.skills;
          if (skills && typeof skills === 'object') {
            for (const [skillId, rawCount] of Object.entries(skills)) {
              const count = typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount > 0 ? rawCount : 1;
              merge(CleanupCapabilityKind.Skill, skillId, Math.floor(mtimeMs), count);
            }
          }

          const tools = ct.timing?.tools;
          if (tools && typeof tools === 'object') {
            for (const [toolName, rawInfo] of Object.entries(tools)) {
              const calls = typeof rawInfo === 'number'
                ? rawInfo
                : (rawInfo && typeof rawInfo === 'object' && typeof (rawInfo as { calls?: unknown }).calls === 'number'
                  ? (rawInfo as { calls: number }).calls
                  : 1);
              if (toolName === DECISION_EVALUATE_TOOL_NAME) {
                merge(CleanupCapabilityKind.DecisionModel, DECISION_MODEL_JEV_ITEM_ID, Math.floor(mtimeMs), calls);
                continue;
              }
              const mcpServerName = parseMcpToolServerName(toolName);
              if (mcpServerName && !BUILTIN_PROGRESSIVE_MCP_SERVERS.has(mcpServerName)) {
                const resolvedId = options.mcpServerNameToId?.get(mcpServerName.toLowerCase()) ?? mcpServerName;
                merge(CleanupCapabilityKind.McpServer, resolvedId, Math.floor(mtimeMs), calls);
              }
            }
          }
        } catch {
          // Ignore malformed/partial projection cache files.
        }
      }
    }

    if (aggregated.size > 0) {
      for (const delta of aggregated.values()) {
        const key = makeUsageKey(delta.kind, delta.itemId);
        const existing = this.pending.get(key);
        if (existing) {
          existing.lastUsedAt = Math.max(existing.lastUsedAt, delta.lastUsedAt);
          existing.countDelta += delta.countDelta;
        } else {
          this.pending.set(key, delta);
        }
      }
      this.flush();
    }

    options.kvStore.set(CONTEXT_CLEANUP_KV_KEYS.BackfilledV1, now);
    return true;
  }
}

export { makeUsageKey };
