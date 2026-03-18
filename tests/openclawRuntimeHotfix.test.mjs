import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  applyBundledOpenClawRuntimeHotfixes,
  patchCronReminderCurrentTimeSuffix,
  patchCronReminderPromptEnvelope,
  patchCronSessionDeliveryInference,
  patchCronToolOwnerOnly,
  patchCronOwnerFallback,
  patchWecomMessageProviderExecDeny,
} = require('../dist-electron/main/libs/openclawRuntimeHotfix.js');

const walkJsFiles = (dirPath, files = []) => {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, files);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
};

test('patchCronToolOwnerOnly only flips the cron tool guard', () => {
  const source = [
    'function createCronTool(opts, deps) {',
    '  return {',
    '    label: "Cron",',
    '    name: "cron",',
    '    ownerOnly: true,',
    '  };',
    '}',
    'function createGatewayTool() {',
    '  return {',
    '    label: "Gateway",',
    '    name: "gateway",',
    '    ownerOnly: true,',
    '  };',
    '}',
  ].join('\n');

  const result = patchCronToolOwnerOnly(source);

  assert.equal(result.changed, true);
  assert.match(result.content, /name: "cron",\n\s+ownerOnly: false,/);
  assert.match(result.content, /name: "gateway",\n\s+ownerOnly: true,/);
});

test('patchCronOwnerFallback removes cron from owner-only fallback names only', () => {
  const source = [
    'const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set([',
    '  "whatsapp_login",',
    '  "cron",',
    '  "gateway"',
    ']);',
  ].join('\n');

  const result = patchCronOwnerFallback(source);

  assert.equal(result.changed, true);
  assert.doesNotMatch(result.content, /"cron"/);
  assert.match(result.content, /"whatsapp_login"/);
  assert.match(result.content, /"gateway"/);
});

test('patchWecomMessageProviderExecDeny denies exec/process for WeCom native sessions only', () => {
  const source = 'const TOOL_DENY_BY_MESSAGE_PROVIDER = { voice: ["tts"] };';

  const result = patchWecomMessageProviderExecDeny(source);

  assert.equal(result.changed, true);
  assert.match(
    result.content,
    /const TOOL_DENY_BY_MESSAGE_PROVIDER = \{ voice: \["tts"\], wecom: \["exec", "process"\] \};/,
  );
});

test('patchCronSessionDeliveryInference restores IM routing for persisted sessions and DingTalk keys', () => {
  const source = [
    'function inferDeliveryFromSessionKey(agentSessionKey) {',
    '  const rawSessionKey = agentSessionKey?.trim();',
    '  if (!rawSessionKey) return null;',
    '  const parsed = parseAgentSessionKey(stripThreadSuffixFromSessionKey(rawSessionKey));',
    '  if (!parsed || !parsed.rest) return null;',
    '  const parts = parsed.rest.split(":").filter(Boolean);',
    '  if (parts.length === 0) return null;',
    '  const head = parts[0]?.trim().toLowerCase();',
    '  if (!head || head === "main" || head === "subagent" || head === "acp") return null;',
    '  const markerIndex = parts.findIndex((part) => part === "direct" || part === "dm" || part === "group" || part === "channel");',
    '  if (markerIndex === -1) return null;',
    '  const peerId = parts.slice(markerIndex + 1).join(":").trim();',
    '  if (!peerId) return null;',
    '  let channel;',
    '  if (markerIndex >= 1) channel = parts[0]?.trim().toLowerCase();',
    '  const delivery = {',
    '    mode: "announce",',
    '    to: peerId',
    '  };',
    '  if (channel) delivery.channel = channel;',
    '  return delivery;',
    '}',
  ].join('\n').replaceAll('  ', '\t');

  const result = patchCronSessionDeliveryInference(source);

  assert.equal(result.changed, true);
  assert.match(result.content, /extractDeliveryInfo\(rawSessionKey\)/);
  assert.match(result.content, /persistedDelivery\?\.channel && persistedDelivery\?\.to/);
  assert.match(result.content, /head === "dingtalk-connector"/);
  assert.match(result.content, /to: `user:\$\{senderId\}`/);
  assert.match(result.content, /delivery\.accountId = persistedDelivery\.accountId/);
});

