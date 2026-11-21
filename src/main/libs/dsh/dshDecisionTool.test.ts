import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  DECISION_EVALUATE_TOOL_NAME,
  DECISION_MODEL_CONFIG_STORE_KEY,
  DecisionModelErrorCode,
  DecisionModelProvider,
} from '../../../shared/decisionModel/constants';
import { MigrationV2Status } from '../../../shared/migration/constants';
import { runLegacyOpenClawMigration } from '../../migration/legacyOpenClawMigrator';
import {
  type DecisionFetch,
  DecisionLimits,
  DecisionQuestionType,
  JEV_LATEST_MODEL,
  OPENROUTER_DECISIONS_URL,
  OPENROUTER_JEV_MODEL,
  TYPESAFE_SYSTEM_ONE_URL,
} from '../decisionModelClient';
import {
  type DecisionModelConfig,
  DEFAULT_DECISION_MODEL_CONFIG,
  normalizeDecisionModelConfig,
} from '../decisionModelConfig';
import {
  createDshDecisionToolProvider,
  DECISION_EVALUATE_INPUT_SCHEMA,
  DECISION_EVALUATE_TOOL_DESCRIPTION,
  DECISION_EVALUATE_TOOL_DESCRIPTOR,
  DECISION_EVALUATE_TOOL_TIMEOUT_MS,
} from './dshDecisionTool';

const COMPATIBLE_ENDPOINT = 'http://127.0.0.1:41999/v1/systemone';

const tempDirs: string[] = [];

const makeFetch = (status: number, body: unknown): DecisionFetch => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

