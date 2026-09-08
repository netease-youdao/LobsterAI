'use strict';

const fs = require('fs');
const path = require('path');

function patchDingtalkSdkCompatibility(pluginDir, log) {
  // Jiti rewrites import.meta.url, but leaves bare/optional import.meta in
  // its CommonJS output. The published ESM entry always has a module URL.
  const loadPathExpression = 'typeof import.meta !== "undefined" && import.meta?.url ? String(import.meta.url) : "<unknown>"';
  const replacements = [
    [path.join(pluginDir, 'index.ts'), loadPathExpression, 'String(import.meta.url)'],
    [path.join(pluginDir, 'dist', 'index.mjs'), loadPathExpression, 'String(import.meta.url)'],
    // OpenClaw 2026.8.1 removed channel-runtime; channel-outbound exports
    // the reply-prefix, typing callbacks and typing-failure helpers we use.
    ...[
      path.join(pluginDir, 'src', 'reply-dispatcher.ts'),
      ...findDingtalkDistMessageHandlers(pluginDir),
    ].map(file => [file, '"openclaw/plugin-sdk/channel-runtime"', '"openclaw/plugin-sdk/channel-outbound"']),
  ];
  for (const [file, before, after] of replacements) {
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const patched = source.replaceAll(before, after);
    if (patched !== source) {
      fs.writeFileSync(file, patched);
      log(`Patched dingtalk-connector/${path.relative(pluginDir, file)}: OpenClaw SDK/module compatibility`);
    }
  }
}

function patchMessageHandler(dingtalkMsgHandlerPath, log) {
  if (!fs.existsSync(dingtalkMsgHandlerPath)) {
    log(`${path.basename(dingtalkMsgHandlerPath)} not found, skipping file:// URL patch`);
    return;
  }

  let dtSrc = fs.readFileSync(dingtalkMsgHandlerPath, 'utf8');
  const brokenPatterns = [
    "imageLocalPaths.map(p => `![image](file://${p})`)",
    'imageLocalPaths.map((p) => `![image](file://${p})`)',
  ];
  const replacement =
    "imageLocalPaths.map(p => { if (process.platform !== 'win32') return `![image](file://${p})`; const n = p.replace(/\\\\/g, '/'); return `![image](file:///${n})`; })";
  const appliedPattern = brokenPatterns.find(pattern => dtSrc.includes(pattern));
  if (appliedPattern) {
    dtSrc = dtSrc.replace(appliedPattern, replacement);
    fs.writeFileSync(dingtalkMsgHandlerPath, dtSrc);
    log(`Patched ${path.relative(process.cwd(), dingtalkMsgHandlerPath)}: fixed file:// URL format for Windows`);
  } else if (dtSrc.includes("file:///${n}")) {
    log(`${path.relative(process.cwd(), dingtalkMsgHandlerPath)} file:// URL patch already applied, skipping`);
  } else {
    log(`${path.relative(process.cwd(), dingtalkMsgHandlerPath)}: file:// pattern not found, skipping`);
  }

  const exactAccountPattern = 'if (match.accountId && match.accountId !== accountId) continue;';
  const wildcardAccountPattern = 'if (match.accountId && match.accountId !== "*" && match.accountId !== accountId) continue;';
  if (dtSrc.includes(exactAccountPattern)) {
    dtSrc = dtSrc.replaceAll(exactAccountPattern, wildcardAccountPattern);
    fs.writeFileSync(dingtalkMsgHandlerPath, dtSrc);
    log('Patched dingtalk-connector/message-handler.ts: accountId wildcard bindings now match all accounts');
  } else if (dtSrc.includes(wildcardAccountPattern)) {
    log('dingtalk-connector/message-handler.ts account wildcard patch already applied, skipping');
  } else {
    log('dingtalk-connector/message-handler.ts: account binding pattern not found, skipping wildcard patch');
  }
}

function findDingtalkDistMessageHandlers(pluginDir) {
  const distDir = path.join(pluginDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return [];
  }

  return fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^message-handler-.*\.mjs$/.test(entry.name))
    .map(entry => path.join(distDir, entry.name));
}

function findDingtalkDistRuntimeBundles(pluginDir) {
  const distDir = path.join(pluginDir, 'dist');
  if (!fs.existsSync(distDir)) {
    return [];
  }

  return fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^runtime-.*\.mjs$/.test(entry.name))
    .map(entry => path.join(distDir, entry.name));
}

