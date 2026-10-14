import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  describeStartupMigrationCheckpoint,
  readStartupMigrationCheckpointStamp,
  StartupMigrationCheckpointOutcome,
} from './openclawStartupCheckpoint';

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-checkpoint-'));
  fs.mkdirSync(path.join(stateDir, 'state'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('reads the startup-migration checkpoint stamp without writing the database', () => {
  expect(readStartupMigrationCheckpointStamp(stateDir)).toBeNull();
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  const database = new Database(databasePath);
  database.exec('CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, app_version TEXT, updated_at INTEGER)');
  expect(readStartupMigrationCheckpointStamp(stateDir)).toBeNull();
  database.prepare('INSERT INTO schema_meta VALUES (?, ?, ?)').run('startup-migrations', 'v', 1_727_000_000_000);
  database.close();
  expect(readStartupMigrationCheckpointStamp(stateDir)).toBe(1_727_000_000_000);
});

test('an unchanged stamp across a start is a checkpoint hit', () => {
  expect(describeStartupMigrationCheckpoint(10, 10)).toBe(StartupMigrationCheckpointOutcome.Hit);
  expect(describeStartupMigrationCheckpoint(10, 20)).toBe(StartupMigrationCheckpointOutcome.Miss);
  expect(describeStartupMigrationCheckpoint(null, 20)).toBe(StartupMigrationCheckpointOutcome.Miss);
  expect(describeStartupMigrationCheckpoint(10, null)).toBe(StartupMigrationCheckpointOutcome.Unknown);
});
