import { describe, expect, test } from 'vitest';

import {
  isUnsupportedOpenClawSizeDropAllowance,
  OPENCLAW_CONFIG_APPLY_SIZE_DROP_PARAM,
  resolveOpenClawConfigSizeDropAllowance,
} from './openclawConfigSizeDrop';

const toRaw = (config: Record<string, unknown>): string => `${JSON.stringify(config, null, 2)}\n`;

const planModel = (index: number) => ({
  id: `plan-model-${index}`,
  name: `Plan Model ${index}`,
  api: 'openai-completions',
  reasoning: index % 2 === 0,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 32_768,
});

/** Mirrors the shape of a signed-in render: most bytes are the plan catalog. */
const signedIn = {
  meta: { lastTouchedVersion: '2026.8.1' },
  gateway: { mode: 'local', auth: { mode: 'token', token: '${LOBSTER_GATEWAY_TOKEN}' } },
  agents: {
    defaults: { model: { primary: 'lobsterai-server/plan-model-0' }, workspace: 'workspace-main' },
    list: [{ id: 'main', default: true }, { id: 'writer', workspace: 'workspace-writer' }],
  },
  plugins: { allow: ['memory-core', 'lobsterai-model-compat'], entries: { 'memory-core': { enabled: true } } },
  channels: {},
  models: {
    mode: 'replace',
    providers: {
      'lobsterai-server': {
        baseUrl: 'http://127.0.0.1:19876/v1',
        apiKey: 'proxy-managed',
        models: Array.from({ length: 36 }, (_, index) => planModel(index)),
      },
    },
  },
};

const signedOut = (() => {
  const config: Record<string, unknown> = { ...signedIn };
  delete config.models;
  return config;
})();

describe('resolveOpenClawConfigSizeDropAllowance', () => {
  test('claims the waiver when signing out removes the plan catalog', () => {
    const currentRaw = toRaw(signedIn);
    const nextRaw = toRaw(signedOut);
    // Precondition: the gateway's own 50% guard would reject this write.
    expect(Buffer.byteLength(nextRaw)).toBeLessThan(Buffer.byteLength(currentRaw) / 2);

    expect(resolveOpenClawConfigSizeDropAllowance(currentRaw, nextRaw)).toEqual({
      allow: true,
      currentBytes: Buffer.byteLength(currentRaw),
      nextBytes: Buffer.byteLength(nextRaw),
    });
  });

  test('claims the waiver for compact gateway output measured in pretty-printed bytes', () => {
    expect(resolveOpenClawConfigSizeDropAllowance(JSON.stringify(signedIn), toRaw(signedOut)).allow).toBe(true);
  });

  test('measures the parsed object when the gateway withholds raw text', () => {
    expect(resolveOpenClawConfigSizeDropAllowance(signedIn, toRaw(signedOut)).allow).toBe(true);
    expect(resolveOpenClawConfigSizeDropAllowance(null, toRaw(signedOut)).allow).toBe(false);
  });

  test('claims the waiver a little before the gateway guard trips', () => {
    const provider = signedIn.models.providers['lobsterai-server'];
    const withModels = (count: number) => toRaw({
      ...signedIn,
      models: { ...signedIn.models, providers: { 'lobsterai-server': { ...provider, models: provider.models.slice(0, count) } } },
    });
    const currentBytes = Buffer.byteLength(toRaw(signedIn));
    const ratio = (count: number) => Buffer.byteLength(withModels(count)) / currentBytes;
    // The largest catalog that already leaves less than 60% of the file.
    const count = Array.from({ length: provider.models.length }, (_, index) => provider.models.length - index)
      .find(candidate => ratio(candidate) < 0.6) ?? 0;
    expect(ratio(count)).toBeGreaterThan(0.5);

    expect(resolveOpenClawConfigSizeDropAllowance(toRaw(signedIn), withModels(count)).allow).toBe(true);
  });

  test('does not claim the waiver for writes the gateway accepts anyway', () => {
    const grown = toRaw(signedIn);
    expect(resolveOpenClawConfigSizeDropAllowance(toRaw(signedOut), grown)).toMatchObject({ allow: false });
    expect(resolveOpenClawConfigSizeDropAllowance(grown, grown)).toMatchObject({ allow: false });
  });

  test('keeps the guard when the shrink is not explained by models', () => {
    // A render that also lost agents, plugins and gateway auth is not a sign-out.
    const wiped = toRaw({ meta: signedIn.meta, gateway: { mode: 'local' } });
    const bulkyRest = {
      ...signedOut,
      agents: { list: Array.from({ length: 40 }, (_, index) => ({ id: `agent-${index}`, workspace: `ws-${index}` })) },
    };

    expect(resolveOpenClawConfigSizeDropAllowance(toRaw(signedIn), wiped).allow).toBe(false);
    expect(resolveOpenClawConfigSizeDropAllowance(toRaw(bulkyRest), wiped).allow).toBe(false);
  });

  test('ignores baselines below the gateway minimum', () => {
    const tiny = toRaw({ gateway: { mode: 'local' }, models: { providers: { p: { models: [{ id: 'm' }] } } } });

    expect(Buffer.byteLength(tiny)).toBeLessThan(512);
    expect(resolveOpenClawConfigSizeDropAllowance(tiny, toRaw({ gateway: { mode: 'local' } })).allow).toBe(false);
  });

  test('never claims the waiver from unparseable or missing input', () => {
    const nextRaw = toRaw(signedOut);

    expect(resolveOpenClawConfigSizeDropAllowance(undefined, nextRaw).allow).toBe(false);
    expect(resolveOpenClawConfigSizeDropAllowance('{"models":', nextRaw).allow).toBe(false);
    expect(resolveOpenClawConfigSizeDropAllowance('[]', nextRaw).allow).toBe(false);
    expect(resolveOpenClawConfigSizeDropAllowance(toRaw(signedIn), 'not json').allow).toBe(false);
  });
});

describe('isUnsupportedOpenClawSizeDropAllowance', () => {
  test('recognizes an unpatched gateway rejecting the param', () => {
    const error = new Error(
      `invalid config.apply params: at root: unexpected property '${OPENCLAW_CONFIG_APPLY_SIZE_DROP_PARAM}'`,
    );

    expect(isUnsupportedOpenClawSizeDropAllowance(error)).toBe(true);
  });

  test('leaves other config.apply failures alone', () => {
    expect(isUnsupportedOpenClawSizeDropAllowance(new Error('invalid config: plugins: Unrecognized key: "installs"'))).toBe(false);
    expect(isUnsupportedOpenClawSizeDropAllowance(new Error('Config write rejected: openclaw.json (size-drop:48483->18947).'))).toBe(false);
    expect(isUnsupportedOpenClawSizeDropAllowance('gateway closed')).toBe(false);
  });
});
