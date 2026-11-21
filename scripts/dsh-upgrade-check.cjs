#!/usr/bin/env node
/**
 * Evergreen DSH upgrade & privacy verification gate (`npm run dsh:upgrade-check`).
 *
 * Verifies against `vendor/dsh-runtime/current` + `dsh-bundles/lobsterai-host`:
 * 1. Pruned heavy native binaries remain absent while 0.2.2-rc.5+ ecosystem
 *    packages are present.
 * 2. `--dump-config` confirms every DeepSeek telemetry/account row + pruned
 *    office-kit + web-deepseek-api is `disabled: true`, and all 5 LobsterAI
 *    Cordis plugins are mounted.
 * 3. Live boot of the isolated App-Owned Profile succeeds, authenticates via
 *    `/connect?token=...&interactions=answer`, passes `/api/lobsterai/ops`
 *    health/syncProviders/syncSkillsPolicy/bindSessionContext/syncHostTools,
 *    and exposes synced models through Typert `session.modelCatalog`.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, 'vendor', 'dsh-runtime', 'current');
const DSH_BIN = path.join(RUNTIME_DIR, 'lib', 'bin.js');
const HOST_BUNDLE_DIR = path.join(ROOT, 'dsh-bundles', 'lobsterai-host');
const CHANNELS_BUNDLE_DIR = path.join(ROOT, 'dsh-bundles', 'lobsterai-channels');

const REQUIRED_DISABLED_IDS = [
  'session-log-deepseek',
  'plugin-package-inventory-deepseek',
  'session-telemetry-otel',
  'deepseek-account',
  'llm-deepseek-account',
  'desktop-product-telemetry',
  'product-analytics',
  'office-kit',
  'skill-office',
  'harness-dev-context',
  'deliverable-file-references',
  'schedule',
  'mcp-resources',
  'web-deepseek-api',
];

const REQUIRED_LOBSTER_PLUGIN_IDS = [
  'lobster-model-bridge',
  'lobster-persona-scope',
  'lobster-host-tools',
  'lobster-tool-disclosure',
  'lobster-agent-delegation',
  'lobster-approval-guard',
  'lobster-ops-rpc',
];

const REQUIRED_ECOSYSTEM_PACKAGES = [
  '@deepseek-ai/dsh-agent-team',
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-deepseek-chat-import',
  '@deepseek-ai/dsh-experimental-liveshare',
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-mcp-manager',
];

const FORBIDDEN_HEAVY_PREFIXES = [
  path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai', 'libreoffice-kit-'),
  path.join(RUNTIME_DIR, 'node_modules', 'sherpa-onnx-'),
];

function fail(message) {
  console.error(`[dsh-upgrade-check] FAIL: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[dsh-upgrade-check] ${message}`);
}

function checkRuntimePackages() {
  if (!fs.existsSync(DSH_BIN)) {
    fail(`DSH runtime binary not found at ${DSH_BIN}. Run scripts/build-dsh-runtime.cjs first.`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'package.json'), 'utf8'));
  log(`Runtime version: ${pkg.version}`);

  for (const dep of REQUIRED_ECOSYSTEM_PACKAGES) {
    const depPkg = path.join(RUNTIME_DIR, 'node_modules', ...dep.split('/'), 'package.json');
    if (!fs.existsSync(depPkg)) {
      fail(`Expected DSH ecosystem package missing: ${dep}`);
    }
  }

  const deepseekDir = path.join(RUNTIME_DIR, 'node_modules', '@deepseek-ai');
  const rootNm = path.join(RUNTIME_DIR, 'node_modules');
  for (const name of fs.readdirSync(deepseekDir)) {
    const full = path.join(deepseekDir, name);
    if (FORBIDDEN_HEAVY_PREFIXES.some((prefix) => full.startsWith(prefix))) {
      fail(`Heavy pruned package unexpectedly present: ${full}`);
    }
  }
  for (const name of fs.readdirSync(rootNm)) {
    const full = path.join(rootNm, name);
    if (FORBIDDEN_HEAVY_PREFIXES.some((prefix) => full.startsWith(prefix))) {
      fail(`Heavy pruned package unexpectedly present: ${full}`);
    }
  }
  log('Runtime package inventory & pruning checks passed.');
}

function createTempProfile() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-check-'));
  const dshHome = path.join(tempRoot, 'dsh-profile');
  const profileDir = path.join(dshHome, 'profiles', 'lobsterai');
  const workspacesDir = path.join(tempRoot, 'workspaces');
  const skillsDir = path.join(tempRoot, 'skills');

  fs.mkdirSync(path.join(profileDir, 'node_modules', '@lobsterai'), { recursive: true });
  fs.mkdirSync(path.join(workspacesDir, 'main'), { recursive: true });
  fs.mkdirSync(path.join(skillsDir, 'hello-lobster'), { recursive: true });

  // Write test persona containing literal {{cwd}} to verify interpolate: false.
  fs.writeFileSync(
    path.join(workspacesDir, 'main', 'SOUL.md'),
    'You are LobsterAI.\nLiteral braces test: {{cwd}} and {{unknown_var}}.\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(skillsDir, 'hello-lobster', 'SKILL.md'),
    '---\nname: hello-lobster\ndescription: Smoke test skill\n---\nAlways say hi.\n',
    'utf8',
  );

  const manifest = {
    name: 'lobsterai-dsh-profile',
    private: true,
    type: 'module',
    dependencies: {
      '@lobsterai/dsh-bundle': `file:${HOST_BUNDLE_DIR.replace(/\\/g, '/')}`,
      '@lobsterai/dsh-channels': `file:${CHANNELS_BUNDLE_DIR.replace(/\\/g, '/')}`,
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@lobsterai/dsh-bundle',
          '@lobsterai/dsh-channels',
        ],
      },
    },
  };
  fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8');
  fs.symlinkSync(
    HOST_BUNDLE_DIR,
    path.join(profileDir, 'node_modules', '@lobsterai', 'dsh-bundle'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  fs.symlinkSync(
    CHANNELS_BUNDLE_DIR,
    path.join(profileDir, 'node_modules', '@lobsterai', 'dsh-channels'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  return { tempRoot, dshHome, profileDir, workspacesDir, skillsDir };
}

function checkDumpConfig(env) {
  log('Running dsh --profile lobsterai --dump-config ...');
  const res = spawnSync(
    process.execPath,
    ['--expose-internals', DSH_BIN, '--profile', 'lobsterai', '--dump-config'],
    {
      env,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  if (res.status !== 0) {
    fail(`--dump-config exited with code ${res.status}:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
  }
  const yaml = require(path.join(RUNTIME_DIR, 'node_modules', 'js-yaml'));
  const jsTagType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: (data) => ({ __jsExpr: String(data) }),
  });
  const dshYamlSchema = yaml.DEFAULT_SCHEMA.extend([jsTagType]);
  // Strip any non-YAML diagnostic prefix lines before the top-level YAML list.
  const lines = res.stdout.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => line.startsWith('- ') || line.trim() === '[]');
  if (startIdx < 0) {
    fail(`--dump-config produced unexpected output:\n${res.stdout}`);
  }
  const parsed = yaml.load(lines.slice(startIdx).join('\n'), { schema: dshYamlSchema });
  if (!Array.isArray(parsed)) {
    fail('--dump-config output did not parse to a YAML array');
  }

  const byId = new Map();
  const walk = (entries) => {
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.id === 'string') byId.set(entry.id, entry);
      if (Array.isArray(entry.config)) walk(entry.config);
    }
  };
  walk(parsed);

  for (const id of REQUIRED_DISABLED_IDS) {
    const row = byId.get(id);
    if (!row) {
      fail(`Expected row "${id}" missing from --dump-config (upstream row renamed or removed — update cordis.patch.yml!)`);
    }
    if (row.disabled !== true) {
      fail(`Privacy/pruning gate violation: row "${id}" has disabled=${JSON.stringify(row.disabled)} (expected true)`);
    }
  }

  for (const id of REQUIRED_LOBSTER_PLUGIN_IDS) {
    const row = byId.get(id);
    if (!row) {
      fail(`Expected LobsterAI plugin row "${id}" missing from --dump-config`);
    }
    if (row.disabled === true) {
      fail(`LobsterAI plugin row "${id}" is unexpectedly disabled`);
    }
  }

  const sysPrompt = byId.get('system-prompt');
  if (!sysPrompt || sysPrompt.config?.includeHarnessIdentity !== false) {
    fail('Expected system-prompt.config.includeHarnessIdentity === false');
  }

  const presetRegistry = byId.get('agent-preset-registry');
  if (!presetRegistry || presetRegistry.config?.default !== 'lobsterai') {
    fail(`Expected agent-preset-registry.config.default === "lobsterai", got ${JSON.stringify(presetRegistry?.config)}`);
  }

  const lobsterPreset = byId.get('preset-lobsterai');
  if (!lobsterPreset || lobsterPreset.disabled === true) {
    fail('Expected preset-lobsterai row to be present and enabled');
  }

  log(`--dump-config gate passed (${REQUIRED_DISABLED_IDS.length} disabled rows verified, ${REQUIRED_LOBSTER_PLUGIN_IDS.length} LobsterAI plugins verified, default preset=lobsterai).`);
}

function httpRequest(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function checkLiveBoot(env) {
  log('Booting live DSH App-Owned Profile on 127.0.0.1:0 ...');
  const child = spawn(
    process.execPath,
    ['--expose-internals', DSH_BIN, '--profile', 'lobsterai', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  let authUrl = '';

  const readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for DSH boot URL.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, 30_000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      const match = stdout.match(/dsh web:\s*(https?:\/\/\S+)/);
      if (match) {
        authUrl = match[1];
        clearTimeout(timeout);
        resolve(authUrl);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('exit', (code, signal) => {
      if (!authUrl) {
        clearTimeout(timeout);
        reject(new Error(`DSH exited before ready (code=${code}, signal=${signal}).\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
      }
    });
  });

  try {
    const launchUrl = new URL(await readyPromise);
    const origin = launchUrl.origin;
    const token = launchUrl.searchParams.get('token');
    if (!token) {
      throw new Error(`Launch URL missing token parameter: ${launchUrl.href}`);
    }
    log(`DSH booted at ${origin}`);

    // 1. Exchange launch token for authenticated API session cookie.
    const connectRes = await httpRequest(
      `${origin}/connect?token=${encodeURIComponent(token)}&interactions=answer`,
      { method: 'GET' },
    );
    const setCookies = connectRes.headers['set-cookie'];
    if (connectRes.status < 200 || connectRes.status >= 400 || !setCookies || setCookies.length === 0) {
      throw new Error(`/connect failed: status=${connectRes.status}, body=${connectRes.body}`);
    }
    const cookieHeader = setCookies.map((c) => c.split(';')[0]).join('; ');
    log('Authenticated via /connect.');

    const callOps = async (action, payload) => {
      const res = await httpRequest(`${origin}/api/lobsterai/ops`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader,
        },
        body: JSON.stringify({ action, payload }),
      });
      if (res.status !== 200) {
        throw new Error(
          `/api/lobsterai/ops (${action}) returned HTTP ${res.status}: ${res.body}\n--- DSH STDOUT ---\n${stdout}\n--- DSH STDERR ---\n${stderr}`,
        );
      }
      return JSON.parse(res.body);
    };

    // 2. Verify unauthenticated call to /api/lobsterai/ops is rejected (401).
    const unauthRes = await httpRequest(`${origin}/api/lobsterai/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'health' }),
    });
    if (unauthRes.status !== 401) {
      throw new Error(`Expected 401 for unauthenticated /api/lobsterai/ops, got ${unauthRes.status}`);
    }

    // 3. Verify health reports all 7 LobsterAI plugins ready.
    const health = await callOps('health');
    if (!health.ok) throw new Error(`health returned ok=false: ${JSON.stringify(health)}`);
    for (const key of ['modelBridge', 'personaScope', 'hostTools', 'toolDisclosure', 'agentDelegation', 'approvalGuard', 'opsRpc']) {
      if (health.pluginsReady?.[key] !== true) {
        throw new Error(`Plugin "${key}" not ready: ${JSON.stringify(health.pluginsReady)}`);
      }
    }
    log('All 7 LobsterAI Cordis plugins reported ready.');

    // 4. Verify syncProviders hot-registers provider and exposes it via Typert session.modelCatalog.
    const syncProv = await callOps('syncProviders', {
      providers: [
        {
          id: 'lobster-smoke',
          displayName: 'Lobster Smoke',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:1/v1',
          apiKey: 'smoke-test-key',
          models: [
            {
              id: 'lobster-smoke-model',
              name: 'Lobster Smoke Model',
              contextWindow: 128000,
              maxTokens: 4096,
              input: ['text', 'image'],
            },
          ],
        },
      ],
    });
    if (!syncProv.result?.registeredRoutes?.includes('lobster-smoke')) {
      throw new Error(`syncProviders failed: ${JSON.stringify(syncProv)}`);
    }

    const catalogRes = await httpRequest(`${origin}/api/session/modelCatalog`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'session/modelCatalog',
        payload: { args: {} },
      }),
    });
    if (catalogRes.status !== 200) {
      throw new Error(`session.modelCatalog returned HTTP ${catalogRes.status}: ${catalogRes.body}`);
    }
    const catalogJson = JSON.parse(catalogRes.body);
    const groups = catalogJson?.result?.value?.groups || [];
    const smokeGroup = groups.find((g) => g.id === 'lobster-smoke');
    if (!smokeGroup || !smokeGroup.models?.some((m) => m.id === 'lobster-smoke-model')) {
      throw new Error(`Synced model not visible in session.modelCatalog: ${catalogRes.body}`);
    }
    log('syncProviders + Typert session.modelCatalog verified.');

    // 5. Verify bindSessionContext, syncSkillsPolicy, syncHostTools.
    await callOps('bindSessionContext', {
      sessionId: 'smoke-session-1',
      agentId: 'main',
      coworkSessionId: 'cw-smoke-1',
    });
    await callOps('syncSkillsPolicy', {
      disabledIds: [],
    });
    const toolsRes = await callOps('syncHostTools', {
      tools: [
        {
          name: 'lobster_smoke_tool',
          description: 'Smoke test dynamic host tool',
          inputSchema: {
            type: 'object',
            properties: {
              ping: { type: 'string', description: 'Ping text' },
            },
            required: ['ping'],
          },
        },
      ],
    });
    if (!toolsRes.result?.dynamicTools?.includes('lobster_smoke_tool')) {
      throw new Error(`syncHostTools failed: ${JSON.stringify(toolsRes)}`);
    }
    const agentsRes = await callOps('syncAgents', {
      agents: [
        {
          id: 'main',
          name: '主 Agent',
          description: '默认助手',
          enabled: true,
          allowedSkillIds: null,
          collaborationMode: 'all',
          allowAgentIds: [],
        },
        {
          id: 'blog-publisher',
          name: '博客自动发布',
          description: '发布 Markdown 到博客仓库',
          enabled: true,
          allowedSkillIds: ['hugo-publish'],
          collaborationMode: 'all',
          allowAgentIds: [],
        },
      ],
    });
    if (agentsRes.result?.agentsCount !== 2) {
      throw new Error(`syncAgents failed: ${JSON.stringify(agentsRes)}`);
    }
    const bindingsRes = await callOps('syncSubagentBindings', {
      replace: true,
      bindings: [
        {
          childSessionId: 'smoke-child-1',
          parentDshSessionId: 'smoke-session-1',
          rootCoworkSessionId: 'cw-smoke-1',
          targetAgentId: 'blog-publisher',
        },
      ],
    });
    if (bindingsRes.result?.syncedCount !== 1) {
      throw new Error(`syncSubagentBindings failed: ${JSON.stringify(bindingsRes)}`);
    }
    log('bindSessionContext + syncSkillsPolicy + syncHostTools + syncAgents + syncSubagentBindings verified.');

    // 6. Verify @lobsterai/dsh-channels exposes exactly the 7 retained platforms.
    const chRes = await httpRequest(`${origin}/api/lobsterai/channels`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader,
      },
      body: JSON.stringify({ action: 'listStatus' }),
    });
    if (chRes.status !== 200) {
      throw new Error(`/api/lobsterai/channels returned HTTP ${chRes.status}: ${chRes.body}`);
    }
    const chJson = JSON.parse(chRes.body);
    const platforms = chJson?.result?.supportedPlatforms || [];
    const expectedPlatforms = ['feishu', 'weixin', 'dingtalk', 'wecom', 'qq', 'telegram', 'discord'];
    if (JSON.stringify(platforms) !== JSON.stringify(expectedPlatforms)) {
      throw new Error(`Unexpected IM channels list: ${JSON.stringify(platforms)}`);
    }
    log('@lobsterai/dsh-channels verified (7 mainstream platforms active, retired platforms excluded).');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }
}

async function main() {
  checkRuntimePackages();
  const { tempRoot, dshHome, workspacesDir, skillsDir } = createTempProfile();
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    LOBSTERAI_WORKSPACES_DIR: workspacesDir,
    LOBSTERAI_SKILLS_DIR: skillsDir,
    LOBSTERAI_DSH_INSTANCE_ID: 'upgrade-check-smoke',
  };
  try {
    checkDumpConfig(env);
    await checkLiveBoot(env);
    log('ALL CHECKS PASSED.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.stack || error.message : String(error));
});
