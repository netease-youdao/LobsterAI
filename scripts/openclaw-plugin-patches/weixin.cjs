'use strict';

const fs = require('fs');
const path = require('path');

const { readJsonFile, writeJsonFile } = require('./common.cjs');

const WEIXIN_PLUGIN_VERSION = '2.4.3';
const WEIXIN_LAZY_OUTBOUND_HOOKS_MARKER = 'lobster_weixin_lazy_outbound_hooks';
const WEIXIN_LAZY_INBOUND_SDK_MARKER = 'lobster_weixin_lazy_inbound_sdk';

function assertWeixinPluginVersion(pluginDir) {
  if (!fs.existsSync(pluginDir)) {
    return false;
  }

  const packageJson = readJsonFile(path.join(pluginDir, 'package.json'));
  if (packageJson?.version !== WEIXIN_PLUGIN_VERSION) {
    throw new Error(
      `openclaw-weixin startup patch expects ${WEIXIN_PLUGIN_VERSION}, found ${packageJson?.version ?? 'unknown'}`,
    );
  }
  return true;
}

function patchWeixinNarrowSdkImports(filePath, label, log) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const original = fs.readFileSync(filePath, 'utf8');
  let src = original.replace(
    /import \{([^}]*)\} from "openclaw\/plugin-sdk\/infra-runtime";/g,
    (statement, importedNames) => {
      const hasFileLock = importedNames.includes('withFileLock');
      const hasTempPath = importedNames.includes('resolvePreferredOpenClawTmpDir');
      if (hasFileLock === hasTempPath) {
        return statement;
      }
      return statement.replace(
        'openclaw/plugin-sdk/infra-runtime',
        hasFileLock ? 'openclaw/plugin-sdk/file-lock' : 'openclaw/plugin-sdk/temp-path',
      );
    },
  );
  src = src.replaceAll(
    'openclaw/plugin-sdk/channel-runtime',
    'openclaw/plugin-sdk/channel-reply-pipeline',
  );

  if (src !== original) {
    fs.writeFileSync(filePath, src);
    log(`Patched ${label}: replaced broad OpenClaw SDK imports with narrow entry points`);
  }
}

function buildLazyOutboundHooksHelpers(relativeImport, isTypeScript) {
  const applyParams = isTypeScript
    ? `params: {\n  to: string;\n  text: string;\n  accountId?: string;\n  mediaUrl?: string;\n}`
    : 'params';
  const emitParams = isTypeScript
    ? `params: {\n  to: string;\n  content: string;\n  success: boolean;\n  error?: string;\n  accountId?: string;\n}`
    : 'params';
  const promiseDeclaration = isTypeScript
    ? `let weixinOutboundHooksPromise: Promise<typeof import("${relativeImport}")> | null = null;`
    : 'let weixinOutboundHooksPromise = null;';

  return `// ${WEIXIN_LAZY_OUTBOUND_HOOKS_MARKER}: hooks are not needed for registration or QR login.\n${promiseDeclaration}\nfunction loadWeixinOutboundHooks() {\n  weixinOutboundHooksPromise ??= import("${relativeImport}");\n  return weixinOutboundHooksPromise;\n}\n\nasync function applyWeixinMessageSendingHook(${applyParams}) {\n  try {\n    const hooks = await loadWeixinOutboundHooks();\n    return hooks.applyWeixinMessageSendingHook(params);\n  } catch (error) {\n    logger.warn(\`message_sending hook load error, proceeding with send: \${String(error)}\`);\n    return { cancelled: false, text: params.text };\n  }\n}\n\nfunction emitWeixinMessageSent(${emitParams}) {\n  void loadWeixinOutboundHooks()\n    .then((hooks) => hooks.emitWeixinMessageSent(params))\n    .catch((error) => logger.warn(\`message_sent hook load error: \${String(error)}\`));\n}\n\n`;
}

