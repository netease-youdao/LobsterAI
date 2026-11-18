import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  OPENCLAW_USER_CONFIG_FILE_NAME,
  OPENCLAW_USER_CONFIG_STORE_KEY,
  OpenClawUserConfigState,
  OpenClawUserConfigSuspendReason,
} from '../../shared/openclawUserConfig/constants';
import { createOpenClawConfigTarget, rebaseOpenClawConfigTarget, resolveOpenClawOwnedSections } from './openclawConfigTarget';
import {
  applyOpenClawUserConfigPatch,
  collectOpenClawUserConfigLeaves,
  listOpenClawUserConfigPaths,
  OpenClawUserConfigFailureOutcome,
  OpenClawUserConfigOverlay,
  parseOpenClawUserConfig,
  revertOpenClawUserConfigLeaves,
  sanitizeOpenClawUserConfigPatch,
} from './openclawUserConfigOverlay';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const createMemoryStore = () => {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
  };
};

const createOverlay = (store = createMemoryStore()) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-user-config-'));
  directories.push(dir);
  const overlay = new OpenClawUserConfigOverlay({ getConfigDir: () => dir, getStore: () => store, now: () => 1000 });
  const writeUserConfig = (content: string) => {
    fs.writeFileSync(path.join(dir, OPENCLAW_USER_CONFIG_FILE_NAME), content, 'utf8');
  };
  return { dir, overlay, store, writeUserConfig };
};

