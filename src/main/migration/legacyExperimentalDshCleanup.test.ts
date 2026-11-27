import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  ExperimentalDshCleanupSkipReason,
  LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY,
  LEGACY_EXPERIMENTAL_DSH_STATE_DIR_NAME,
  MIGRATION_V2_COMPLETED_KV_KEY,
  MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY,
} from '../../shared/migration/constants';
import {
  cleanupExperimentalDshHome,
  cleanupLegacyExperimentalDsh,
  DSH_WRITER_LOCK_FILENAME,
  type ExperimentalDshCleanupKvPort,
  ExperimentalDshCleanupStatus,
  stripLobsterAiFromDshProfilePatch,
  stripLobsterAiFromLegacyDshSettings,
} from './legacyExperimentalDshCleanup';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-exp-dsh-cleanup-'));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function createMemoryKv(initial: Record<string, string> = {}): ExperimentalDshCleanupKvPort & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
    },
    delete: (key) => {
      data.delete(key);
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('stripLobsterAiFromDshProfilePatch', () => {
  test('removes lobsterai-* providers and dangling agent-default-model while preserving user routes, other rows, header comments, and !!js expressions', () => {
    const input = [
      '# Managed by dsh web profile',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    timeoutMs: 30000',
      '    providers:',
      '      lobsterai-plan:',
      '        displayName: "LobsterAI · Plan"',
      '        apiKeyEnv: LOBSTERAI_PLAN_API_KEY',
      '        api: openai-completions',
      '        baseURL: http://127.0.0.1:41234/v1',
      '        models:',
      '          - id: deepseek-v3',
      '            name: DeepSeek V3',
      '      lobsterai-deepseek:',
      '        displayName: "LobsterAI · DeepSeek"',
      '        apiKeyEnv: LOBSTERAI_DEEPSEEK_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://api.deepseek.com/v1',
      '        models:',
      '          - id: deepseek-chat',
      '            name: DeepSeek Chat',
      '      user-openrouter:',
      '        displayName: OpenRouter',
      '        apiKeyEnv: OPENROUTER_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://openrouter.ai/api/v1',
      '        models:',
      '          - id: anthropic/claude-sonnet',
      '            name: Claude Sonnet',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: lobsterai-plan',
      '    model: deepseek-v3',
      '- id: custom-plugin',
      '  name: "@community/custom"',
      '  disabled: !!js "!ctx.get(\'profileContext\')"',
      '',
    ].join('\n');

    const result = stripLobsterAiFromDshProfilePatch(input);

    expect(result.changed).toBe(true);
    expect(result.removedRoutes.sort()).toEqual(['lobsterai-deepseek', 'lobsterai-plan']);
    expect(result.clearedDefaultModel).toBe(true);
    expect(result.text.startsWith('# Managed by dsh web profile\n')).toBe(true);
    expect(result.text).toContain('!!js');
    expect(result.text).toContain('user-openrouter');
    expect(result.text).toContain('timeoutMs: 30000');
    expect(result.text).not.toContain('lobsterai-plan');
    expect(result.text).not.toContain('lobsterai-deepseek');
    expect(result.text).not.toContain('agent-default-model');
  });

  test('drops llm-pi-ai row completely when only lobsterai-* providers existed, yielding an empty YAML sequence', () => {
    const input = [
      '# header',
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      '      lobsterai-openai:',
      '        displayName: "LobsterAI · OpenAI"',
      '        apiKeyEnv: LOBSTERAI_OPENAI_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://api.openai.com/v1',
      '        models:',
      '          - id: gpt-4o',
      '            name: GPT-4o',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: lobsterai-openai',
      '    model: gpt-4o',
      '',
    ].join('\n');

    const result = stripLobsterAiFromDshProfilePatch(input);

    expect(result.changed).toBe(true);
    expect(result.removedRoutes).toEqual(['lobsterai-openai']);
    expect(result.clearedDefaultModel).toBe(true);
    expect(result.text).toBe('# header\n[]\n');
  });

  test('preserves non-identity fields like disabled when stripping empty config', () => {
    const input = [
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  disabled: true',
      '  config:',
      '    providers:',
      '      lobsterai-plan:',
      '        baseURL: http://127.0.0.1:9999/v1',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  disabled: false',
      '  config:',
      '    provider: lobsterai-plan',
      '    model: m1',
      '',
    ].join('\n');

    const result = stripLobsterAiFromDshProfilePatch(input);

    expect(result.changed).toBe(true);
    const rows = yaml.load(result.text) as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', disabled: true },
      { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', disabled: false },
    ]);
  });

  test('keeps user-selected non-lobsterai agent-default-model untouched', () => {
    const input = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      lobsterai-plan:',
      '        baseURL: http://127.0.0.1:9999/v1',
      '- id: agent-default-model',
      '  config:',
      '    provider: deepseek-official',
      '    model: deepseek-chat',
      '',
    ].join('\n');

    const result = stripLobsterAiFromDshProfilePatch(input);

    expect(result.changed).toBe(true);
    expect(result.clearedDefaultModel).toBe(false);
    expect(result.removedRoutes).toEqual(['lobsterai-plan']);
    expect(result.text).toContain('provider: deepseek-official');
    expect(result.text).toContain('model: deepseek-chat');
  });

  test('returns changed=false and exact original text when no lobsterai entries exist', () => {
    const input = '# keep my inline comment\n- id: agent-default-model # inline\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n';
    const result = stripLobsterAiFromDshProfilePatch(input);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });

  test('throws on invalid YAML sequence so caller can skip without corrupting user file', () => {
    expect(() => stripLobsterAiFromDshProfilePatch('not: a-sequence')).toThrow(/sequence/i);
  });
});

