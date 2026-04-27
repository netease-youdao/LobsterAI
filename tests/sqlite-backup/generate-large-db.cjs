#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DEFAULTS = {
  db: path.resolve(process.cwd(), 'lobsterai.sqlite'),
  sessions: 20,
  messagesPerSession: 5000,
  payloadKb: 8,
  cwd: process.cwd(),
  executionMode: 'local',
  assistantRatio: 0.5,
  reportEvery: 1000,
};

function printHelp() {
  console.log(`
Usage:
  node tests/sqlite-backup/generate-large-db.cjs [options]

Options:
  --db <path>                    SQLite database path
  --sessions <number>           Number of cowork sessions to create
  --messages-per-session <n>    Messages per session
  --payload-kb <number>         Approximate content size per message in KiB
  --cwd <path>                  cwd value to store in cowork_sessions
  --execution-mode <mode>       execution_mode value to store
  --assistant-ratio <0..1>      Portion hint for assistant messages, default 0.5
  --report-every <number>       Print progress every N inserted messages
  --help                        Show this help

Examples:
  node tests/sqlite-backup/generate-large-db.cjs --db ~/tmp/lobsterai.sqlite
  node tests/sqlite-backup/generate-large-db.cjs --db ./tmp/lobsterai.sqlite --sessions 50 --messages-per-session 10000 --payload-kb 16
`);
}

function parseNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected ${name} to be a positive number, received "${value}"`);
  }
  return parsed;
}

function parseRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Expected --assistant-ratio to be between 0 and 1, received "${value}"`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case '--db':
        if (!next) throw new Error('Missing value for --db');
        options.db = path.resolve(next);
        index += 1;
        break;
      case '--sessions':
        if (!next) throw new Error('Missing value for --sessions');
        options.sessions = parseNumber(next, '--sessions');
        index += 1;
        break;
      case '--messages-per-session':
        if (!next) throw new Error('Missing value for --messages-per-session');
        options.messagesPerSession = parseNumber(next, '--messages-per-session');
        index += 1;
        break;
      case '--payload-kb':
        if (!next) throw new Error('Missing value for --payload-kb');
        options.payloadKb = parseNumber(next, '--payload-kb');
        index += 1;
        break;
      case '--cwd':
        if (!next) throw new Error('Missing value for --cwd');
        options.cwd = path.resolve(next);
        index += 1;
        break;
      case '--execution-mode':
        if (!next) throw new Error('Missing value for --execution-mode');
        options.executionMode = next;
        index += 1;
        break;
      case '--assistant-ratio':
        if (!next) throw new Error('Missing value for --assistant-ratio');
        options.assistantRatio = parseRatio(next);
        index += 1;
        break;
      case '--report-every':
        if (!next) throw new Error('Missing value for --report-every');
        options.reportEvery = parseNumber(next, '--report-every');
        index += 1;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function ensureSqlite3Available() {
  const probe = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error('sqlite3 CLI is required but was not found in PATH');
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createPayloadBytes(targetBytes) {
  const line = 'The quick brown lobster benchmarks SQLite backup throughput with wide message payloads.\n';
  return line.repeat(Math.max(1, Math.ceil(targetBytes / Buffer.byteLength(line))));
}

function buildMessageContent(basePayload, sessionIndex, messageIndex, type) {
  return [
    `Session ${sessionIndex + 1}, message ${messageIndex + 1}, type=${type}.`,
    'This synthetic message is generated for backup performance testing.',
    basePayload,
  ].join('\n');
}

function ensureSchemaSql() {
  return `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -16000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cowork_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  claude_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  pinned INTEGER NOT NULL DEFAULT 0,
  cwd TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  model_override TEXT NOT NULL DEFAULT '',
  execution_mode TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  active_skill_ids TEXT,
  agent_id TEXT NOT NULL DEFAULT 'main'
);

CREATE TABLE IF NOT EXISTS cowork_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  sequence INTEGER,
  FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_id
ON cowork_messages(session_id);
`;
}

function runSqlite(dbPath, sql) {
  const result = spawnSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite3 exited with status ${result.status}`);
  }
}

function statSize(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.statSync(filePath).size;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureSqlite3Available();

  fs.mkdirSync(path.dirname(options.db), { recursive: true });
  runSqlite(options.db, ensureSchemaSql());

  const basePayload = createPayloadBytes(options.payloadKb * 1024);
  const totalMessages = options.sessions * options.messagesPerSession;
  const startTime = Date.now();
  const tempSqlPath = path.join(
    os.tmpdir(),
    `lobsterai-sqlite-backup-seed-${process.pid}-${Date.now()}.sql`,
  );

  let insertedMessages = 0;
  const sqlLines = [
    'BEGIN IMMEDIATE;',
  ];

  try {
    for (let sessionIndex = 0; sessionIndex < options.sessions; sessionIndex += 1) {
      const sessionId = crypto.randomUUID();
      const sessionStart = Date.now() - (options.sessions - sessionIndex) * 60_000;

      sqlLines.push(`
INSERT INTO cowork_sessions (
  id, title, claude_session_id, status, pinned, cwd, system_prompt, model_override,
  execution_mode, created_at, updated_at, active_skill_ids, agent_id
) VALUES (
  ${sqlString(sessionId)},
  ${sqlString(`SQLite backup perf session ${sessionIndex + 1}`)},
  '',
  'idle',
  0,
  ${sqlString(options.cwd)},
  '',
  '',
  ${sqlString(options.executionMode)},
  ${sessionStart},
  ${sessionStart},
  NULL,
  'main'
);`.trim());

      for (let messageIndex = 0; messageIndex < options.messagesPerSession; messageIndex += 1) {
        const ratioIndex = (messageIndex + 1) / options.messagesPerSession;
        const type = ratioIndex <= options.assistantRatio && messageIndex % 2 === 1 ? 'assistant' : 'user';
        const createdAt = sessionStart + messageIndex * 1000;
        const metadata = type === 'assistant'
          ? JSON.stringify({ isFinal: true, synthetic: true })
          : JSON.stringify({ synthetic: true });

        sqlLines.push(`
INSERT INTO cowork_messages (
  id, session_id, type, content, metadata, created_at, sequence
) VALUES (
  ${sqlString(crypto.randomUUID())},
  ${sqlString(sessionId)},
  ${sqlString(type)},
  ${sqlString(buildMessageContent(basePayload, sessionIndex, messageIndex, type))},
  ${sqlString(metadata)},
  ${createdAt},
  ${messageIndex + 1}
);`.trim());

        insertedMessages += 1;
        if (insertedMessages % options.reportEvery === 0 || insertedMessages === totalMessages) {
          console.log(
            `[sqlite-backup] Prepared ${insertedMessages}/${totalMessages} messages (${sessionIndex + 1}/${options.sessions} sessions)`,
          );
        }
      }
    }

    sqlLines.push('COMMIT;');
    fs.writeFileSync(tempSqlPath, sqlLines.join('\n'), 'utf8');

    console.log(`[sqlite-backup] Importing test data into ${options.db}`);
    console.log(
      `[sqlite-backup] sessions=${options.sessions}, messagesPerSession=${options.messagesPerSession}, payloadKb=${options.payloadKb}`,
    );

    const importResult = spawnSync('sqlite3', [options.db], {
      input: `.read ${tempSqlPath}\n`,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 20,
    });

    if (importResult.error) {
      throw importResult.error;
    }
    if (importResult.status !== 0) {
      throw new Error(importResult.stderr || `sqlite3 import exited with status ${importResult.status}`);
    }

    const durationMs = Date.now() - startTime;
    const dbSize = statSize(options.db);
    const walSize = statSize(`${options.db}-wal`);

    console.log(`[sqlite-backup] Done in ${durationMs} ms`);
    console.log(`[sqlite-backup] main db size: ${(dbSize / 1024 / 1024).toFixed(2)} MiB`);
    console.log(`[sqlite-backup] wal size: ${(walSize / 1024 / 1024).toFixed(2)} MiB`);
    console.log('[sqlite-backup] Tip: close the app or run a checkpoint before measuring backup of the main db file only.');
  } finally {
    fs.rmSync(tempSqlPath, { force: true });
  }
}

try {
  main();
} catch (error) {
  console.error('[sqlite-backup] Failed to generate test data:', error);
  process.exitCode = 1;
}
