import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ApiFormat, ProviderAuthType, ProviderName } from '../../shared/providers';
import { getDefaultProviders, type ProvidersConfig } from '../components/settings/modelProviderUtils';
import { EXPORT_FORMAT_TYPE } from '../constants/app';
import { buildProvidersExport, importProviders, parseProvidersImport } from './providerTransfer';
import { validateExportPassword } from './providerTransferCrypto';
import {
  type EncryptedProvidersFile,
  ProviderTransferCrypto,
  ProviderTransferErrorCode,
  ProviderTransferLimits,
  ProviderTransferMode,
  ProviderTransferVersion,
} from './providerTransferTypes';

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock('./store', () => ({ localStore: storage }));
vi.mock('./i18n', () => ({ i18nService: { t: (key: string) => key } }));

const PASSWORD = '  a private backup passphrase 🔐  ';
const API_KEY = 'TEST-ONLY-API-KEY-2851';
const LOCAL_KEY = randomBytes(32);
const V1 = ProviderTransferVersion.LocalKey;
const V2 = ProviderTransferVersion.LegacyPassword;

const providers = (): ProvidersConfig => ({
  [ProviderName.OpenAI]: {
    enabled: true, apiKey: API_KEY, baseUrl: 'https://api.example.test/v1', apiFormat: ApiFormat.OpenAI,
    models: [{ id: 'test-model', name: 'Test model', supportsImage: false, customParams: { temperature: 0.5, secret: 'CUSTOM-SECRET' } }],
  },
  [ProviderName.DeepSeek]: {
    enabled: false, apiKey: 'TEST-ONLY-DISABLED-KEY', baseUrl: 'https://disabled.example.test', apiFormat: ApiFormat.OpenAI,
  },
  custom_0: {
    enabled: false, apiKey: '', baseUrl: 'http://localhost:11434/v1', apiFormat: ApiFormat.OpenAI, displayName: 'Local test',
  },
});