describe('stripLobsterAiFromLegacyDshSettings', () => {
  test('returns text=null when removing lobsterai entries leaves legacy settings.yaml empty', () => {
    const input = [
      'llm-pi-ai:',
      '  providers:',
      '    lobsterai-plan:',
      '      baseURL: http://127.0.0.1:1234/v1',
      'agent-default-model:',
      '  provider: lobsterai-plan',
      '  model: deepseek-v3',
      '',
    ].join('\n');

    const result = stripLobsterAiFromLegacyDshSettings(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBeNull();
    expect(result.removedRoutes).toEqual(['lobsterai-plan']);
    expect(result.clearedDefaultModel).toBe(true);
  });

  test('preserves unrelated namespaces, user providers, and non-lobsterai default model', () => {
    const input = [
      'theme:',
      '  mode: dark',
      'llm-pi-ai:',
      '  providers:',
      '    lobsterai-deepseek:',
      '      baseURL: https://api.deepseek.com/v1',
      '    my-proxy:',
      '      baseURL: https://proxy.example.com/v1',
      'agent-default-model:',
      '  provider: my-proxy',
      '  model: claude-sonnet',
      '',
    ].join('\n');

    const result = stripLobsterAiFromLegacyDshSettings(input);
    expect(result.changed).toBe(true);
    expect(result.clearedDefaultModel).toBe(false);
    expect(result.removedRoutes).toEqual(['lobsterai-deepseek']);
    expect(result.text).not.toBeNull();
    const doc = yaml.load(result.text!) as Record<string, unknown>;
    expect(doc).toEqual({
      theme: { mode: 'dark' },
      'llm-pi-ai': {
        providers: {
          'my-proxy': { baseURL: 'https://proxy.example.com/v1' },
        },
      },
      'agent-default-model': {
        provider: 'my-proxy',
        model: 'claude-sonnet',
      },
    });
  });
});

describe('cleanupExperimentalDshHome', () => {
  test('cleans all profiles (web + cli) and legacy settings.yaml, creates backup, removes stale writer lock, and leaves .credentials.yaml untouched', async () => {
    const root = createTempDir();
    const dshHome = path.join(root, '.dsh');
    const backupDir = path.join(root, 'backup');

    const webPatch = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    const cliPatch = path.join(dshHome, 'profiles', 'cli', 'cordis.patch.yml');
    const untouchedPatch = path.join(dshHome, 'profiles', 'custom', 'cordis.patch.yml');
    const legacySettings = path.join(dshHome, 'settings.yaml');
    const credentialsFile = path.join(dshHome, '.credentials.yaml');
    const writerLock = path.join(dshHome, DSH_WRITER_LOCK_FILENAME);

    writeFile(
      webPatch,
      [
        '- id: llm-pi-ai',
        '  name: "@deepseek-ai/dsh-llm-pi-ai"',
        '  config:',
        '    providers:',
        '      lobsterai-plan:',
        '        baseURL: http://127.0.0.1:4567/v1',
        '- id: agent-default-model',
        '  name: "@deepseek-ai/dsh-agent-default-model"',
        '  config:',
        '    provider: lobsterai-plan',
        '    model: deepseek-v3',
        '',
      ].join('\n'),
    );
    writeFile(
      cliPatch,
      [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      lobsterai-openai:',
        '        baseURL: https://api.openai.com/v1',
        '      personal-openai:',
        '        baseURL: https://personal.example/v1',
        '',
      ].join('\n'),
    );
    writeFile(untouchedPatch, '# user comment\n- id: theme\n  config:\n    mode: dark\n');
    const untouchedMtimeBefore = fs.statSync(untouchedPatch).mtimeMs;

    writeFile(
      legacySettings,
      [
        'llm-pi-ai:',
        '  providers:',
        '    lobsterai-legacy:',
        '      baseURL: https://legacy.example/v1',
        '',
      ].join('\n'),
    );
    writeFile(credentialsFile, 'deepseek:\n  apiKey: sk-user-secret\n');
    writeFile(writerLock, JSON.stringify({ pid: 999999, port: 3080, startedAt: '2026-10-01T00:00:00Z' }));

    const result = await cleanupExperimentalDshHome({
      dshHomeDir: dshHome,
      label: 'shared-dsh',
      cleanWriterLock: true,
      backupDir,
      isProcessAlive: () => false,
    });

    expect(result.hadTransientFailure).toBe(false);
    expect(result.removedRoutes.sort()).toEqual(['lobsterai-legacy', 'lobsterai-openai', 'lobsterai-plan']);
    expect(result.clearedDefaultProfiles).toEqual(['shared-dsh/web']);
    expect(result.writerLockRemoved).toBe(true);
    expect(result.backupCreated).toBe(true);

    expect(fs.readFileSync(webPatch, 'utf8')).toBe('[]\n');
    expect(fs.readFileSync(cliPatch, 'utf8')).toContain('personal-openai');
    expect(fs.readFileSync(cliPatch, 'utf8')).not.toContain('lobsterai-openai');
    expect(fs.statSync(untouchedPatch).mtimeMs).toBe(untouchedMtimeBefore);
    expect(fs.existsSync(legacySettings)).toBe(false);
    expect(fs.existsSync(writerLock)).toBe(false);
    expect(fs.readFileSync(credentialsFile, 'utf8')).toBe('deepseek:\n  apiKey: sk-user-secret\n');
    expect(fs.readdirSync(backupDir).length).toBe(3);
  });

  test('takes over a dead-PID profile lock but reports transient failure when a live foreign process holds the lock', async () => {
    const root = createTempDir();
    const dshHome = path.join(root, '.dsh');
    const webDir = path.join(dshHome, 'profiles', 'web');
    const webPatch = path.join(webDir, 'cordis.patch.yml');
    const lockPath = path.join(webDir, 'package.json.lock');

    writeFile(
      webPatch,
      '- id: llm-pi-ai\n  config:\n    providers:\n      lobsterai-plan:\n        baseURL: http://127.0.0.1:1/v1\n',
    );
    writeFile(lockPath, '424242\n');

    // Live holder -> times out cleanly without touching file.
    const blocked = await cleanupExperimentalDshHome({
      dshHomeDir: dshHome,
      label: 'shared-dsh',
      cleanWriterLock: false,
      lockTimeoutMs: 60,
      isProcessAlive: (pid) => pid === 424242,
    });
    expect(blocked.hadTransientFailure).toBe(true);
    expect(fs.readFileSync(webPatch, 'utf8')).toContain('lobsterai-plan');
    expect(fs.existsSync(lockPath)).toBe(true);

    // Dead holder -> takes over lock and cleans file.
    const cleaned = await cleanupExperimentalDshHome({
      dshHomeDir: dshHome,
      label: 'shared-dsh',
      cleanWriterLock: false,
      lockTimeoutMs: 200,
      isProcessAlive: () => false,
    });
    expect(cleaned.hadTransientFailure).toBe(false);
    expect(cleaned.removedRoutes).toEqual(['lobsterai-plan']);
    expect(fs.readFileSync(webPatch, 'utf8')).toBe('[]\n');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('skips corrupted YAML without throwing or overwriting user file', async () => {
    const root = createTempDir();
    const dshHome = path.join(root, '.dsh');
    const webPatch = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    const brokenYaml = 'not-a-list: lobsterai-plan\n';
    writeFile(webPatch, brokenYaml);

    const result = await cleanupExperimentalDshHome({
      dshHomeDir: dshHome,
      label: 'shared-dsh',
      cleanWriterLock: false,
    });

    expect(result.hadTransientFailure).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(fs.readFileSync(webPatch, 'utf8')).toBe(brokenYaml);
  });
});

describe('cleanupLegacyExperimentalDsh', () => {
  test('skips pure fresh installs without touching ~/.dsh', async () => {
    const root = createTempDir();
    const userDataDir = path.join(root, 'userData');
    const sharedDshHomeDir = path.join(root, '.dsh');
    fs.mkdirSync(userDataDir, { recursive: true });
    const webPatch = path.join(sharedDshHomeDir, 'profiles', 'web', 'cordis.patch.yml');
    writeFile(
      webPatch,
      '- id: llm-pi-ai\n  config:\n    providers:\n      lobsterai-plan:\n        baseURL: http://127.0.0.1:1/v1\n',
    );

    const kv = createMemoryKv();
    const result = await cleanupLegacyExperimentalDsh({
      userDataDir,
      sharedDshHomeDir,
      kv,
      now: () => new Date('2026-11-27T00:00:00.000Z'),
    });

    expect(result.status).toBe(ExperimentalDshCleanupStatus.SkippedFreshInstall);
    expect(fs.readFileSync(webPatch, 'utf8')).toContain('lobsterai-plan');
    expect(JSON.parse(kv.get(MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY)!)).toEqual({
      completedAt: '2026-11-27T00:00:00.000Z',
      skipped: ExperimentalDshCleanupSkipReason.FreshInstall,
    });
  });

  test('cleans both ~/.dsh and preserved <userData>/dsh (keeping sessions) for upgraded users even when dsh_config was disabled, then deletes dsh_config and becomes idempotent', async () => {
    const root = createTempDir();
    const userDataDir = path.join(root, 'userData');
    const sharedDshHomeDir = path.join(root, '.dsh');
    const privateDshHomeDir = path.join(userDataDir, LEGACY_EXPERIMENTAL_DSH_STATE_DIR_NAME);

    const sharedPatch = path.join(sharedDshHomeDir, 'profiles', 'web', 'cordis.patch.yml');
    const privatePatch = path.join(privateDshHomeDir, 'profiles', 'web', 'cordis.patch.yml');
    const privateSession = path.join(privateDshHomeDir, 'sessions', 'sess-1.jsonl.zst');

    writeFile(
      sharedPatch,
      '- id: llm-pi-ai\n  config:\n    providers:\n      lobsterai-plan:\n        baseURL: http://127.0.0.1:1/v1\n',
    );
    writeFile(
      privatePatch,
      '- id: llm-pi-ai\n  config:\n    providers:\n      lobsterai-deepseek:\n        baseURL: https://api.deepseek.com/v1\n',
    );
    writeFile(privateSession, 'preserved-session-data');

    const kv = createMemoryKv({
      [MIGRATION_V2_COMPLETED_KV_KEY]: JSON.stringify({ migratedAt: '2026-11-20T00:00:00.000Z' }),
      [LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY]: JSON.stringify({ enabled: false }),
    });

    const first = await cleanupLegacyExperimentalDsh({
      userDataDir,
      sharedDshHomeDir,
      kv,
      now: () => new Date('2026-11-27T01:00:00.000Z'),
    });

    expect(first.status).toBe(ExperimentalDshCleanupStatus.Completed);
    expect(first.removedRoutes.sort()).toEqual(['lobsterai-deepseek', 'lobsterai-plan']);
    expect(fs.readFileSync(sharedPatch, 'utf8')).toBe('[]\n');
    expect(fs.readFileSync(privatePatch, 'utf8')).toBe('[]\n');
    // Private `<userData>/dsh` directory and its session history remain intact.
    expect(fs.readFileSync(privateSession, 'utf8')).toBe('preserved-session-data');
    expect(kv.get(LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY)).toBeNull();
    expect(kv.get(MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY)).not.toBeNull();

    // Second call is an instant idempotent no-op.
    const second = await cleanupLegacyExperimentalDsh({
      userDataDir,
      sharedDshHomeDir,
      kv,
    });
    expect(second.status).toBe(ExperimentalDshCleanupStatus.AlreadyCompleted);
  });

  test('retries on transient lock timeout up to max attempts and gives up cleanly after 3 failures', async () => {
    const root = createTempDir();
    const userDataDir = path.join(root, 'userData');
    const sharedDshHomeDir = path.join(root, '.dsh');
    const webDir = path.join(sharedDshHomeDir, 'profiles', 'web');

    writeFile(
      path.join(webDir, 'cordis.patch.yml'),
      '- id: llm-pi-ai\n  config:\n    providers:\n      lobsterai-plan:\n        baseURL: http://127.0.0.1:1/v1\n',
    );
    writeFile(path.join(webDir, 'package.json.lock'), '77777\n');

    const kv = createMemoryKv({
      [MIGRATION_V2_COMPLETED_KV_KEY]: JSON.stringify({ migratedAt: '2026-11-20T00:00:00.000Z' }),
      [LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY]: JSON.stringify({ enabled: true }),
    });

    const opts = {
      userDataDir,
      sharedDshHomeDir,
      kv,
      lockTimeoutMs: 40,
      isProcessAlive: (pid: number) => pid === 77777,
    };

    const r1 = await cleanupLegacyExperimentalDsh(opts);
    expect(r1.status).toBe(ExperimentalDshCleanupStatus.RetryScheduled);
    expect(r1.attempts).toBe(1);
    expect(kv.get(LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY)).not.toBeNull();

    const r2 = await cleanupLegacyExperimentalDsh(opts);
    expect(r2.status).toBe(ExperimentalDshCleanupStatus.RetryScheduled);
    expect(r2.attempts).toBe(2);

    const r3 = await cleanupLegacyExperimentalDsh(opts);
    expect(r3.status).toBe(ExperimentalDshCleanupStatus.PartialGaveUp);
    expect(r3.attempts).toBe(3);
    expect(kv.get(LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY)).toBeNull();

    const r4 = await cleanupLegacyExperimentalDsh(opts);
    expect(r4.status).toBe(ExperimentalDshCleanupStatus.AlreadyCompleted);
  });
});
