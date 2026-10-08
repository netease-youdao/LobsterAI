'use strict';

// Read-only locator for the same replay validation used by the patched runtime.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { parseArgs } = require('node:util');
const { build } = require('esbuild');

const MAX_LOCATIONS = 200;
const MESSAGE_ROLES = new Set(['user', 'assistant', 'toolResult']);

async function loadValidator(sourceDir) {
  const entry = path.join(sourceDir, 'packages/ai/src/transcript-replay-validation.ts');
  if (!fs.existsSync(entry)) {
    throw new Error('Patched OpenClaw source is required; set --openclaw-src or OPENCLAW_SRC.');
  }
  const compiled = await build({
    entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm',
  });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeEntryId(value) {
  return typeof value === 'string' && /^[\w:.-]{1,128}$/.test(value) ? value : undefined;
}

async function diagnoseReplay(inputPath, options = {}) {
  const input = path.resolve(inputPath);
  const sourceDir = options.openclawSource || process.env.OPENCLAW_SRC || path.resolve(__dirname, '../../openclaw');
  const { sanitizeReplayMessages } = await loadValidator(sourceDir);
  const messages = [];
  const origins = [];
  const issues = [];
  let issueCount = 0;
  let recordCount = 0;
  const report = (issue) => {
    issueCount += 1;
    if (issues.length < MAX_LOCATIONS) issues.push(issue);
  };
  const accept = (text, origin) => {
    recordCount += 1;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      report({ ...origin, field: 'json', action: 'unreadable-record' });
      return;
    }
    if (!isRecord(event)) return;
    const message = event.type === 'message' ? event.message : event;
    if (!isRecord(message) || !MESSAGE_ROLES.has(message.role)) return;
    messages.push(message);
    origins.push({ ...origin, entryId: safeEntryId(event.id) });
  };

  // Open only existing files. No schema migration or transcript rewrite is performed.
  const handle = fs.openSync(input, 'r');
  const signature = Buffer.alloc(16);
  try {
    fs.readSync(handle, signature, 0, signature.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  const sqlite = signature.toString('utf8') === 'SQLite format 3\0';
  if (!sqlite && path.extname(input).toLowerCase() === '.json') {
    throw new Error('Use raw OpenClaw JSONL, not the display conversation JSON, which omits replay fields.');
  }
  if (!sqlite && options.sessionId) {
    throw new Error('--session filters SQLite only; select the corresponding raw JSONL file.');
  }
  if (sqlite) {
    if (!options.sessionId) throw new Error('--session is required for an OpenClaw agent SQLite database.');
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(input, { readOnly: true });
    try {
      database.exec('PRAGMA query_only = ON');
      const rows = database.prepare(
        'SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq',
      ).iterate(options.sessionId);
      for (const row of rows) accept(row.event_json, { seq: row.seq });
    } finally {
      database.close();
    }
  } else {
    const stream = fs.createReadStream(input, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let line = 0;
    try {
      for await (const text of lines) {
        line += 1;
        if (text.trim()) accept(text, { line });
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  if (messages.length === 0 && issueCount === 0) {
    throw new Error('No raw transcript messages found. Use OpenClaw JSONL or an agent SQLite database; the display conversation JSON omits replay fields.');
  }
  sanitizeReplayMessages(messages, (issue) => report({ ...origins[issue.messageIndex], ...issue }));
  return {
    input, format: sqlite ? 'sqlite' : 'jsonl',
    ...(sqlite ? { sessionId: options.sessionId } : {}),
    scope: 'stored-records; includes historical branches, not necessarily the active replay window',
    recordCount, messageCount: messages.length, issueCount,
    truncated: issueCount > issues.length, issues,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { session: { type: 'string' }, 'openclaw-src': { type: 'string' }, help: { type: 'boolean' } },
  });
  if (values.help) {
    console.log('Usage: node scripts/diagnose-openclaw-replay.cjs <raw.jsonl|openclaw-agent.sqlite> [--session ID] [--openclaw-src DIR]');
    return;
  }
  if (positionals.length !== 1) throw new Error('Provide exactly one raw transcript file; use --help for usage.');
  const result = await diagnoseReplay(positionals[0], { sessionId: values.session, openclawSource: values['openclaw-src'] });
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { diagnoseReplay };
if (require.main === module) {
  main().catch((error) => {
    console.error(`[replay-diagnostic] ${error.message}`);
    process.exitCode = 1;
  });
}
