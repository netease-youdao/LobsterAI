'use strict';

const fs = require('fs');
const path = require('path');

const { readJsonFile, writeJsonFile } = require('./common.cjs');

const larkToolContracts = [
  'feishu_ask_user_question',
  'feishu_auth',
  'feishu_bitable_app',
  'feishu_bitable_app_table',
  'feishu_bitable_app_table_field',
  'feishu_bitable_app_table_record',
  'feishu_bitable_app_table_view',
  'feishu_calendar_calendar',
  'feishu_calendar_event',
  'feishu_calendar_event_attendee',
  'feishu_calendar_freebusy',
  'feishu_chat',
  'feishu_chat_members',
  'feishu_create_doc',
  'feishu_doc_comments',
  'feishu_doc_media',
  'feishu_drive_file',
  'feishu_fetch_doc',
  'feishu_get_user',
  'feishu_im_bot_image',
  'feishu_im_user_fetch_resource',
  'feishu_im_user_get_messages',
  'feishu_im_user_get_thread_messages',
  'feishu_im_user_message',
  'feishu_im_user_search_messages',
  'feishu_oauth',
  'feishu_oauth_batch_auth',
  'feishu_search_doc_wiki',
  'feishu_search_user',
  'feishu_sheet',
  'feishu_task_comment',
  'feishu_task_section',
  'feishu_task_subtask',
  'feishu_task_task',
  'feishu_task_tasklist',
  'feishu_update_doc',
  'feishu_wiki_space',
  'feishu_wiki_space_node',
];

const setupEntryContent = `"use strict";
// Lightweight setup entry for deferred loading (patched by LobsterAI).
// Only static channel metadata - no heavy dependencies.
// The full plugin (index.js) loads after the HTTP server starts listening.
const DEFAULT_ACCOUNT_ID = 'default';
function getFeishuSection(cfg) {
  return (cfg && cfg.channels && cfg.channels.feishu) || {};
}
function getAccountIds(cfg) {
  const section = getFeishuSection(cfg);
  const accounts = section.accounts && typeof section.accounts === 'object' ? section.accounts : undefined;
  const ids = accounts ? Object.keys(accounts) : [];
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  if (!ids.includes(DEFAULT_ACCOUNT_ID) && section.appId && section.appSecret) {
    return [DEFAULT_ACCOUNT_ID, ...ids];
  }
  return ids;
}
function baseConfig(section) {
  const copy = { ...section };
  delete copy.accounts;
  return copy;
}
function resolveAccount(cfg, accountId) {
  const requestedId = accountId || DEFAULT_ACCOUNT_ID;
  const section = getFeishuSection(cfg);
  const accountOverride = requestedId !== DEFAULT_ACCOUNT_ID && section.accounts
    ? section.accounts[requestedId]
    : undefined;
  const merged = { ...baseConfig(section), ...(accountOverride || {}) };
  const configured = Boolean(merged.appId && merged.appSecret);
  return {
    accountId: requestedId,
    enabled: Boolean(merged.enabled ?? configured),
    configured,
    name: merged.name,
    appId: merged.appId,
    appSecret: merged.appSecret,
    brand: merged.domain || 'feishu',
    config: merged,
  };
}
exports.plugin = {
  // id must match the plugin manifest id (openclaw-lark), NOT the channel id (feishu).
  // The loader checks: setupEntry.plugin.id === record.id (the manifest id).
  // The full plugin (index.js) registers the channel with id 'feishu' during deferred reload.
  id: 'openclaw-lark',
  meta: {
    id: 'feishu',
    label: 'Feishu',
    selectionLabel: 'Lark/Feishu (\\u98DE\\u4E66)',
    docsPath: '/channels/feishu',
    docsLabel: 'feishu',
    blurb: '\\u98DE\\u4E66/Lark enterprise messaging.',
    aliases: ['lark'],
    order: 70,
  },
  pairing: {
    idLabel: 'feishuUserId',
    normalizeAllowEntry: (entry) => entry.replace(/^(feishu|user|open_id):/i, ''),
  },
  capabilities: {
    chatTypes: ['direct', 'group'],
    media: true,
    reactions: true,
    threads: true,
    polls: false,
    nativeCommands: true,
    blockStreaming: true,
  },
  config: {
    listAccountIds: getAccountIds,
    resolveAccount,
    defaultAccountId: (cfg) => getAccountIds(cfg)[0],
    isConfigured: (account) => Boolean(account && account.configured),
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      appId: account.appId,
      brand: account.brand,
    }),
  },
  reload: { configPrefixes: ['channels.feishu'] },
};
`;

