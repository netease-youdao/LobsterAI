#!/usr/bin/env node
'use strict';

// Read-only breakdown of every OpenClaw gateway start recorded in LobsterAI's
// main logs: where each start spent its time, why it started, and how long
// each shutdown took. It only reads log files, so it is safe to run against a
// user's real installation while the app is running.
//
//   node scripts/analyze-openclaw-startup-logs.cjs [--days 3] [--log-dir <dir>] [--json <file>]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { STARTUP_PHASES, median, parseMainLogStartups } = require('./openclaw-startup-timeline.cjs');

// Matches the 6s grace in src/main/libs/openclawGatewayProcess.ts.
const GATEWAY_SHUTDOWN_GRACE_MS = 6000;

function defaultLogDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Logs', 'LobsterAI');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'LobsterAI', 'logs');
  return path.join(os.homedir(), '.config', 'LobsterAI', 'logs');
}

function listMainLogs(logDir, days) {
  const files = fs.readdirSync(logDir)
    .filter(name => /^main-\d{4}-\d{2}-\d{2}(\.old)?\.log$/.test(name))
    // An .old.log holds the earlier part of the same day.
    .sort((a, b) => a.replace('.old.log', '.0.log').localeCompare(b.replace('.old.log', '.0.log')));
  const dates = [...new Set(files.map(name => name.slice(5, 15)))].slice(-days);
  return files.filter(name => dates.includes(name.slice(5, 15))).map(name => path.join(logDir, name));
}

function fmt(ms) {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '-';
}

function main() {
  const { values } = parseArgs({
    options: {
      days: { type: 'string', default: '3' },
      'log-dir': { type: 'string', default: defaultLogDir() },
      json: { type: 'string' },
    },
  });
  const files = listMainLogs(values['log-dir'], Number(values.days));
  if (files.length === 0) {
    console.error(`No main-*.log files in ${values['log-dir']}`);
    process.exit(1);
  }
  const lines = files.flatMap(file => fs.readFileSync(file, 'utf8').split('\n'));
  const { attempts, shutdowns } = parseMainLogStartups(lines);

  console.log(`Analyzed ${files.length} log file(s): ${files.map(f => path.basename(f)).join(', ')}\n`);
  const phaseKeys = STARTUP_PHASES.map(p => p.key);
  const header = ['started', 'reason', 'prep', 'preSpawn', ...phaseKeys, 'checkpoint', 'appLaunch→spawn'];
  const rows = attempts.map(a => [
    a.startedAt.slice(5, 19),
    a.reason.slice(0, 40),
    a.prep,
    fmt(a.preSpawnMs),
    ...phaseKeys.map(k => fmt(a.phases[k])),
    a.ready === false ? 'NOT READY' : `${a.checkpoint ?? '-'}${a.checkpointChanged ? `(${a.checkpointChanged.join(',')})` : ''}`,
    fmt(a.sinceAppStartMs),
  ]);
  console.table(rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]))));

  const readyAttempts = attempts.filter(a => a.ready);
  console.log('\nMedian per phase over ready starts:');
  for (const key of phaseKeys) {
    console.log(`  ${key.padEnd(9)} ${fmt(median(readyAttempts.map(a => a.phases[key])))}`);
  }
  const misses = readyAttempts.filter(a => a.checkpoint === 'miss').length;
  console.log(`  checkpoint misses: ${misses}/${readyAttempts.length}`
    + ' (a miss reruns OpenClaw\'s state migrations, which integrity-check every agent database during boot)');

  const killed = shutdowns.filter(s => s.killed);
  console.log(`\nShutdowns: ${shutdowns.length}, median ${fmt(median(shutdowns.map(s => s.durationMs)))},`
    + ` killed after the ${GATEWAY_SHUTDOWN_GRACE_MS}ms grace: ${killed.length}`);
  for (const s of killed) console.log(`  ${s.startedAt} pid=${s.pid} ${fmt(s.durationMs)} (SIGKILL)`);

  if (values.json) {
    fs.writeFileSync(values.json, `${JSON.stringify({ files, attempts, shutdowns }, null, 2)}\n`);
    console.log(`\nWrote ${values.json}`);
  }
}

main();