// These fixtures use Node crypto independently of the production exporter/KDF.
const legacyKey = (value: string, version: number) => {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = version === V1 ? LOCAL_KEY : pbkdf2Sync('lobsterai-APP', salt, 100000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  return { encrypted, iv: iv.toString('base64'), ...(version === V2 ? { salt: salt.toString('base64') } : {}) };
};

const legacyFile = (version: number, entries: Record<string, unknown>) => JSON.stringify({
  type: EXPORT_FORMAT_TYPE, version,
  encryption: { algorithm: ProviderTransferCrypto.Algorithm, keySource: ProviderTransferCrypto.KeySource, keyDerivation: ProviderTransferCrypto.KeyDerivation },
  providers: entries,
});

const expectFailure = async (raw: string, code: string, password = PASSWORD, existing = providers()) => {
  const snapshot = structuredClone(existing);
  await expect(async () => importProviders(parseProvidersImport(raw), existing, password)).rejects.toMatchObject({ code });
  expect(existing).toEqual(snapshot);
};

beforeEach(() => {
  vi.clearAllMocks();
  storage.getItem.mockResolvedValue(LOCAL_KEY.toString('base64'));
});

describe('provider export v3', () => {
  test('exports and reads the complete built-in default provider catalog', async () => {
    const defaults = getDefaultProviders();
    const parsed = parseProvidersImport(await buildProvidersExport(defaults));
    const restored = await importProviders(parsed, {});
    expect(Object.keys(restored).sort()).toEqual(Object.keys(defaults).sort());
  });

  test('defaults to configuration only and omits credentials and opaque credential-bearing fields', async () => {
    const source = providers();
    source.openai.oauthAccessToken = 'OAUTH-SECRET';
    source.openai.oauthRefreshToken = 'REFRESH-SECRET';
    source.openai.baseUrl = 'https://user:URL-SECRET@api.example.test/v1?token=QUERY-SECRET#HASH-SECRET';
    const snapshot = structuredClone(source);
    const json = await buildProvidersExport(source);
    const file = JSON.parse(json);
    expect(file.version).toBe(ProviderTransferVersion.Current);
    expect(file.mode).toBe(ProviderTransferMode.Configuration);
    for (const secret of [API_KEY, 'OAUTH-SECRET', 'REFRESH-SECRET', 'URL-SECRET', 'QUERY-SECRET', 'HASH-SECRET', 'CUSTOM-SECRET']) {
      expect(json).not.toContain(secret);
    }
    expect(file.providers.openai).not.toHaveProperty('apiKey');
    expect(file.providers.openai.models[0]).not.toHaveProperty('customParams');
    expect(file.providers.openai.baseUrl).toBe('https://api.example.test/v1');
    expect(source).toEqual(snapshot);
  });

  test('round-trips enabled, disabled and empty keys and model details without a device key', async () => {
    storage.getItem.mockRejectedValue(new Error('No source-device storage'));
    const source = providers();
    const json = await buildProvidersExport(source, { includeApiKeys: true, password: PASSWORD });
    expect(json).not.toContain(API_KEY);
    expect(json).not.toContain(source.openai.baseUrl);
    expect(json).not.toContain('test-model');
    expect(json).not.toContain(PASSWORD);
    const restored = await importProviders(parseProvidersImport(json), {}, PASSWORD);
    expect(restored).toEqual(source);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('uses the recorded 600000-iteration KDF and authenticates the complete header with standard AES-GCM', async () => {
    const file: EncryptedProvidersFile = JSON.parse(await buildProvidersExport(providers(), { includeApiKeys: true, password: PASSWORD }));
    expect(file.encryption.iterations).toBe(600000);
    const { encrypted, ...header } = file;
    const key = pbkdf2Sync(PASSWORD, Buffer.from(file.encryption.salt, 'base64'), file.encryption.iterations, 32, 'sha256');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.encryption.iv, 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(header)));
    const bytes = Buffer.from(encrypted, 'base64');
    decipher.setAuthTag(bytes.subarray(-16));
    const decoded = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString());
    expect(decoded.openai.apiKey).toBe(API_KEY);
  });

  test('generates a fresh salt, IV and ciphertext for every export', async () => {
    const first = JSON.parse(await buildProvidersExport(providers(), { includeApiKeys: true, password: PASSWORD }));
    const second = JSON.parse(await buildProvidersExport(providers(), { includeApiKeys: true, password: PASSWORD }));
    expect(first.encryption.salt).not.toBe(second.encryption.salt);
    expect(first.encryption.iv).not.toBe(second.encryption.iv);
    expect(first.encrypted).not.toBe(second.encrypted);
  });

  test.each(['', '    ', 'short', 'x'.repeat(ProviderTransferLimits.PasswordMax + 1)])('rejects weak or missing export passwords (%#)', async password => {
    await expect(buildProvidersExport(providers(), { includeApiKeys: true, password })).rejects.toBeInstanceOf(Error);
  });

  test('supports unicode passphrases and retains meaningful whitespace', () => {
    expect(() => validateExportPassword(PASSWORD)).not.toThrow();
    expect(() => validateExportPassword('这是用于模型配置备份的安全长口令')).not.toThrow();
    expect(() => validateExportPassword('        short       ')).toThrow();
  });
});