describe('createDshDecisionToolProvider', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test('exposes decision_evaluate descriptor only when enabled and fully configured', () => {
    let config: DecisionModelConfig = { ...DEFAULT_DECISION_MODEL_CONFIG };
    const provider = createDshDecisionToolProvider({
      getConfig: () => config,
      fetch: vi.fn<DecisionFetch>(),
    });

    // Disabled by default -> no descriptors.
    expect(provider.listDescriptors()).toEqual([]);

    // Enabled without API key -> still inactive.
    config = { ...DEFAULT_DECISION_MODEL_CONFIG, enabled: true, apiKey: '' };
    expect(provider.listDescriptors()).toEqual([]);

    // Compatible provider enabled with key but invalid endpoint -> still inactive.
    config = {
      ...DEFAULT_DECISION_MODEL_CONFIG,
      enabled: true,
      provider: DecisionModelProvider.Compatible,
      apiKey: 'sk-compat-key',
      endpoint: 'not-a-url',
    };
    expect(provider.listDescriptors()).toEqual([]);

    // Compatible provider enabled with key + valid endpoint -> active.
    config = {
      ...config,
      endpoint: COMPATIBLE_ENDPOINT,
    };
    expect(provider.listDescriptors()).toEqual([DECISION_EVALUATE_TOOL_DESCRIPTOR]);

    // TypeSafe enabled with key -> active.
    config = {
      ...DEFAULT_DECISION_MODEL_CONFIG,
      enabled: true,
      provider: DecisionModelProvider.TypeSafe,
      apiKey: 'ts-key-123',
    };
    expect(provider.listDescriptors()).toEqual([DECISION_EVALUATE_TOOL_DESCRIPTOR]);

    // Toggled back off -> empty immediately.
    config = { ...config, enabled: false };
    expect(provider.listDescriptors()).toEqual([]);
  });

  test('descriptor preserves decision_evaluate name, description, schema, timeout, and concurrency safety', () => {
    expect(DECISION_EVALUATE_TOOL_DESCRIPTOR.name).toBe(DECISION_EVALUATE_TOOL_NAME);
    expect(DECISION_EVALUATE_TOOL_DESCRIPTOR.description).toBe(DECISION_EVALUATE_TOOL_DESCRIPTION);
    expect(DECISION_EVALUATE_TOOL_DESCRIPTOR.timeoutMs).toBe(DECISION_EVALUATE_TOOL_TIMEOUT_MS);
    expect(DECISION_EVALUATE_TOOL_DESCRIPTOR.isConcurrencySafe).toBe(true);
    expect(DECISION_EVALUATE_TOOL_DESCRIPTOR.inputSchema).toBe(DECISION_EVALUATE_INPUT_SCHEMA);

    const properties = DECISION_EVALUATE_INPUT_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(DECISION_EVALUATE_INPUT_SCHEMA.required).toEqual(['state', 'questions']);
    expect(properties.state.oneOf).toEqual([
      { type: 'string' },
      { type: 'object', additionalProperties: true },
      { type: 'array' },
    ]);
    expect(properties.questions.minItems).toBe(1);
    expect(properties.questions.maxItems).toBe(DecisionLimits.MaxQuestions);

    const itemProps = (properties.questions.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
    expect(itemProps.type.enum).toEqual([
      DecisionQuestionType.Boolean,
      DecisionQuestionType.Choice,
      DecisionQuestionType.Score,
    ]);
    expect(itemProps.options).toBeDefined();
    expect(itemProps.levels).toBeDefined();
    expect(itemProps.trueCriteria).toBeDefined();
    expect(itemProps.falseCriteria).toBeDefined();
  });

  test('executes decision_evaluate against configured provider and returns structured content + details', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const fetch: DecisionFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'jev-custom-1.13',
          answers: {
            approve: { type: 'noul', noul: 0.94 },
            bucket: {
              type: 'choice',
              choice: 'shipping',
              confidence: 0.91,
              probabilities: { shipping: 0.91, quality: 0.09 },
            },
            severity: {
              type: 'score',
              score: 1.8,
              confidence: 0.87,
              probabilities: { '0': 0.05, '1': 0.15, '2': 0.8 },
            },
          },
          usage: { input_tokens: 95, output_tokens: 18, cost: 0.000003 },
        }),
      };
    };

    const config: DecisionModelConfig = {
      enabled: true,
      provider: DecisionModelProvider.Compatible,
      endpoint: COMPATIBLE_ENDPOINT,
      apiKey: 'dm-secret-key-77',
      apiKeys: { [DecisionModelProvider.Compatible]: 'dm-secret-key-77' },
    };

    const provider = createDshDecisionToolProvider({ getConfig: () => config, fetch });
    const response = await provider.execute(
      DECISION_EVALUATE_TOOL_NAME,
      {
        state: { orderId: 'ORD-77', note: 'Arrived late with a cracked box.' },
        questions: [
          { id: 'approve', type: 'boolean', instructions: 'Should we approve a refund?' },
          {
            id: 'bucket',
            type: 'choice',
            instructions: 'Which category fits?',
            options: [{ name: 'shipping' }, { name: 'quality' }],
          },
          {
            id: 'severity',
            type: 'score',
            instructions: 'Severity level?',
            levels: ['low', 'medium', 'high'],
          },
        ],
      },
      { agentId: 'main', coworkSessionId: 'cw-session-1', callId: 'call-99' },
    ) as { content: Array<{ type: string; text: string }>; details: Record<string, unknown>; isError?: boolean };

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(COMPATIBLE_ENDPOINT);
    expect(calls[0].headers.Authorization).toBe('Bearer dm-secret-key-77');
    expect(calls[0].body.model).toBe(JEV_LATEST_MODEL);
    expect(calls[0].body.state).toEqual({ orderId: 'ORD-77', note: 'Arrived late with a cracked box.' });

    expect(response.isError).toBeUndefined();
    const payload = JSON.parse(response.content[0].text) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: 'ok',
      provider: DecisionModelProvider.Compatible,
      model: 'jev-custom-1.13',
      answers: {
        approve: { type: 'boolean', probability: 0.94 },
        bucket: { type: 'choice', choice: 'shipping', confidence: 0.91 },
        severity: { type: 'score', score: 1.8, level: 'high', confidence: 0.87 },
      },
    });
    expect(response.details).toMatchObject({
      provider: DecisionModelProvider.Compatible,
      model: 'jev-custom-1.13',
      questionCount: 3,
      invalidCount: 0,
    });
  });

  test('routes OpenRouter and TypeSafe configs to their canonical endpoints and models', async () => {
    const requested: Array<{ url: string; model: string }> = [];
    const fetch: DecisionFetch = async (url, init) => {
      const parsed = JSON.parse(init.body) as { model: string };
      requested.push({ url, model: parsed.model });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: parsed.model,
          answers: { q1: { type: 'noul', noul: 0.8 } },
        }),
      };
    };

    let config: DecisionModelConfig = {
      enabled: true,
      provider: DecisionModelProvider.OpenRouter,
      endpoint: '',
      apiKey: 'sk-or-test',
      apiKeys: { [DecisionModelProvider.OpenRouter]: 'sk-or-test' },
    };
    const provider = createDshDecisionToolProvider({ getConfig: () => config, fetch });
    const args = {
      state: 'Short context',
      questions: [{ id: 'q1', type: 'boolean', instructions: 'Is this short?' }],
    };

    await provider.execute(DECISION_EVALUATE_TOOL_NAME, args, { agentId: 'main', sessionId: 'dsh-1' });
    config = {
      enabled: true,
      provider: DecisionModelProvider.TypeSafe,
      endpoint: '',
      apiKey: 'ts-test',
      apiKeys: { [DecisionModelProvider.TypeSafe]: 'ts-test' },
    };
    await provider.execute(DECISION_EVALUATE_TOOL_NAME, args, { agentId: 'main', sessionId: 'dsh-1' });

    expect(requested).toEqual([
      { url: OPENROUTER_DECISIONS_URL, model: OPENROUTER_JEV_MODEL },
      { url: TYPESAFE_SYSTEM_ONE_URL, model: JEV_LATEST_MODEL },
    ]);
  });

  test('forwards AbortSignal cancellation and rejects unknown tool names', async () => {
    const fetch: DecisionFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      if (init.signal.aborted) reject(new Error('aborted'));
    });

    const config: DecisionModelConfig = {
      ...DEFAULT_DECISION_MODEL_CONFIG,
      enabled: true,
      apiKey: 'ts-secret',
    };
    const provider = createDshDecisionToolProvider({ getConfig: () => config, fetch });

    await expect(
      provider.execute('other_tool', {}, { agentId: 'main' }),
    ).rejects.toThrow(/Unsupported decision model tool/);

    const cancelled = await provider.execute(
      DECISION_EVALUATE_TOOL_NAME,
      {
        state: 'Context',
        questions: [{ id: 'q1', type: 'boolean', instructions: 'Yes?' }],
      },
      { agentId: 'main', signal: AbortSignal.abort() },
    ) as { content: Array<{ text: string }>; isError?: boolean; details?: { errorCode?: string } };

    expect(cancelled.isError).toBe(true);
    expect(cancelled.details?.errorCode).toBe(DecisionModelErrorCode.Cancelled);
    expect(JSON.parse(cancelled.content[0].text)).toMatchObject({
      status: 'unavailable',
      errorCode: DecisionModelErrorCode.Cancelled,
    });
  });

  test('preserves migrated kv[decision_model_config] across OpenClaw -> DSH v2 upgrade and immediately exposes decision_evaluate', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-decision-upgrade-'));
    tempDirs.push(userDataDir);
    const sqlitePath = path.join(userDataDir, 'lobsterai.sqlite');
    const openclawStateDir = path.join(userDataDir, 'openclaw', 'state');
    fs.mkdirSync(openclawStateDir, { recursive: true });
    fs.writeFileSync(path.join(openclawStateDir, 'openclaw.json'), JSON.stringify({ plugins: {} }), 'utf8');

    const legacyDecisionConfig = {
      enabled: true,
      provider: DecisionModelProvider.Compatible,
      endpoint: COMPATIBLE_ENDPOINT,
      apiKey: 'legacy-decision-key-42',
    };

    const seedDb = new Database(sqlitePath);
    seedDb.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    seedDb.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      'cowork.agent_engine',
      'openclaw',
      Date.now(),
    );
    seedDb.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      DECISION_MODEL_CONFIG_STORE_KEY,
      JSON.stringify(legacyDecisionConfig),
      Date.now(),
    );
    seedDb.close();

    const migration = runLegacyOpenClawMigration({ userDataDir, sqlitePath });
    expect(migration.status).toBe(MigrationV2Status.Completed);

    const migratedDb = new Database(sqlitePath, { readonly: true });
    const row = migratedDb.prepare('SELECT value FROM kv WHERE key = ?').get(DECISION_MODEL_CONFIG_STORE_KEY) as
      | { value?: string }
      | undefined;
    migratedDb.close();

    expect(row?.value).toBeDefined();
    const migratedConfig = normalizeDecisionModelConfig(JSON.parse(row!.value!));
    expect(migratedConfig).toEqual({
      enabled: true,
      provider: DecisionModelProvider.Compatible,
      endpoint: COMPATIBLE_ENDPOINT,
      apiKey: 'legacy-decision-key-42',
      apiKeys: { [DecisionModelProvider.Compatible]: 'legacy-decision-key-42' },
    });

    const provider = createDshDecisionToolProvider({
      getConfig: () => migratedConfig,
      fetch: makeFetch(200, {
        model: 'jev-migrated',
        answers: { ok: { type: 'noul', noul: 0.99 } },
      }),
    });

    expect(provider.listDescriptors().map(d => d.name)).toEqual([DECISION_EVALUATE_TOOL_NAME]);

    const result = await provider.execute(
      DECISION_EVALUATE_TOOL_NAME,
      {
        state: 'Migrated config test',
        questions: [{ id: 'ok', type: 'boolean', instructions: 'Did migration keep config?' }],
      },
      { agentId: 'main', coworkSessionId: 'cw-migrated', callId: 'call-mig-1' },
    ) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      status: 'ok',
      model: 'jev-migrated',
      answers: { ok: { type: 'boolean', probability: 0.99 } },
    });
  });
});