function patchWeixinLazyOutboundHooks(filePath, label, relativeImport, insertionMarker, log) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  let src = fs.readFileSync(filePath, 'utf8');
  if (src.includes(WEIXIN_LAZY_OUTBOUND_HOOKS_MARKER)) {
    log(`${label} outbound hooks already load lazily, skipping patch`);
    return;
  }

  const staticImport = new RegExp(
    `import \\{\\s*applyWeixinMessageSendingHook,\\s*emitWeixinMessageSent[,]?\\s*\\} from "${relativeImport.replaceAll('.', '\\.')}";\\r?\\n`,
  );
  if (!staticImport.test(src)) {
    throw new Error(`${label}: expected outbound hooks import was not found`);
  }
  src = src.replace(staticImport, '');
  src = src.replace(
    /\/\/ Lazy-imported inside startAccount to avoid pulling in the monitor -> process-message ->\r?\n\/\/ command-auth chain during plugin registration, which can re-enter plugin\/provider registry\r?\n\/\/ resolution before the account actually starts\.\r?\n/,
    '',
  );

  const markerIndex = src.indexOf(insertionMarker);
  if (markerIndex === -1) {
    throw new Error(`${label}: lazy outbound hooks insertion marker was not found`);
  }
  const helpers = buildLazyOutboundHooksHelpers(relativeImport, filePath.endsWith('.ts'));
  src = src.slice(0, markerIndex) + helpers + src.slice(markerIndex);
  fs.writeFileSync(filePath, src);
  log(`Patched ${label}: deferred outbound hook runtime until the first send`);
}