describe('v3 admission and authenticated import', () => {
  test('wrong passwords, including the old public password, cannot import a new file', async () => {
    const json = await buildProvidersExport(providers(), { includeApiKeys: true, password: PASSWORD });
    for (const password of ['wrong-password', 'lobsterai-APP', PASSWORD.trim()]) {
      await expectFailure(json, ProviderTransferErrorCode.DecryptFailed, password);
    }
  });

  test('rejects altered ciphertext, salt, IV and authenticated timestamp with no changes', async () => {
    const file = JSON.parse(await buildProvidersExport(providers(), { includeApiKeys: true, password: PASSWORD }));
    const ciphertext = Buffer.from(file.encrypted, 'base64');
    ciphertext[0] ^= 1;
    const variants = [
      { ...file, encrypted: ciphertext.toString('base64') },
      { ...file, encryption: { ...file.encryption, salt: randomBytes(16).toString('base64') } },
      { ...file, encryption: { ...file.encryption, iv: randomBytes(12).toString('base64') } },
      { ...file, exportedAt: '2000-01-01T00:00:00.000Z' },
    ];
    for (const variant of variants) await expectFailure(JSON.stringify(variant), ProviderTransferErrorCode.DecryptFailed);
  });

  test('rejects unsupported versions, mode downgrades, added plaintext and unsafe KDF parameters before deriving keys', async () => {
    const file = JSON.parse(await buildProvidersExport(providers(), { includeApiKeys: true, password: PASSWORD }));
    const derive = vi.spyOn(crypto.subtle, 'deriveKey');
    const variants = [
      { ...file, version: 99 },
      { ...file, version: V2 },
      { ...file, mode: ProviderTransferMode.Configuration },
      { ...file, providers: providers() },
      { ...file, encryption: { ...file.encryption, algorithm: 'AES-CBC' } },
      ...[0, 100000, 600000.5, ProviderTransferCrypto.MaxIterations + 1].map(iterations => ({ ...file, encryption: { ...file.encryption, iterations } })),
      { ...file, encryption: { ...file.encryption, iv: 'invalid' } },
    ];
    try {
      for (const variant of variants) await expectFailure(JSON.stringify(variant), ProviderTransferErrorCode.InvalidFile);
      expect(derive).not.toHaveBeenCalled();
    } finally { derive.mockRestore(); }
  });

  test('accepts a different JSON property order without changing authentication', async () => {
    const file = JSON.parse(await buildProvidersExport(providers(), { includeApiKeys: true, password: PASSWORD }));
    const reversed = Object.fromEntries(Object.entries(file).reverse());
    reversed.encryption = Object.fromEntries(Object.entries(file.encryption).reverse());
    expect((await importProviders(parseProvidersImport(JSON.stringify(reversed)), {}, PASSWORD)).openai.apiKey).toBe(API_KEY);
  });

  test('bounds files, providers and models, rejects invalid JSON and prototype keys', async () => {
    expect(() => parseProvidersImport(' '.repeat(ProviderTransferLimits.FileBytes + 1))).toThrow(ProviderTransferErrorCode.TooLarge);
    expect(() => parseProvidersImport('{')).toThrow(ProviderTransferErrorCode.InvalidFile);
    expect(() => parseProvidersImport('{"__proto__": {"polluted": true}}')).toThrow(ProviderTransferErrorCode.InvalidFile);
    const file = JSON.parse(await buildProvidersExport(providers()));
    const variants = [
      { ...file, providers: {} },
      { ...file, providers: [] },
      { ...file, providers: { openai: { ...file.providers.openai, apiKey: 'plain-secret' } } },
      { ...file, providers: { openai: { ...file.providers.openai, baseUrl: 'https://api.example.test?key=secret' } } },
      { ...file, providers: { openai: { ...file.providers.openai, models: Array(ProviderTransferLimits.Models + 1).fill({ id: 'a', name: 'a' }) } } },
      { ...file, providers: Object.fromEntries(Array.from({ length: ProviderTransferLimits.Providers + 1 }, (_, index) => [index ? `unknown-${index}` : ProviderName.OpenAI, {}])) },
    ];
    for (const variant of variants) await expectFailure(JSON.stringify(variant), ProviderTransferErrorCode.InvalidFile);
  });
});