test('patchCronReminderPromptEnvelope strips scheduled reminder wrapper text', () => {
  const source = [
    'function buildCronEventPrompt(pendingEvents, opts) {',
    '\tconst deliverToUser = opts?.deliverToUser ?? true;',
    '\tconst eventText = pendingEvents.join("\\n").trim();',
    '\tif (!eventText) {',
    '\t\tif (!deliverToUser) return "A scheduled cron event was triggered, but no event content was found. Handle this internally and reply HEARTBEAT_OK when nothing needs user-facing follow-up.";',
    '\t\treturn "A scheduled cron event was triggered, but no event content was found. Reply HEARTBEAT_OK.";',
    '\t}',
    '\tif (!deliverToUser) return "A scheduled reminder has been triggered. The reminder content is:\\n\\n" + eventText + "\\n\\nHandle this reminder internally. Do not relay it to the user unless explicitly requested.";',
    '\treturn "A scheduled reminder has been triggered. The reminder content is:\\n\\n" + eventText + "\\n\\nPlease relay this reminder to the user in a helpful and friendly way.";',
    '}',
  ].join('\n');

  const result = patchCronReminderPromptEnvelope(source);

  assert.equal(result.changed, true);
  assert.match(result.content, /return eventText;/);
  assert.doesNotMatch(result.content, /A scheduled reminder has been triggered/);
});

test('patchCronReminderCurrentTimeSuffix skips appending Current time for cron reminder prompts', () => {
  const source = [
    'const hasCronEvents = true;',
    'const ctx = {',
    '\tBody: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),',
    '};',
  ].join('\n');

  const result = patchCronReminderCurrentTimeSuffix(source);

  assert.equal(result.changed, true);
  assert.match(
    result.content,
    /Body: hasCronEvents \? prompt : appendCronStyleCurrentTimeLine\(prompt, cfg, startedAt\),/,
  );
});

