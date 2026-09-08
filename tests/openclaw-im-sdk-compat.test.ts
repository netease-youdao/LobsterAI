import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { patchDingtalk } = require('../scripts/openclaw-plugin-patches/dingtalk.cjs');
const { patchLark } = require('../scripts/openclaw-plugin-patches/lark.cjs');

const tempDirs: string[] = [];

function writeFile(root: string, relativePath: string, content: string) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function createRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-im-sdk-'));
  tempDirs.push(root);
  // Model 2026.8.1's package boundary: the removed barrels are not exported.
  writeFile(root, 'node_modules/openclaw/package.json', JSON.stringify({
    name: 'openclaw',
    exports: {
      './plugin-sdk/plugin-entry': './plugin-entry.cjs',
      './plugin-sdk/channel-outbound': './channel-outbound.cjs',
      './plugin-sdk/channel-reply-pipeline': './channel-outbound.cjs',
      './plugin-sdk/session-store-runtime': './session-store.cjs',
    },
  }));
  writeFile(root, 'node_modules/openclaw/plugin-entry.cjs',
    'exports.emptyPluginConfigSchema = () => ({ type: "object", additionalProperties: false });');
  writeFile(root, 'node_modules/openclaw/channel-outbound.cjs', [
    'exports.createReplyPrefixContext = () => "prefix";',
    'exports.createReplyPrefixOptions = () => "options";',
    'exports.createTypingCallbacks = () => "typing";',
    'exports.logTypingFailure = () => "failure";',
  ].join('\n'));
  writeFile(root, 'node_modules/openclaw/session-store.cjs', [
    'exports.resolveStorePath = () => "sessions.json";',
    'exports.loadSessionStore = () => ({ "agent:main:feishu": { verboseLevel: "full" } });',
    'exports.resolveSessionStoreEntry = ({ store, sessionKey }) => ({ existing: store[sessionKey] });',
  ].join('\n'));
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('DingTalk and Lark OpenClaw SDK compatibility', () => {
  test('keeps DingTalk load-path detection portable and loads its deferred reply helpers', () => {
    const root = createRuntime();
    const pluginDir = path.join(root, 'dingtalk-connector');
    const entrySource = [
      'export function recordPath(paths) {',
      '  const here = typeof import.meta !== "undefined" && import.meta?.url ? String(import.meta.url) : "<unknown>";',
      '  paths.add(here);',
      '  return paths.size;',
      '}',
      'export const loadReply = () => import("./message-handler-test.mjs");',
    ].join('\n');
    const replySource = [
      'const { createReplyPrefixOptions, createTypingCallbacks, logTypingFailure } = await import("openclaw/plugin-sdk/channel-runtime");',
      'export const reply = () => [createReplyPrefixOptions(), createTypingCallbacks(), logTypingFailure()];',
    ].join('\n');
    writeFile(pluginDir, 'index.ts', entrySource);
    writeFile(pluginDir, 'dist/index.mjs', entrySource);
    writeFile(pluginDir, 'src/reply-dispatcher.ts', replySource);
    writeFile(pluginDir, 'dist/message-handler-test.mjs', replySource);
    const context = { runtimeExtensionsDir: root, log: () => {} };
    patchDingtalk(context);
    const patchedEntry = fs.readFileSync(path.join(pluginDir, 'dist/index.mjs'), 'utf8');
    // Jiti supports direct import.meta.url, but cannot lower these two forms.
    expect(patchedEntry).not.toContain('typeof import.meta');
    expect(patchedEntry).not.toContain('import.meta?');
    expect(patchedEntry).toContain('String(import.meta.url)');
    expect(fs.readFileSync(path.join(pluginDir, 'index.ts'), 'utf8')).toBe(patchedEntry);
    const patchedReply = fs.readFileSync(path.join(pluginDir, 'dist/message-handler-test.mjs'), 'utf8');
    expect(fs.readFileSync(path.join(pluginDir, 'src/reply-dispatcher.ts'), 'utf8')).toBe(patchedReply);
    patchDingtalk(context);
    expect(fs.readFileSync(path.join(pluginDir, 'dist/index.mjs'), 'utf8')).toBe(patchedEntry);
    expect(fs.readFileSync(path.join(pluginDir, 'dist/message-handler-test.mjs'), 'utf8')).toBe(patchedReply);

    // Move the prepared package: module identity must follow its new location.
    const relocatedDir = path.join(root, 'relocated-dingtalk');
    fs.renameSync(pluginDir, relocatedDir);
    const check = spawnSync(process.execPath, ['--input-type=module', '-e', [
      'import { pathToFileURL } from "node:url";',
      'import assert from "node:assert/strict";',
      'const url = pathToFileURL(process.argv[1]).href;',
      'const entry = await import(url);',
      'const paths = new Set();',
      'assert.equal(entry.recordPath(paths), 1);',
      'assert.equal(entry.recordPath(paths), 1);',
      'assert.deepEqual([...paths], [url]);',
      'assert.deepEqual((await entry.loadReply()).reply(), ["options", "typing", "failure"]);',
    ].join('\n'), path.join(relocatedDir, 'dist/index.mjs')], { encoding: 'utf8' });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
  });

  test('loads Lark registration, reply callbacks and saved verbose state without legacy SDK exports', () => {
    const root = createRuntime();
    const pluginDir = path.join(root, 'openclaw-lark');
    const entry = writeFile(pluginDir, 'index.js', [
      'const plugin_sdk_1 = require("openclaw/plugin-sdk");',
      'exports.configSchema = plugin_sdk_1.emptyPluginConfigSchema();',
      'exports.reply = require("./src/card/reply-dispatcher.js").reply;',
      'exports.verbose = require("./src/card/tool-use-config.js").verbose;',
    ].join('\n'));
    const reply = writeFile(pluginDir, 'src/card/reply-dispatcher.js', [
      'const channel_runtime_1 = require("openclaw/plugin-sdk/channel-runtime");',
      'exports.reply = () => [channel_runtime_1.createReplyPrefixContext(), channel_runtime_1.createTypingCallbacks()];',
    ].join('\n'));
    const verbose = writeFile(pluginDir, 'src/card/tool-use-config.js', [
      'const config_runtime_1 = require("openclaw/plugin-sdk/config-runtime");',
      'exports.verbose = (sessionKey) => {',
      '  const storePath = config_runtime_1.resolveStorePath();',
      '  const store = config_runtime_1.loadSessionStore(storePath);',
      '  return config_runtime_1.resolveSessionStoreEntry({ store, sessionKey }).existing?.verboseLevel;',
      '};',
    ].join('\n'));
    const unrelated = writeFile(root, 'another-plugin/index.js', 'require("openclaw/plugin-sdk");');
    const context = { runtimeExtensionsDir: root, log: () => {} };
    patchLark(context);
    const firstPass = [entry, reply, verbose].map(file => fs.readFileSync(file, 'utf8'));
    patchLark(context);
    expect([entry, reply, verbose].map(file => fs.readFileSync(file, 'utf8'))).toEqual(firstPass);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('require("openclaw/plugin-sdk");');

    const plugin = createRequire(entry)(entry);
    expect(plugin.configSchema).toEqual({ type: 'object', additionalProperties: false });
    expect(plugin.reply()).toEqual(['prefix', 'typing']);
    expect(plugin.verbose('agent:main:feishu')).toBe('full');
    expect(plugin.verbose('missing')).toBeUndefined();
  });

  test('skips SDK compatibility changes when the two plugins are absent', () => {
    const root = createRuntime();
    const before = fs.readdirSync(root);
    const context = { runtimeExtensionsDir: root, log: () => {} };
    patchDingtalk(context);
    patchLark(context);
    expect(fs.readdirSync(root)).toEqual(before);
  });
});
