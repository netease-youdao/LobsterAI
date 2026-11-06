import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  describeStartupMigrationCheckpoint,
  listChangedStartupMigrationCheckpointParts,
  readStartupMigrationCheckpoint,
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

test('reads the startup-migration checkpoint without writing the database', () => {
  expect(readStartupMigrationCheckpoint(stateDir)).toBeNull();
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  const database = new Database(databasePath);
  database.exec('CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, app_version TEXT, updated_at INTEGER)');
  expect(readStartupMigrationCheckpoint(stateDir)).toBeNull();
  database.prepare('INSERT INTO schema_meta VALUES (?, ?, ?)').run('startup-migrations', 'v', 1_727_000_000_000);
  database.close();
  expect(readStartupMigrationCheckpoint(stateDir)).toEqual({ updatedAt: 1_727_000_000_000, value: 'v' });
});

test('an unchanged stamp across a start is a checkpoint hit', () => {
  expect(describeStartupMigrationCheckpoint(10, 10)).toBe(StartupMigrationCheckpointOutcome.Hit);
  expect(describeStartupMigrationCheckpoint(10, 20)).toBe(StartupMigrationCheckpointOutcome.Miss);
  expect(describeStartupMigrationCheckpoint(null, 20)).toBe(StartupMigrationCheckpointOutcome.Miss);
  expect(describeStartupMigrationCheckpoint(10, null)).toBe(StartupMigrationCheckpointOutcome.Unknown);
});

test('names the checkpoint parts that invalidated it', () => {
  const checkpoint = (parts: string[]) => ({ updatedAt: 1, value: parts.join('\n') });
  const before = checkpoint(['2026.8.1', '3', 'build-a', 'cfg-a', 'doctor-a', 'plugins-a']);
  expect(listChangedStartupMigrationCheckpointParts(before, before)).toEqual([]);
  expect(listChangedStartupMigrationCheckpointParts(
    before,
    checkpoint(['2026.8.1', '3', 'build-a', 'cfg-b', 'doctor-b', 'plugins-a']),
  )).toEqual(['effectiveConfig', 'pluginDoctorConfig']);
  expect(listChangedStartupMigrationCheckpointParts(
    before,
    checkpoint(['2026.8.1', '3', 'build-b', 'cfg-a', 'doctor-a', 'plugins-b']),
  )).toEqual(['buildIdentity', 'pluginMigration']);
  expect(listChangedStartupMigrationCheckpointParts(null, before)).toEqual([]);
  expect(listChangedStartupMigrationCheckpointParts(before, { updatedAt: 2, value: null })).toEqual([]);
});