test('applyBundledOpenClawRuntimeHotfixes patches matching runtime dist files', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-runtime-hotfix-'));
  const distDir = path.join(tmpRoot, 'dist', 'plugin-sdk');
  fs.mkdirSync(distDir, { recursive: true });

  const targetFile = path.join(distDir, 'reply.js');
  fs.writeFileSync(
    targetFile,
    [
      'function createCronTool(opts, deps) {',
      '  return {',
      '    label: "Cron",',
      '    name: "cron",',
      '    ownerOnly: true,',
      '  };',
      '}',
      'const OWNER_ONLY_TOOL_NAME_FALLBACKS = new Set([',
      '  "whatsapp_login",',
      '  "cron",',
      '  "gateway"',
      ']);',
      'const TOOL_DENY_BY_MESSAGE_PROVIDER = { voice: ["tts"] };',
      'function inferDeliveryFromSessionKey(agentSessionKey) {',
      '\tconst rawSessionKey = agentSessionKey?.trim();',
      '\tif (!rawSessionKey) return null;',
      '\tconst parsed = parseAgentSessionKey(stripThreadSuffixFromSessionKey(rawSessionKey));',
      '\tif (!parsed || !parsed.rest) return null;',
      '\tconst parts = parsed.rest.split(":").filter(Boolean);',
      '\tif (parts.length === 0) return null;',
      '\tconst head = parts[0]?.trim().toLowerCase();',
      '\tif (!head || head === "main" || head === "subagent" || head === "acp") return null;',
      '\tconst markerIndex = parts.findIndex((part) => part === "direct" || part === "dm" || part === "group" || part === "channel");',
      '\tif (markerIndex === -1) return null;',
      '\tconst peerId = parts.slice(markerIndex + 1).join(":").trim();',
      '\tif (!peerId) return null;',
      '\tlet channel;',
      '\tif (markerIndex >= 1) channel = parts[0]?.trim().toLowerCase();',
      '\tconst delivery = {',
      '\t\tmode: "announce",',
      '\t\tto: peerId',
      '\t};',
      '\tif (channel) delivery.channel = channel;',
      '\treturn delivery;',
      '}',
      'function buildCronEventPrompt(pendingEvents, opts) {',
      '\tconst deliverToUser = opts?.deliverToUser ?? true;',
      '\tconst eventText = pendingEvents.join("\\n").trim();',
      '\tif (!eventText) {',
      '\t\tif (!deliverToUser) return "A scheduled cron event was triggered, but no event content was found. Handle this internally and reply HEARTBEAT_OK when nothing needs user-facing follow-up.";',
      '\t\treturn "A scheduled cron event was triggered, but no event content was found. Reply HEARTBEAT_OK.";',
      '\t}',
      '\tif (!deliverToUser) return "A scheduled reminder has been triggered. The reminder content is:\\n\\n" + eventText + "\\n\\nHandle this reminder internally. Do not relay it to the user unless explicitly requested.";',
      '\treturn "A scheduled reminder has been triggered. The reminder content is:\\n\\n" + eventText + "\\n\\nPlease relay this reminder to the user in a helpful and friendly way.";',
      '}',
      'const hasCronEvents = true;',
      'const ctx = {',
      '\tBody: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),',
      '};',
    ].join('\n'),
    'utf8',
  );

  const controlFile = path.join(tmpRoot, 'dist', 'other.js');
  fs.writeFileSync(
    controlFile,
    [
      'function noop() {',
      '  return { ownerOnly: true };',
      '}',
    ].join('\n'),
    'utf8',
  );

  const result = applyBundledOpenClawRuntimeHotfixes(tmpRoot);

  assert.equal(result.changed, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.patchedFiles, [targetFile]);
  assert.match(fs.readFileSync(targetFile, 'utf8'), /ownerOnly: false,/);
  assert.doesNotMatch(
    fs.readFileSync(targetFile, 'utf8'),
    /OWNER_ONLY_TOOL_NAME_FALLBACKS[\s\S]*"cron"/,
  );
  assert.match(
    fs.readFileSync(targetFile, 'utf8'),
    /TOOL_DENY_BY_MESSAGE_PROVIDER = \{ voice: \["tts"\], wecom: \["exec", "process"\] \};/,
  );
  assert.match(fs.readFileSync(targetFile, 'utf8'), /extractDeliveryInfo\(rawSessionKey\)/);
  assert.match(fs.readFileSync(targetFile, 'utf8'), /head === "dingtalk-connector"/);
  assert.match(fs.readFileSync(targetFile, 'utf8'), /return eventText;/);
  assert.match(
    fs.readFileSync(targetFile, 'utf8'),
    /Body: hasCronEvents \? prompt : appendCronStyleCurrentTimeLine\(prompt, cfg, startedAt\),/,
  );
  assert.match(fs.readFileSync(controlFile, 'utf8'), /ownerOnly: true/);
});

test('bundled OpenClaw runtime exposes cron to non-owner native sessions', () => {
  const runtimeDist = path.resolve('vendor/openclaw-runtime/mac-arm64/dist');
  const cronOwnerOffendingFiles = [];
  const cronFallbackOffendingFiles = [];

  for (const filePath of walkJsFiles(runtimeDist)) {
    const source = fs.readFileSync(filePath, 'utf8');
    if (patchCronToolOwnerOnly(source).changed) {
      cronOwnerOffendingFiles.push(path.relative(process.cwd(), filePath));
    }
    if (patchCronOwnerFallback(source).changed) {
      cronFallbackOffendingFiles.push(path.relative(process.cwd(), filePath));
    }
  }

  assert.deepEqual(cronOwnerOffendingFiles, []);
  assert.deepEqual(cronFallbackOffendingFiles, []);
});