describe('credential-safe configuration merge', () => {
  test('omitted keys retain existing credentials, while explicitly encrypted empty keys restore as empty', async () => {
    const source = providers();
    const restored = await importProviders(parseProvidersImport(await buildProvidersExport(source)), source);
    expect(restored.openai.apiKey).toBe(API_KEY);
    source.openai.apiKey = '';
    const encrypted = await buildProvidersExport(source, { includeApiKeys: true, password: PASSWORD });
    expect((await importProviders(parseProvidersImport(encrypted), providers(), PASSWORD)).openai.apiKey).toBe('');
  });

  test('a configuration-only file cannot send an existing key to a changed host or path', async () => {
    const source = providers();
    for (const baseUrl of ['https://different.example.test/v1', 'https://api.example.test/untrusted-path']) {
      source.openai.baseUrl = baseUrl;
      await expectFailure(await buildProvidersExport(source), ProviderTransferErrorCode.EndpointConflict);
    }
  });

  test('also blocks credential reuse when an imported coding-plan setting changes routing', async () => {
    const source = providers();
    source.openai.codingPlanEnabled = true;
    await expectFailure(await buildProvidersExport(source), ProviderTransferErrorCode.EndpointConflict);
  });

  test('does not rebind existing OAuth credentials even when an encrypted API key is supplied', async () => {
    const existing = providers();
    existing.openai.authType = ProviderAuthType.OAuth;
    const source = providers();
    source.openai.baseUrl = 'https://different.example.test/v1';
    const json = await buildProvidersExport(source, { includeApiKeys: true, password: PASSWORD });
    await expectFailure(json, ProviderTransferErrorCode.EndpointConflict, PASSWORD, existing);
  });

  test.each([ProviderTransferVersion.Current, V2])('version %s cannot redirect retained custom model parameters through a partial import', async version => {
    const existing = providers();
    existing.openai.apiKey = '';
    const source = providers();
    source.openai.baseUrl = 'https://different.example.test/v1';
    delete source.openai.models;
    const json = version === ProviderTransferVersion.Current
      ? await buildProvidersExport(source)
      : legacyFile(version, { openai: { apiKey: legacyKey('replacement-key', version), baseUrl: source.openai.baseUrl } });
    await expectFailure(json, ProviderTransferErrorCode.EndpointConflict, PASSWORD, existing);
  });

  test('imports configuration on a fresh device without introducing empty replacement keys on existing providers', async () => {
    const result = await importProviders(parseProvidersImport(await buildProvidersExport(providers())), {});
    expect(result.openai.apiKey).toBe('');
    expect(result.custom_0.displayName).toBe('Local test');
  });
});

describe('historical file compatibility', () => {
  test.each([V1, V2])('imports version %s fixtures including empty and disabled keys', async version => {
    const entries = Object.fromEntries(Object.entries(providers()).map(([key, config]) => [key, { ...config, apiKey: legacyKey(config.apiKey, version) }]));
    const parsed = parseProvidersImport(legacyFile(version, entries));
    expect(parsed.legacy).toBe(true);
    expect(await importProviders(parsed, {})).toEqual(providers());
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  test('imports split v1 ciphertext fields and the native format alias', async () => {
    const payload = legacyKey(API_KEY, V1);
    const file = legacyFile(V1, { custom_0: {
      enabled: false, baseUrl: 'https://api.example.test', apiFormat: 'native',
      apiKeyEncrypted: payload.encrypted, apiKeyIv: payload.iv,
    } });
    expect((await importProviders(parseProvidersImport(file), {})).custom_0).toMatchObject({ apiKey: API_KEY, apiFormat: ApiFormat.Anthropic });
  });

  test.each([V1, V2])('preserves supported historical plaintext and missing-key entries in version %s', async version => {
    const file = legacyFile(version, { openai: { enabled: false }, custom_0: { apiKey: 'LEGACY-PLAIN', baseUrl: 'http://localhost:11434/v1' } });
    const result = await importProviders(parseProvidersImport(file), providers());
    expect(result.openai.apiKey).toBe(API_KEY);
    expect(result.openai.enabled).toBe(false);
    expect(result.custom_0.apiKey).toBe('LEGACY-PLAIN');
  });

  test.each([V1, V2])('a damaged key aborts the entire version %s import, including when another key equals its existing value', async version => {
    const entries = {
      openai: { apiKey: legacyKey(API_KEY, version), enabled: false },
      deepseek: { apiKey: { ...legacyKey('damaged', version), encrypted: randomBytes(30).toString('base64') } },
    };
    await expectFailure(legacyFile(version, entries), version === V1 ? ProviderTransferErrorCode.LegacyDecryptFailed : ProviderTransferErrorCode.DecryptFailed);
  });

  test('a v1 file on another device fails without creating or storing a new key', async () => {
    storage.getItem.mockResolvedValue(null);
    await expectFailure(legacyFile(V1, { openai: { apiKey: legacyKey(API_KEY, V1) } }), ProviderTransferErrorCode.LegacyDecryptFailed);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});