function patchDingtalkOutboundErrorPropagation(channelPath, label, log) {
  if (!fs.existsSync(channelPath)) {
    return;
  }

  let src = fs.readFileSync(channelPath, 'utf8');
  const patchMarker = 'dingtalk_outbound_error_propagation_patch';
  if (src.includes(patchMarker)) {
    log(`${label} outbound error propagation patch already applied, skipping`);
    return;
  }

  const pattern = /(const result = await sendTextToDingTalk\(\{[\s\S]*?\n\s*\}\);\r?\n)([ \t]*)(?=return \{\r?\n[ \t]*channel: CHANNEL_ID,)/;
  if (!pattern.test(src)) {
    log(`${label}: sendText outbound pattern not found, skipping error propagation patch`);
    return;
  }

  src = src.replace(pattern, (_match, sendCall, indent) => (
    `${sendCall}${indent}if (!result.ok) {\n` +
    `${indent}  throw new Error(/* ${patchMarker} */ result.error || 'DingTalk outbound send failed');\n` +
    `${indent}}\n${indent}`
  ));
  fs.writeFileSync(channelPath, src);
  log(`Patched ${label}: outbound text sends now propagate DingTalk API failures`);
}

function patchDingtalkAgentWorkspaceResolver(resolverPath, label, log) {
  if (!fs.existsSync(resolverPath)) {
    return;
  }

  let src = fs.readFileSync(resolverPath, 'utf8');
  const workspacePatchMarker = 'dingtalk_agent_workspace_defaults_patch';
  if (src.includes(workspacePatchMarker)) {
    log(`${label} workspace resolver patch already applied, skipping`);
    return;
  }

  const replacementJs = `function resolveAgentWorkspaceDir(cfg, agentId) {
  const expandWorkspacePath = (workspace) => /* ${workspacePatchMarker} */ workspace.startsWith("~") ? path.join(os.homedir(), workspace.slice(1)) : workspace;
  const agentConfig = cfg.agents?.list?.find((a) => a.id === agentId);
  const configuredWorkspace = agentConfig?.workspace?.trim();
  if (configuredWorkspace) {
    return expandWorkspacePath(configuredWorkspace);
  }
  const defaultAgentId = cfg.defaultAgent || cfg.agents?.list?.find((a) => a?.default === true)?.id || "main";
  const fallbackWorkspace = cfg.agents?.defaults?.workspace?.trim();
  if (agentId === "main" || agentId === defaultAgentId) {
    if (fallbackWorkspace) {
      return expandWorkspacePath(fallbackWorkspace);
    }
    return path.join(os.homedir(), ".openclaw", "workspace");
  }
  if (fallbackWorkspace) {
    return path.join(expandWorkspacePath(fallbackWorkspace), agentId);
  }
  return path.join(os.homedir(), ".openclaw", \`workspace-\${agentId}\`);
}`;

  const replacementBundledMjs = `function resolveAgentWorkspaceDir(cfg, agentId) {
	const expandWorkspacePath = (workspace) => /* ${workspacePatchMarker} */ workspace.startsWith("~") ? path$1.join(os.homedir(), workspace.slice(1)) : workspace;
	const agentConfig = cfg.agents?.list?.find((a) => a.id === agentId);
	const configuredWorkspace = agentConfig?.workspace?.trim();
	if (configuredWorkspace) return expandWorkspacePath(configuredWorkspace);
	const defaultAgentId = cfg.defaultAgent || cfg.agents?.list?.find((a) => a?.default === true)?.id || "main";
	const fallbackWorkspace = cfg.agents?.defaults?.workspace?.trim();
	if (agentId === "main" || agentId === defaultAgentId) {
		if (fallbackWorkspace) return expandWorkspacePath(fallbackWorkspace);
		return path$1.join(os.homedir(), ".openclaw", "workspace");
	}
	if (fallbackWorkspace) return path$1.join(expandWorkspacePath(fallbackWorkspace), agentId);
	return path$1.join(os.homedir(), ".openclaw", \`workspace-\${agentId}\`);
}`;

  const replacementTs = `export function resolveAgentWorkspaceDir(
  cfg: ClawdbotConfig,
  agentId: string,
): string {
  const expandWorkspacePath = (workspace: string): string => (
    /* ${workspacePatchMarker} */ workspace.startsWith('~')
      ? path.join(os.homedir(), workspace.slice(1))
      : workspace
  );

  const agentConfig = cfg.agents?.list?.find((a: any) => a.id === agentId);
  const configuredWorkspace = agentConfig?.workspace?.trim();
  if (configuredWorkspace) {
    return expandWorkspacePath(configuredWorkspace);
  }

  const defaultAgentId =
    cfg.defaultAgent ||
    cfg.agents?.list?.find((a: any) => a?.default === true)?.id ||
    'main';
  const fallbackWorkspace = cfg.agents?.defaults?.workspace?.trim();

  if (agentId === 'main' || agentId === defaultAgentId) {
    if (fallbackWorkspace) {
      return expandWorkspacePath(fallbackWorkspace);
    }
    return path.join(os.homedir(), '.openclaw', 'workspace');
  }

  if (fallbackWorkspace) {
    return path.join(expandWorkspacePath(fallbackWorkspace), agentId);
  }

  return path.join(os.homedir(), '.openclaw', \`workspace-\${agentId}\`);
}`;

  if (label.endsWith('index.js')) {
    const pattern = /function resolveAgentWorkspaceDir\(cfg, agentId\) \{[\s\S]*?return path\.join\(os\.homedir\(\), "\.openclaw", `workspace-\$\{agentId\}`\);\r?\n\}/;
    if (pattern.test(src)) {
      src = src.replace(pattern, replacementJs);
      fs.writeFileSync(resolverPath, src);
      log(`Patched ${label}: agent workspace resolver now reads agents.defaults.workspace`);
    } else {
      log(`${label}: workspace resolver pattern not found, skipping patch`);
    }
    return;
  }

  if (label.endsWith('.mjs')) {
    const pattern = /function resolveAgentWorkspaceDir\(cfg, agentId\) \{[\s\S]*?return path\$1\.join\(os\.homedir\(\), "\.openclaw", `workspace-\$\{agentId\}`\);\r?\n\}/;
    if (pattern.test(src)) {
      src = src.replace(pattern, replacementBundledMjs);
      fs.writeFileSync(resolverPath, src);
      log(`Patched ${label}: agent workspace resolver now reads agents.defaults.workspace`);
    } else {
      log(`${label}: workspace resolver pattern not found, skipping patch`);
    }
    return;
  }

  const pattern = /export function resolveAgentWorkspaceDir\(\s*cfg: ClawdbotConfig,\s*agentId: string,\s*\): string \{[\s\S]*?return path\.join\(os\.homedir\(\), '\.openclaw', `workspace-\$\{agentId\}`\);\s*\}/;
  if (pattern.test(src)) {
    src = src.replace(pattern, replacementTs);
    fs.writeFileSync(resolverPath, src);
    log(`Patched ${label}: agent workspace resolver now reads agents.defaults.workspace`);
  } else {
    log(`${label}: workspace resolver pattern not found, skipping patch`);
  }
}

function patchDingtalk({ runtimeExtensionsDir, log }) {
  const pluginDir = path.join(runtimeExtensionsDir, 'dingtalk-connector');
  patchDingtalkSdkCompatibility(pluginDir, log);
  const messageHandlerPaths = [
    path.join(pluginDir, 'src', 'core', 'message-handler.ts'),
    ...findDingtalkDistMessageHandlers(pluginDir),
  ];
  for (const messageHandlerPath of messageHandlerPaths) {
    patchMessageHandler(messageHandlerPath, log);
  }

  patchDingtalkAgentWorkspaceResolver(
    path.join(pluginDir, 'index.js'),
    'dingtalk-connector/index.js',
    log
  );
  patchDingtalkAgentWorkspaceResolver(
    path.join(pluginDir, 'src', 'utils', 'agent.ts'),
    'dingtalk-connector/src/utils/agent.ts',
    log
  );
  for (const messageHandlerPath of findDingtalkDistMessageHandlers(pluginDir)) {
    patchDingtalkAgentWorkspaceResolver(
      messageHandlerPath,
      `dingtalk-connector/dist/${path.basename(messageHandlerPath)}`,
      log
    );
  }

  patchDingtalkOutboundErrorPropagation(
    path.join(pluginDir, 'src', 'channel.ts'),
    'dingtalk-connector/src/channel.ts',
    log
  );
  for (const runtimeBundlePath of findDingtalkDistRuntimeBundles(pluginDir)) {
    patchDingtalkOutboundErrorPropagation(
      runtimeBundlePath,
      `dingtalk-connector/dist/${path.basename(runtimeBundlePath)}`,
      log
    );
  }
}

module.exports = {
  findDingtalkDistMessageHandlers,
  findDingtalkDistRuntimeBundles,
  patchDingtalk,
};