function patchDeferredStartup(larkPluginDir, log) {
  const larkPackageJsonPath = path.join(larkPluginDir, 'package.json');
  if (!fs.existsSync(larkPackageJsonPath)) {
    log('openclaw-lark not found, skipping deferred loading patch');
    return;
  }

  const currentPackageJson = fs.readFileSync(larkPackageJsonPath, 'utf-8');
  const larkPkg = readJsonFile(larkPackageJsonPath);
  if (!larkPkg?.openclaw) {
    log('openclaw-lark package has no openclaw section, skipping deferred loading patch');
    return;
  }

  const setupEntryPath = path.join(larkPluginDir, 'setup-entry.js');
  const currentSetupEntry = fs.existsSync(setupEntryPath)
    ? fs.readFileSync(setupEntryPath, 'utf-8')
    : '';
  if (currentSetupEntry !== setupEntryContent) {
    fs.writeFileSync(setupEntryPath, setupEntryContent, 'utf-8');
    log('Patched openclaw-lark/setup-entry.js: added lightweight config helpers');
  } else {
    log('openclaw-lark/setup-entry.js already has lightweight config helpers, skipping');
  }

  larkPkg.openclaw.setupEntry = './setup-entry.js';
  larkPkg.openclaw.startup = {
    deferConfiguredChannelFullLoadUntilAfterListen: true,
  };
  const nextPackageJson = `${JSON.stringify(larkPkg, null, 2)}\n`;
  if (currentPackageJson !== nextPackageJson) {
    fs.writeFileSync(larkPackageJsonPath, nextPackageJson, 'utf-8');
    log('Patched openclaw-lark/package.json: ensured setupEntry + deferred startup loading');
  } else {
    log('openclaw-lark/package.json already has setupEntry + deferred startup loading, skipping');
  }
}

function patchToolContracts(larkPluginDir, log) {
  const larkPluginManifestPath = path.join(larkPluginDir, 'openclaw.plugin.json');
  if (!fs.existsSync(larkPluginManifestPath)) {
    log('openclaw-lark/openclaw.plugin.json not found, skipping tool contract patch');
    return;
  }

  const larkManifest = readJsonFile(larkPluginManifestPath);
  if (!larkManifest) {
    log('openclaw-lark/openclaw.plugin.json could not be parsed, skipping tool contract patch');
    return;
  }

  const existingTools = Array.isArray(larkManifest.contracts?.tools)
    ? larkManifest.contracts.tools
    : [];
  const nextTools = Array.from(new Set([...existingTools, ...larkToolContracts])).sort();
  if (JSON.stringify(existingTools) !== JSON.stringify(nextTools)) {
    larkManifest.contracts = {
      ...(larkManifest.contracts || {}),
      tools: nextTools,
    };
    writeJsonFile(larkPluginManifestPath, larkManifest);
    log('Patched openclaw-lark/openclaw.plugin.json: declared Feishu tool contracts');
  } else {
    log('openclaw-lark/openclaw.plugin.json already declares Feishu tool contracts, skipping');
  }
}

function patchFilenameEncoding(larkPluginDir, log) {
  const larkMediaPath = path.join(larkPluginDir, 'src', 'messaging', 'outbound', 'media.js');
  if (!fs.existsSync(larkMediaPath)) {
    return;
  }

  let mediaSrc = fs.readFileSync(larkMediaPath, 'utf8');
  const patchMarker = 'fixLatin1GarbledUtf8';
  if (mediaSrc.includes(patchMarker)) {
    log('openclaw-lark/media.js already patched for filename encoding, skipping');
    return;
  }

  const target = 'fileName = decodeURIComponent(match[1].trim());';
  const idx = mediaSrc.indexOf(target);
  if (idx === -1) {
    log('openclaw-lark/media.js: fileName assignment pattern not found, skipping patch');
    return;
  }

  const replacement = `fileName = decodeURIComponent(match[1].trim());
                // Patched by LobsterAI: fix Latin-1 garbled UTF-8 filenames from Feishu API
                fileName = ${patchMarker}(fileName);`;
  mediaSrc = mediaSrc.slice(0, idx) + replacement + mediaSrc.slice(idx + target.length);

  const fnMarker = 'async function downloadMessageResourceFeishu(';
  const fnIdx = mediaSrc.indexOf(fnMarker);
  if (fnIdx !== -1) {
    const helperFn = `// Patched by LobsterAI: detect and fix Latin-1 garbled UTF-8 filenames.
// When Node.js parses HTTP headers as Latin-1, UTF-8 multibyte Chinese
// characters get split into individual high bytes (e.g. U+6700 encoded
// as 0xE6 0x9C 0x80 in UTF-8 becomes Latin-1 bytes).
function ${patchMarker}(name) {
    if (!name) return name;
    try {
        const buf = Buffer.from(name, 'latin1');
        const decoded = buf.toString('utf-8');
        // If re-decoding produces fewer chars and no replacement chars, it was garbled UTF-8
        if (decoded.length < name.length && !decoded.includes('\\ufffd')) {
            return decoded;
        }
    } catch {}
    return name;
}
`;
    mediaSrc = mediaSrc.slice(0, fnIdx) + helperFn + mediaSrc.slice(fnIdx);
  }

  fs.writeFileSync(larkMediaPath, mediaSrc);
  log('Patched openclaw-lark/media.js: fix Content-Disposition filename encoding for Chinese');
}

function patchLark({ runtimeExtensionsDir, log }) {
  const larkPluginDir = path.join(runtimeExtensionsDir, 'openclaw-lark');
  patchDeferredStartup(larkPluginDir, log);
  patchToolContracts(larkPluginDir, log);
  patchFilenameEncoding(larkPluginDir, log);
}

module.exports = {
  patchLark,
};