function patchWeixinLazyInboundSdk(processMessagePath, label, log) {
  if (!fs.existsSync(processMessagePath)) {
    return;
  }

  let src = fs.readFileSync(processMessagePath, 'utf8');
  if (src.includes(WEIXIN_LAZY_INBOUND_SDK_MARKER)) {
    log(`${label} inbound SDK already loads lazily, skipping patch`);
    return;
  }

  const typingImport = /import \{ createTypingCallbacks \} from "openclaw\/plugin-sdk\/channel-reply-pipeline";\r?\n/;
  const commandAuthImport = /import \{\s*resolveSenderCommandAuthorizationWithRuntime,\s*resolveDirectDmAuthorizationOutcome,?\s*\} from "openclaw\/plugin-sdk\/command-auth";\r?\n/;
  if (!typingImport.test(src) || !commandAuthImport.test(src)) {
    throw new Error(`${label}: expected eager inbound SDK imports were not found`);
  }
  src = src.replace(typingImport, '').replace(commandAuthImport, '');

  const authorizationCall = /^(\s*)const \{ senderAllowedForCommands, commandAuthorized \} =/m;
  if (!authorizationCall.test(src)) {
    throw new Error(`${label}: command authorization call was not found`);
  }
  src = src.replace(
    authorizationCall,
    `$1// ${WEIXIN_LAZY_INBOUND_SDK_MARKER}: load command processing only for an inbound message.\n$1const {\n$1  resolveSenderCommandAuthorizationWithRuntime,\n$1  resolveDirectDmAuthorizationOutcome,\n$1} = await import("openclaw/plugin-sdk/command-auth");\n$1const { senderAllowedForCommands, commandAuthorized } =`,
  );

  const typingCall = /^(\s*)const typingCallbacks = createTypingCallbacks\(/m;
  if (!typingCall.test(src)) {
    throw new Error(`${label}: typing callback call was not found`);
  }
  src = src.replace(
    typingCall,
    '$1const { createTypingCallbacks } = await import("openclaw/plugin-sdk/channel-reply-pipeline");\n$1const typingCallbacks = createTypingCallbacks(',
  );

  fs.writeFileSync(processMessagePath, src);
  log(`Patched ${label}: deferred command and typing SDK imports until the first inbound message`);
}

function patchWeixinGatewayMethods(channelPath, label, log) {
  if (!fs.existsSync(channelPath)) {
    return;
  }

  let src = fs.readFileSync(channelPath, 'utf8');
  if (!src.includes('gatewayMethods')) {
    const marker = 'configSchema: {';
    const idx = src.indexOf(marker);
    if (idx !== -1) {
      src = src.slice(0, idx) + 'gatewayMethods: ["web.login.start", "web.login.wait"],\n  ' + src.slice(idx);
      fs.writeFileSync(channelPath, src);
      log(`Patched ${label}: added gatewayMethods declaration`);
    }
  } else {
    log(`${label} already has gatewayMethods, skipping patch`);
  }
}

function patchWeixinStartupActivation(weixinManifestPath, log) {
  if (!fs.existsSync(weixinManifestPath)) {
    return;
  }

  const manifest = readJsonFile(weixinManifestPath);
  if (!manifest) {
    log('openclaw-weixin/openclaw.plugin.json could not be parsed, skipping startup activation patch');
    return;
  }

  if (manifest?.activation?.onStartup !== true) {
    manifest.activation = {
      ...(manifest.activation && typeof manifest.activation === 'object' ? manifest.activation : {}),
      onStartup: true,
    };
    writeJsonFile(weixinManifestPath, manifest);
    log('Patched openclaw-weixin/openclaw.plugin.json: enabled startup activation for QR login discovery');
  } else {
    log('openclaw-weixin/openclaw.plugin.json already has startup activation, skipping patch');
  }
}

function patchWeixinDmPolicy(processMsgPath, label, log) {
  if (!fs.existsSync(processMsgPath)) {
    return;
  }

  let pmSrc = fs.readFileSync(processMsgPath, 'utf8');
  const dmPolicyPatchMarker = 'chanCfg_dmPolicy_patch';
  if (!pmSrc.includes(dmPolicyPatchMarker)) {
    const oldAllowFrom = 'configuredAllowFrom: [],';
    const oldDmPolicy = 'dmPolicy: "pairing",';
    const patchedDmPolicy = `dmPolicy: (() => { /* ${dmPolicyPatchMarker} */ const _cc = (deps.config.channels)?.['openclaw-weixin'] ?? {}; return _cc.dmPolicy || 'pairing'; })(),`;
    if (pmSrc.includes(oldDmPolicy) && pmSrc.includes(oldAllowFrom)) {
      pmSrc = pmSrc.replaceAll(oldDmPolicy, patchedDmPolicy);
      pmSrc = pmSrc.replace(
        oldAllowFrom,
        `configuredAllowFrom: (() => { const _cc = (deps.config.channels)?.['openclaw-weixin'] ?? {}; return Array.isArray(_cc.allowFrom) ? _cc.allowFrom.map(String) : []; })(),`
      );
      fs.writeFileSync(processMsgPath, pmSrc);
      log(`Patched ${label}: dmPolicy/allowFrom now read from config`);
    }
  } else {
    log(`${label} dmPolicy patch already applied, skipping`);
  }
}

function patchWeixinAllowFromWildcard(processMsgPath, label, log) {
  if (!fs.existsSync(processMsgPath)) {
    return;
  }

  let pmSrc = fs.readFileSync(processMsgPath, 'utf8');
  const wildcardNeedle = "list.includes('*')";
  if (pmSrc.includes(wildcardNeedle)) {
    log(`${label} allowFrom wildcard patch already applied, skipping`);
    return;
  }

  const replacements = [
    {
      from: 'isSenderAllowed: (id: string, list: string[]) => list.length === 0 || list.includes(id),',
      to: "isSenderAllowed: (id: string, list: string[]) => list.length === 0 || list.includes('*') || list.includes(id),",
    },
    {
      from: 'isSenderAllowed: (id, list) => list.length === 0 || list.includes(id),',
      to: "isSenderAllowed: (id, list) => list.length === 0 || list.includes('*') || list.includes(id),",
    },
  ];

  let patched = false;
  for (const { from, to } of replacements) {
    if (pmSrc.includes(from)) {
      pmSrc = pmSrc.replaceAll(from, to);
      patched = true;
    }
  }

  if (patched) {
    fs.writeFileSync(processMsgPath, pmSrc);
    log(`Patched ${label}: allowFrom now honors wildcard entries`);
  }
}

function patchWeixin({ runtimeExtensionsDir, log }) {
  const pluginDir = path.join(runtimeExtensionsDir, 'openclaw-weixin');
  if (!assertWeixinPluginVersion(pluginDir)) {
    return;
  }

  const sdkImportFiles = [
    path.join(pluginDir, 'index.js'),
    path.join(pluginDir, 'src', 'channel.ts'),
    path.join(pluginDir, 'dist', 'src', 'channel.js'),
    path.join(pluginDir, 'src', 'auth', 'pairing.ts'),
    path.join(pluginDir, 'dist', 'src', 'auth', 'pairing.js'),
    path.join(pluginDir, 'src', 'util', 'logger.ts'),
    path.join(pluginDir, 'dist', 'src', 'util', 'logger.js'),
    path.join(pluginDir, 'src', 'messaging', 'process-message.ts'),
    path.join(pluginDir, 'dist', 'src', 'messaging', 'process-message.js'),
  ];
  for (const filePath of sdkImportFiles) {
    patchWeixinNarrowSdkImports(
      filePath,
      `openclaw-weixin/${path.relative(pluginDir, filePath).replaceAll('\\', '/')}`,
      log,
    );
  }

  patchWeixinLazyOutboundHooks(
    path.join(pluginDir, 'src', 'channel.ts'),
    'openclaw-weixin/src/channel.ts',
    './messaging/outbound-hooks.js',
    '/** Returns true when mediaUrl refers to a local filesystem path (absolute or relative). */',
    log,
  );
  patchWeixinLazyOutboundHooks(
    path.join(pluginDir, 'dist', 'src', 'channel.js'),
    'openclaw-weixin/dist/src/channel.js',
    './messaging/outbound-hooks.js',
    '/** Returns true when mediaUrl refers to a local filesystem path (absolute or relative). */',
    log,
  );
  patchWeixinLazyOutboundHooks(
    path.join(pluginDir, 'src', 'messaging', 'process-message.ts'),
    'openclaw-weixin/src/messaging/process-message.ts',
    './outbound-hooks.js',
    'const MEDIA_OUTBOUND_TEMP_DIR',
    log,
  );
  patchWeixinLazyOutboundHooks(
    path.join(pluginDir, 'dist', 'src', 'messaging', 'process-message.js'),
    'openclaw-weixin/dist/src/messaging/process-message.js',
    './outbound-hooks.js',
    'const MEDIA_OUTBOUND_TEMP_DIR',
    log,
  );

  patchWeixinLazyInboundSdk(
    path.join(pluginDir, 'src', 'messaging', 'process-message.ts'),
    'openclaw-weixin/src/messaging/process-message.ts',
    log,
  );
  patchWeixinLazyInboundSdk(
    path.join(pluginDir, 'dist', 'src', 'messaging', 'process-message.js'),
    'openclaw-weixin/dist/src/messaging/process-message.js',
    log,
  );

  patchWeixinGatewayMethods(
    path.join(pluginDir, 'src', 'channel.ts'),
    'openclaw-weixin/src/channel.ts',
    log
  );
  patchWeixinGatewayMethods(
    path.join(pluginDir, 'dist', 'src', 'channel.js'),
    'openclaw-weixin/dist/src/channel.js',
    log
  );

  patchWeixinStartupActivation(
    path.join(pluginDir, 'openclaw.plugin.json'),
    log
  );

  patchWeixinDmPolicy(
    path.join(pluginDir, 'src', 'messaging', 'process-message.ts'),
    'openclaw-weixin/src/messaging/process-message.ts',
    log
  );
  patchWeixinAllowFromWildcard(
    path.join(pluginDir, 'src', 'messaging', 'process-message.ts'),
    'openclaw-weixin/src/messaging/process-message.ts',
    log
  );
  patchWeixinDmPolicy(
    path.join(pluginDir, 'dist', 'src', 'messaging', 'process-message.js'),
    'openclaw-weixin/dist/src/messaging/process-message.js',
    log
  );
  patchWeixinAllowFromWildcard(
    path.join(pluginDir, 'dist', 'src', 'messaging', 'process-message.js'),
    'openclaw-weixin/dist/src/messaging/process-message.js',
    log
  );
}

module.exports = {
  assertWeixinPluginVersion,
  patchWeixin,
  patchWeixinLazyInboundSdk,
  patchWeixinLazyOutboundHooks,
  patchWeixinNarrowSdkImports,
};
