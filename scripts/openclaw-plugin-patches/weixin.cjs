'use strict';

const fs = require('fs');
const path = require('path');

const { readJsonFile, writeJsonFile } = require('./common.cjs');

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
  patchWeixinGatewayMethods(
    path.join(runtimeExtensionsDir, 'openclaw-weixin', 'src', 'channel.ts'),
    'openclaw-weixin/src/channel.ts',
    log
  );
  patchWeixinGatewayMethods(
    path.join(runtimeExtensionsDir, 'openclaw-weixin', 'dist', 'src', 'channel.js'),
    'openclaw-weixin/dist/src/channel.js',
    log
  );

  patchWeixinStartupActivation(
    path.join(runtimeExtensionsDir, 'openclaw-weixin', 'openclaw.plugin.json'),
    log
  );

  patchWeixinDmPolicy(
    path.join(runtimeExtensionsDir, 'openclaw-weixin', 'src', 'messaging', 'process-message.ts'),
    'openclaw-weixin/src/messaging/process-message.ts',
    log
  );
  patchWeixinAllowFromWildcard(
    path.join(runtimeExtensionsDir, 'openclaw-weixin', 'src', 'messaging', 'process-message.ts'),
    'openclaw-weixin/src/messaging/process-message.ts',
    log
  );
  patchWeixinDmPolicy(
    path.join(runtimeExtensionsDir, 'openclaw-weixin', 'dist', 'src', 'messaging', 'process-message.js'),
    'openclaw-weixin/dist/src/messaging/process-message.js',
    log
  );
  patchWeixinAllowFromWildcard(
    path.join(runtimeExtensionsDir, 'openclaw-weixin', 'dist', 'src', 'messaging', 'process-message.js'),
    'openclaw-weixin/dist/src/messaging/process-message.js',
    log
  );
}

module.exports = {
  patchWeixin,
};
