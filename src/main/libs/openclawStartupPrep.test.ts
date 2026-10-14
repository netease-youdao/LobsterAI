import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import {
  configRequiresStartupCompatibility,
  OPENCLAW_STARTUP_PREP_MARKER_MAX_AGE_MS,
  OpenClawStartupPrepMarker,
  resolveStartupPrepIdentity,
} from './openclawStartupPrep';

let root: string;
let stateDir: string;
let runtimeRoot: string;
let markerPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-prep-'));
  stateDir = path.join(root, 'openclaw', 'state');
  runtimeRoot = path.join(root, 'runtime');
  markerPath = path.join(root, 'openclaw', 'startup-prep-marker.json');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'identity'), { recursive: true });
  fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'state', 'openclaw.sqlite'), 'db');
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify({ version: '2026.8.1' }));
  fs.writeFileSync(path.join(runtimeRoot, 'dist', 'build-info.json'), JSON.stringify({ builtAt: '2026-09-23T12:14:16.020Z' }));
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw-startup-compat.mjs'), 'compat');
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw-startup-state-migration.mjs'), 'migration');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('identity follows the app, runtime build and helper bundles', () => {
  const identity = resolveStartupPrepIdentity(runtimeRoot, '2026.9.24');
  expect(resolveStartupPrepIdentity(runtimeRoot, '2026.9.24')).toBe(identity);
  expect(resolveStartupPrepIdentity(runtimeRoot, '2026.9.25')).not.toBe(identity);
  fs.writeFileSync(path.join(runtimeRoot, 'openclaw-startup-state-migration.mjs'), 'rebuilt migration helper');
  expect(resolveStartupPrepIdentity(runtimeRoot, '2026.9.24')).not.toBe(identity);
});

test('a recorded clean preparation stays valid until an input changes', () => {
  const identity = resolveStartupPrepIdentity(runtimeRoot, '2026.9.24');
  const legacyDeviceAuth = path.join(stateDir, 'identity', 'device-auth.json');
  const retiredIdentity = path.join(stateDir, 'identity', 'device.json');
  fs.writeFileSync(retiredIdentity, '{"retired":true}');
  const marker = new OpenClawStartupPrepMarker(markerPath, stateDir);
  marker.record(identity, [legacyDeviceAuth, retiredIdentity, retiredIdentity], 1_000);

  expect(marker.check(identity, 2_000)).toEqual({ valid: true, reason: 'unchanged' });
  expect(marker.check('other-runtime', 2_000)).toEqual({ valid: false, reason: 'runtime-changed' });
  expect(marker.check(identity, 1_000 + OPENCLAW_STARTUP_PREP_MARKER_MAX_AGE_MS + 1))
    .toEqual({ valid: false, reason: 'expired' });

  // A downgraded runtime writes a legacy file that was absent when the marker was recorded.
  fs.writeFileSync(legacyDeviceAuth, '{}');
  expect(marker.check(identity, 2_000)).toEqual({ valid: false, reason: 'legacy-input-changed:device-auth.json' });
});

test('a replaced shared-state database invalidates the marker', () => {
  const identity = resolveStartupPrepIdentity(runtimeRoot, '2026.9.24');
  const marker = new OpenClawStartupPrepMarker(markerPath, stateDir);
  marker.record(identity, [], 1_000);
  const databasePath = path.join(stateDir, 'state', 'openclaw.sqlite');
  const restoredPath = `${databasePath}.restored`;
  fs.writeFileSync(restoredPath, 'db');
  fs.renameSync(restoredPath, databasePath);
  expect(marker.check(identity, 2_000)).toEqual({ valid: false, reason: 'state-database-replaced' });
});

test('clear removes the marker and a missing marker is never valid', () => {
  const identity = resolveStartupPrepIdentity(runtimeRoot, '2026.9.24');
  const marker = new OpenClawStartupPrepMarker(markerPath, stateDir);
  expect(marker.check(identity)).toEqual({ valid: false, reason: 'no-marker' });
  marker.record(identity, []);
  expect(marker.check(identity)).toEqual({ valid: true, reason: 'unchanged' });
  marker.clear('test');
  expect(fs.existsSync(markerPath)).toBe(false);
  fs.writeFileSync(markerPath, '{"version":1}');
  expect(marker.check(identity)).toEqual({ valid: false, reason: 'unreadable-marker' });
});

test('config states handled by the compatibility helper always require it', () => {
  expect(configRequiresStartupCompatibility({ plugins: { entries: {} }, gateway: { reload: { mode: 'hybrid' } } })).toBe(false);
  expect(configRequiresStartupCompatibility(null)).toBe(false);
  expect(configRequiresStartupCompatibility({ plugins: { bundledDiscovery: 'compat' } })).toBe(true);
  expect(configRequiresStartupCompatibility({ gateway: { reload: { mode: 'hot' } } })).toBe(true);
  expect(configRequiresStartupCompatibility({ gateway: { reload: { mode: 'hybrid', debounceMs: 300 } } })).toBe(true);
  expect(configRequiresStartupCompatibility({ plugins: { entries: { 'nsp-clawguard': { enabled: true } } } })).toBe(true);
  expect(configRequiresStartupCompatibility({ plugins: { entries: { 'nsp-clawguard': { enabled: false } } } })).toBe(false);
});