/** Renders like the config sync does and returns what lands in openclaw.json. */
const render = (
  overlay: OpenClawUserConfigOverlay,
  fileConfig: Record<string, unknown>,
  generate: (base: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> => {
  const baseRaw = `${JSON.stringify(fileConfig, null, 2)}\n`;
  const session = overlay.begin(baseRaw);
  const generated = generate(JSON.parse(session.generationBaseRaw));
  const overlaid = session.apply(generated, resolveOpenClawOwnedSections(generated));
  const target = createOpenClawConfigTarget(baseRaw, JSON.stringify(overlaid.config), undefined, {
    mergeBaseRaw: session.generationBaseRaw,
    extraOwnedSections: overlaid.ownedTopLevelKeys,
  });
  return JSON.parse(rebaseOpenClawConfigTarget(target, baseRaw));
};

/** A stand-in renderer: owns `agents`, preserves gateway and plugin entries from the file. */
const generateManaged = (base: Record<string, unknown>) => {
  const gateway = (base.gateway ?? {}) as Record<string, unknown>;
  const plugins = (base.plugins ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(plugins.allow) ? plugins.allow as string[] : [];
  return {
    gateway: { ...gateway, mode: 'local', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' } },
    agents: { defaults: { model: 'lobster/main' } },
    plugins: {
      ...plugins,
      allow: [...new Set([...allow, 'memory-core'])].sort(),
      entries: { ...(plugins.entries as Record<string, unknown> | undefined), acpx: { enabled: false } },
    },
  };
};

describe('parseOpenClawUserConfig', () => {
  test('accepts JSON5 comments, trailing commas and a byte order mark', () => {
    expect(parseOpenClawUserConfig('\uFEFF// note\n{ agents: { defaults: { x: 1, }, }, }')).toEqual({
      ok: true,
      patch: { agents: { defaults: { x: 1 } } },
    });
    expect(parseOpenClawUserConfig('  \n')).toEqual({ ok: true, patch: {} });
  });

  test('rejects syntax errors and non-object roots', () => {
    const syntax = parseOpenClawUserConfig('{ agents: ');
    expect(syntax.ok).toBe(false);
    expect(parseOpenClawUserConfig('[1, 2]').ok).toBe(false);
  });
});

describe('sanitizeOpenClawUserConfigPatch', () => {
  test('drops LobsterAI-managed paths, includes and invalid list overrides', () => {
    const result = sanitizeOpenClawUserConfigPatch({
      meta: { lastTouchedVersion: 'x' },
      gateway: { auth: { mode: 'none' }, controlUi: { enabled: true } },
      agents: { defaults: { sessionStore: 'elsewhere', humanDelay: { mode: 'natural' } } },
      plugins: {
        installs: {},
        allow: 'everything',
        load: { paths: ['/opt/plugins'] },
        entries: { 'lobster-model-routing': { enabled: false }, 'my-plugin': { enabled: true } },
      },
      hooks: { $include: './hooks.json5' },
      tools: {},
    });
    expect(result.patch).toEqual({
      gateway: { controlUi: { enabled: true } },
      agents: { defaults: { humanDelay: { mode: 'natural' } } },
      plugins: { load: { paths: ['/opt/plugins'] }, entries: { 'my-plugin': { enabled: true } } },
      tools: {},
    });
    expect(result.ignoredPaths.sort()).toEqual([
      'agents.defaults.sessionStore',
      'gateway.auth',
      'hooks.$include',
      'meta',
      'plugins.allow',
      'plugins.entries.lobster-model-routing',
      'plugins.installs',
    ]);
  });

  test('refuses to replace a section that holds a managed path', () => {
    const result = sanitizeOpenClawUserConfigPatch({ gateway: null, plugins: { load: null }, cron: null });
    expect(result.patch).toEqual({ cron: null });
    expect(result.ignoredPaths.sort()).toEqual(['gateway', 'plugins.load']);
  });
});

describe('applyOpenClawUserConfigPatch', () => {
  test('merges objects, replaces arrays, removes nulls and extends managed lists', () => {
    const config = {
      agents: { defaults: { model: 'a', fallbacks: ['b'] } },
      plugins: { allow: ['memory-core'], load: { paths: ['/bundled'] } },
      browser: { enabled: true },
    };
    const snapshot = structuredClone(config);
    const merged = applyOpenClawUserConfigPatch(config, {
      agents: { defaults: { fallbacks: ['c'], blockStreamingDefault: 'on' } },
      plugins: { allow: ['memory-core', 'my-plugin'], load: { paths: ['/opt/plugins'] } },
      browser: null,
    });
    expect(merged).toEqual({
      agents: { defaults: { model: 'a', fallbacks: ['c'], blockStreamingDefault: 'on' } },
      plugins: { allow: ['memory-core', 'my-plugin'], load: { paths: ['/bundled', '/opt/plugins'] } },
    });
    expect(config).toEqual(snapshot);
  });
});

describe('revertOpenClawUserConfigLeaves', () => {
  test('removes unchanged leftovers, keeps changed values and pruned parents', () => {
    const applied = collectOpenClawUserConfigLeaves({
      hooks: { internal: { enabled: true } },
      agents: { defaults: { humanDelay: { mode: 'natural' } } },
      plugins: { allow: ['my-plugin'] },
      tools: { web: { search: { provider: 'brave' } } },
    });
    const base = {
      hooks: { internal: { enabled: true } },
      agents: { defaults: { model: 'a', humanDelay: { mode: 'off' } } },
      plugins: { allow: ['memory-core', 'my-plugin'] },
      tools: { web: { search: { provider: 'brave' } } },
    };
    const result = revertOpenClawUserConfigLeaves(base, applied, { tools: { web: { search: { provider: 'exa' } } } });
    expect(result.base).toEqual({
      agents: { defaults: { model: 'a', humanDelay: { mode: 'off' } } },
      plugins: { allow: ['memory-core'] },
      tools: { web: { search: { provider: 'brave' } } },
    });
    expect(result.reverted.map(leaf => leaf.path.join('.')).sort()).toEqual(['hooks.internal.enabled', 'plugins.allow']);
    expect(base.hooks).toEqual({ internal: { enabled: true } });
  });

  test('lists set and removed paths for display', () => {
    expect(listOpenClawUserConfigPaths({ a: { b: 1, c: null }, plugins: { allow: ['x'] }, d: {} })).toEqual([
      'a.b', 'a.c', 'plugins.allow', 'd',
    ]);
  });
});

describe('OpenClawUserConfigOverlay', () => {
  test('applies overrides and survives a later render', () => {
    const { overlay, writeUserConfig } = createOverlay();
    writeUserConfig('{ agents: { defaults: { blockStreamingDefault: "on" } } }');
    const first = render(overlay, {}, generateManaged);
    expect(first.agents).toEqual({ defaults: { model: 'lobster/main', blockStreamingDefault: 'on' } });
    expect(render(overlay, first, generateManaged)).toEqual(first);
  });

  test('patches sections LobsterAI does not render instead of replacing them', () => {
    const { overlay, writeUserConfig } = createOverlay();
    writeUserConfig('{ hooks: { internal: { enabled: true } } }');
    const result = render(overlay, { hooks: { mappings: [{ id: 'x' }] } }, generateManaged);
    expect(result.hooks).toEqual({ mappings: [{ id: 'x' }], internal: { enabled: true } });
  });

  test('removes overrides the user deletes, including runtime-preserved sections', () => {
    const { overlay, writeUserConfig } = createOverlay();
    writeUserConfig(JSON.stringify({
      gateway: { controlUi: { enabled: true } },
      plugins: { allow: ['my-plugin'], entries: { 'my-plugin': { enabled: true, config: { level: 2 } } } },
      hooks: { internal: { enabled: true } },
    }));
    const applied = render(overlay, { gateway: { trustedProxies: ['127.0.0.1'] } }, generateManaged);
    expect(applied.plugins).toMatchObject({ allow: ['memory-core', 'my-plugin'] });

    writeUserConfig('{}');
    const cleared = render(overlay, applied, generateManaged);
    expect(cleared.gateway).toEqual({
      trustedProxies: ['127.0.0.1'], mode: 'local', auth: { mode: 'token', token: '${OPENCLAW_GATEWAY_TOKEN}' },
    });
    expect(cleared.plugins).toEqual({ allow: ['memory-core'], entries: { acpx: { enabled: false } } });
    expect(cleared.hooks).toBeUndefined();
  });

  test('stops tracking a removed override whose value LobsterAI renders itself', () => {
    const { overlay, store, writeUserConfig } = createOverlay();
    writeUserConfig('{ plugins: { entries: { acpx: { enabled: false } } } }');
    const applied = render(overlay, {}, generateManaged);
    writeUserConfig('{}');
    const cleared = render(overlay, applied, generateManaged);
    expect(cleared.plugins).toMatchObject({ entries: { acpx: { enabled: false } } });
    const state = store.get<{ applied: unknown[] }>(OPENCLAW_USER_CONFIG_STORE_KEY);
    expect(state?.applied).toEqual([]);
  });

  test('keeps the last valid overrides while the file has a syntax error', () => {
    const { overlay, writeUserConfig } = createOverlay();
    writeUserConfig('{ agents: { defaults: { blockStreamingDefault: "on" } } }');
    const applied = render(overlay, {}, generateManaged);
    writeUserConfig('{ agents: { defaults: ');
    expect(render(overlay, applied, generateManaged)).toEqual(applied);
    const status = overlay.getStatus();
    expect(status.state).toBe(OpenClawUserConfigState.ParseError);
    expect(status.parseError).toBeTruthy();
    expect(status.overriddenPaths).toEqual(['agents.defaults.blockStreamingDefault']);
  });

  test('switching overrides off returns to the LobsterAI config', () => {
    const { overlay, writeUserConfig } = createOverlay();
    writeUserConfig('{ agents: { defaults: { blockStreamingDefault: "on" } } }');
    const applied = render(overlay, {}, generateManaged);
    overlay.setEnabled(false);
    expect(render(overlay, applied, generateManaged).agents).toEqual({ defaults: { model: 'lobster/main' } });
    expect(overlay.getStatus().state).toBe(OpenClawUserConfigState.Disabled);
  });

  test('reports a missing file and creates a template that parses to no overrides', () => {
    const { overlay } = createOverlay();
    expect(overlay.getStatus().state).toBe(OpenClawUserConfigState.Missing);
    const filePath = overlay.ensureFile();
    expect(parseOpenClawUserConfig(fs.readFileSync(filePath, 'utf8'))).toEqual({ ok: true, patch: {} });
    fs.writeFileSync(filePath, '{ a: 1 }');
    overlay.ensureFile();
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{ a: 1 }');
    expect(overlay.getStatus().state).toBe(OpenClawUserConfigState.Active);
  });

  test('suspends overrides when OpenClaw rejects them and confirms once a clean config is accepted', () => {
    const { overlay, writeUserConfig } = createOverlay();
    writeUserConfig('{ cron: { store: "bad" } }');
    render(overlay, {}, generateManaged);
    expect(overlay.handleConfigFailure('cron: Unrecognized key: "store"')).toBe(OpenClawUserConfigFailureOutcome.Suspended);
    // Repeated reports for the same config do not trigger another resync.
    expect(overlay.handleConfigFailure('again')).toBe(OpenClawUserConfigFailureOutcome.None);

    const clean = render(overlay, {}, generateManaged);
    expect(clean.cron).toBeUndefined();
    overlay.handleConfigAccepted();
    expect(overlay.getStatus()).toMatchObject({
      state: OpenClawUserConfigState.Suspended,
      suspension: { reason: OpenClawUserConfigSuspendReason.ConfigInvalid, detail: 'cron: Unrecognized key: "store"' },
    });
    // A failure after confirmation is not attributed to the overrides.
    expect(overlay.handleConfigFailure('other')).toBe(OpenClawUserConfigFailureOutcome.None);

    writeUserConfig('{ cron: { enabled: true } }');
    expect(overlay.getStatus().state).toBe(OpenClawUserConfigState.Active);
    expect(render(overlay, clean, generateManaged).cron).toEqual({ enabled: true });
  });

  test('restores overrides when the config fails without them as well', () => {
    const { overlay, writeUserConfig } = createOverlay();
    writeUserConfig('{ agents: { defaults: { blockStreamingDefault: "on" } } }');
    render(overlay, {}, generateManaged);
    expect(overlay.handleConfigFailure('broken provider')).toBe(OpenClawUserConfigFailureOutcome.Suspended);
    render(overlay, {}, generateManaged);
    expect(overlay.handleConfigFailure('broken provider')).toBe(OpenClawUserConfigFailureOutcome.Restored);
    const restored = render(overlay, {}, generateManaged);
    expect(restored.agents).toMatchObject({ defaults: { blockStreamingDefault: 'on' } });
    expect(overlay.handleConfigFailure('broken provider')).toBe(OpenClawUserConfigFailureOutcome.None);
    expect(overlay.getStatus().state).toBe(OpenClawUserConfigState.Active);
  });

  test('Quick Repair suspends overrides until the user applies them again', () => {
    const { overlay, writeUserConfig } = createOverlay();
    expect(overlay.suspendForRepair()).toBe(false);
    writeUserConfig('{ agents: { defaults: { blockStreamingDefault: "on" } } }');
    expect(overlay.suspendForRepair()).toBe(true);
    expect(render(overlay, {}, generateManaged).agents).toEqual({ defaults: { model: 'lobster/main' } });
    expect(overlay.getStatus().suspension?.reason).toBe(OpenClawUserConfigSuspendReason.Repair);
    overlay.resume();
    expect(render(overlay, {}, generateManaged).agents).toMatchObject({ defaults: { blockStreamingDefault: 'on' } });
  });

  test('persists state so a restart keeps the toggle and the record of applied paths', () => {
    const store = createMemoryStore();
    const { dir, overlay, writeUserConfig } = createOverlay(store);
    writeUserConfig('{ hooks: { internal: { enabled: true } } }');
    const applied = render(overlay, {}, generateManaged);
    writeUserConfig('{}');
    const restarted = new OpenClawUserConfigOverlay({ getConfigDir: () => dir, getStore: () => store });
    expect(render(restarted, applied, generateManaged).hooks).toBeUndefined();
  });

  test('ignores managed paths and reports them in the status', () => {
    const { overlay, writeUserConfig } = createOverlay();
    writeUserConfig('{ gateway: { auth: { mode: "none" } }, tools: { profile: "full" } }');
    const result = render(overlay, {}, generateManaged);
    expect(result.gateway).toMatchObject({ auth: { mode: 'token' } });
    expect(result.tools).toEqual({ profile: 'full' });
    expect(overlay.getStatus()).toMatchObject({ ignoredPaths: ['gateway.auth'], overriddenPaths: ['tools.profile'] });
  });
});
