import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { AgentId } from '../../shared/agent/constants';
import type { CoworkMessage } from '../coworkStore';
import { SubagentMessageStore } from '../subagentMessageStore';

const HISTORY_IMPORT_KEY = 'migration.dsh.subagent-history.v1';
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

interface LegacyRun {
  id: string;
  session_key: string;
  created_at: number;
}

function readOwnedFile(root: string, candidate: string): string | undefined {
  try {
    const real = fs.realpathSync(candidate);
    const relative = path.relative(root, real);
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return;
    if (fs.statSync(real).isFile()) return fs.readFileSync(real, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** pi transcripts may have multiple branches. Follow the current leaf's parent chain. */
function activeEntries(source: string, expectedId: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { entries.push(record(JSON.parse(line))); } catch { /* Keep complete entries in old journals. */ }
  }
  if (entries[0]?.type !== 'session' || entries[0].id !== expectedId) return [];
  const nodes = entries.slice(1);
  const leaf = nodes.at(-1);
  if (!leaf || !Object.hasOwn(leaf, 'parentId')) return nodes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let node: Record<string, unknown> | undefined = leaf;
  while (node && !seen.has(node.id)) {
    chain.push(node);
    seen.add(node.id);
    node = node.parentId == null ? undefined : byId.get(node.parentId);
  }
  return chain.reverse();
}

function legacyMessages(source: string, expectedId: string, run: LegacyRun): CoworkMessage[] {
  const messages: CoworkMessage[] = [];
  for (const entry of activeEntries(source, expectedId)) {
    if (entry.type !== 'message') continue;
    const msg = record(entry.message);
    const timestamp = typeof msg.timestamp === 'number' ? msg.timestamp : Date.parse(String(entry.timestamp)) || run.created_at;
    const blocks = Array.isArray(msg.content) ? msg.content.map(record) : [];
    const text = typeof msg.content === 'string' ? msg.content :
      blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
    const add = (type: CoworkMessage['type'], content: string, metadata?: Record<string, unknown>) => {
      messages.push({ id: 'legacy-subagent/' + run.id + '/' + messages.length, type, content, timestamp, metadata });
    };
    if (msg.role === 'toolResult' || msg.role === 'tool') {
      add('tool_result', text, { toolUseId: msg.toolCallId ?? msg.tool_call_id, toolName: msg.toolName, isError: msg.isError === true });
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      if (text) add(msg.role, text);
      if (msg.role === 'assistant') for (const block of blocks) {
        if (block.type === 'toolCall' || block.type === 'tool_use' || block.type === 'tool_call') {
          add('tool_use', String(block.name ?? ''), { toolUseId: block.id, toolName: block.name, toolInput: block.arguments ?? block.input });
        }
      }
    }
  }
  return messages;
}

/** Import uncached release-era child histories before the first upgraded window opens. */
export function migrateLegacySubagentHistory(db: Database.Database, stateDir: string): void {
  if (!fs.existsSync(stateDir)) return;
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name));
  if (!['kv', 'subagent_runs', 'subagent_messages'].every(t => tables.has(t))) return;
  if (db.prepare('SELECT 1 FROM kv WHERE key = ?').get(HISTORY_IMPORT_KEY)) return;
  const root = fs.realpathSync(stateDir);
  const profile = fs.realpathSync(path.dirname(path.dirname(stateDir)));
  if (path.relative(profile, root) !== path.join('openclaw', 'state')) return;
  const indexes = new Map<string, Record<string, unknown>>();
  const store = new SubagentMessageStore(db);
  const columns = db.pragma('table_info(subagent_runs)') as { name: string }[];
  const hasChildSessions = tables.has('cowork_messages') && columns.some(c => c.name === 'child_cowork_session_id');
  const withoutMaterializedHistory = hasChildSessions
    ? 'AND NOT EXISTS (SELECT 1 FROM cowork_messages c WHERE c.session_id = r.child_cowork_session_id)' : '';
  const pending = db.prepare(`SELECT id, session_key, created_at FROM subagent_runs r
    WHERE session_key LIKE 'agent:%'
      AND NOT EXISTS (SELECT 1 FROM subagent_messages m WHERE m.run_id = r.id)
      ${withoutMaterializedHistory}`).all() as LegacyRun[];
  let imported = 0;
  let missing = 0;
  db.transaction(() => {
    for (const run of pending) {
      // Preset experts can have dashboard keys. The release's run table identifies the child.
      const agent = /^agent:([a-z0-9_-]+):/i.exec(run.session_key)?.[1];
      if (!agent) continue;
      let found = false;
      // Releases with a shared session store can keep another expert's child under main.
      const dirs = new Set([path.join(root, 'agents', agent, 'sessions'),
        path.join(root, 'sessions'), path.join(root, 'agents', AgentId.Main, 'sessions')]);
      for (const dir of dirs) {
        let index = indexes.get(dir);
        if (!index) {
          const json = readOwnedFile(root, path.join(dir, 'sessions.json'));
          if (json) {
            try { index = record(JSON.parse(json)); } catch { index = {}; }
          } else index = {};
          indexes.set(dir, index);
        }
        const entry = record(index[run.session_key]);
        if (typeof entry.sessionId !== 'string' || !/^[\w-]+$/.test(entry.sessionId)) continue;
        const names = [typeof entry.sessionFile === 'string' ? entry.sessionFile : '', entry.sessionId + '.jsonl'];
        for (const name of new Set(names.filter(Boolean))) {
          if (!name.toLowerCase().endsWith('.jsonl')) continue;
          const source = readOwnedFile(root, path.resolve(dir, name));
          if (!source) continue;
          const messages = legacyMessages(source, entry.sessionId, run);
          if (!messages.length) continue;
          store.insertMessages(run.id, messages.map((msg, sequence) => ({ ...msg, sequence })));
          imported++;
          found = true;
          break;
        }
        if (found) break;
      }
      if (!found) missing++;
    }
    db.prepare('INSERT OR REPLACE INTO kv(key,value,updated_at) VALUES(?,?,?)')
      .run(HISTORY_IMPORT_KEY, JSON.stringify({ imported, missing }), Date.now());
  })();
  if (missing) console.warn('[SubagentMigration] Missing legacy transcripts for indexed runs:', missing);
}
