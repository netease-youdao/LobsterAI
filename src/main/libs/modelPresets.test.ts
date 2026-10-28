import { describe, expect, test, vi } from 'vitest';

import { ModelPresetId, modelPresetModelId } from '../../shared/modelPresets/constants';
import { ApiFormat, OpenClawProviderId } from '../../shared/providers';
import type { CoworkSession } from '../coworkStore';
import { createModelPresetClient, registerModelPresetIpc, type ResolvedPresetModel } from './modelPresets';

vi.mock('./claudeSettings', () => ({ getServerModelMetadata: vi.fn(), resolveRawApiConfig: vi.fn() }));
vi.mock('./sessionModelChange', () => ({ recordSessionModelChange: (_store: unknown, _before: unknown, after: unknown) => after }));

const resolvedModel: ResolvedPresetModel = { modelId: 'selected-model', apiFormat: 'openai' };
const modelRef = `${OpenClawProviderId.LobsteraiServer}/${resolvedModel.modelId}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let allowed = true;
  let epoch = 0;
  const session = { id: 'session', modelOverride: '', status: 'idle' } as CoworkSession;
  const getSession = vi.fn(() => session);
  const updateSession = vi.fn();
  const patchSession = vi.fn(async () => ({ modelOverride: modelRef, resolvedModelRef: modelRef }));
  const directPatch = vi.fn();
  const ensureModelsReady = vi.fn(async () => undefined);
  const resolve = vi.fn(async () => resolvedModel);
  const captureAccount = () => {
    const captured = epoch;
    return () => captured === epoch;
  };
  const assertSessionAccess = vi.fn(() => { if (!allowed) throw new Error('access denied'); });
  const registration = registerModelPresetIpc({
    ipcMain: { handle: vi.fn() } as never,
    client: { available: vi.fn(), resolve },
    getStore: vi.fn() as never,
    getSessions: () => ({ getSession, updateSession }) as never,
    getRuntime: () => ({ isSessionActive: () => false, patchSession: directPatch }) as never,
    ownerAccountKey: () => 'owner',
    ensureModelsReady,
    isAccountCurrent: captureAccount,
    assertSessionAccess,
    patchSession,
    t: key => key,
  });
  return { ...registration, getSession, updateSession, patchSession, directPatch, ensureModelsReady, resolve,
    revoke: () => { allowed = false; }, changeAccount: () => { epoch++; }, captureAccount };
}

describe('model preset selection access', () => {
  test('denies selection before reading a session or starting preparation', () => {
    const f = fixture(); f.revoke();
    expect(() => f.choose('session', ModelPresetId.Balanced, false)).toThrow('access denied');
    expect(f.getSession).not.toHaveBeenCalled();
    expect(f.ensureModelsReady).not.toHaveBeenCalled();
  });

  test.each(['prepare', 'resolve', 'patch'] as const)('rechecks session access after %s completes', async stage => {
    const f = fixture();
    if (stage === 'prepare') f.ensureModelsReady.mockImplementationOnce(async () => { f.revoke(); });
    if (stage === 'resolve') f.resolve.mockImplementationOnce(async () => { f.revoke(); return resolvedModel; });
    if (stage === 'patch') f.patchSession.mockImplementationOnce(async () => {
      f.revoke(); return { modelOverride: modelRef, resolvedModelRef: modelRef };
    });

    await expect(f.choose('session', ModelPresetId.Balanced, false)).rejects.toThrow('access denied');
    expect(f.updateSession).not.toHaveBeenCalled();
    expect(f.directPatch).not.toHaveBeenCalled();
    if (stage !== 'patch') expect(f.patchSession).not.toHaveBeenCalled();
  });

  test('routes existing-session changes through the authorized configuration lane', async () => {
    const f = fixture();
    await f.choose('session', ModelPresetId.Balanced, false);
    expect(f.patchSession).toHaveBeenCalledWith('session', expect.objectContaining({ model: modelRef }));
    expect(f.directPatch).not.toHaveBeenCalled();
    expect(f.updateSession).toHaveBeenCalledWith('session', expect.objectContaining({
      modelPresetId: ModelPresetId.Balanced, modelOverride: modelRef,
    }), { touchUpdatedAt: false });
  });

  test('initial selection retains its local setup path and enforces the account fence', async () => {
    const f = fixture();
    f.resolve.mockImplementationOnce(async () => { f.changeAccount(); return resolvedModel; });
    await expect(f.choose('session', ModelPresetId.Balanced, false, true)).rejects.toThrow('modelPresetAccountChanged');
    expect(f.patchSession).not.toHaveBeenCalled();
    expect(f.updateSession).not.toHaveBeenCalled();
  });
});

test('preset resolution does not join or delete an old account request after reentry', async () => {
  let epoch = 0;
  const first = deferred<Response>();
  const second = deferred<Response>();
  const fetchWithAuth = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const client = createModelPresetClient({ fetchWithAuth, serverBaseUrl: () => 'https://server.test', headers: () => ({}),
    isAccountCurrent: () => { const captured = epoch; return () => captured === epoch; } });
  const oldRequest = client.resolve('session', ModelPresetId.Balanced, false);
  const oldResult = expect(oldRequest).rejects.toThrow('Account changed');
  epoch++;
  const newRequest = client.resolve('session', ModelPresetId.Balanced, false);
  const response = () => new Response(JSON.stringify({ code: 0, data: resolvedModel }));
  first.resolve(response());
  await oldResult;
  expect(client.resolve('session', ModelPresetId.Balanced, false)).toBe(newRequest);
  second.resolve(response());
  await expect(newRequest).resolves.toEqual(resolvedModel);
  expect(fetchWithAuth).toHaveBeenCalledTimes(2);
});

const response = () => Response.json({ code: 0, data: { modelId: 'resolved-model', apiFormat: ApiFormat.OpenAI } });
const clientFor = (fetchWithAuth: typeof fetch, isAccountCurrent = () => () => true) => createModelPresetClient({
  fetchWithAuth, serverBaseUrl: () => 'https://server.example', headers: () => ({ 'X-Test-Capability': 'models' }), isAccountCurrent,
});

describe('model preset resolve transport', () => {
  test.each(Object.values(ModelPresetId))('uses the existing authenticated resolve endpoint for %s', async presetId => {
    const fetchWithAuth = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const signal = new AbortController().signal;
    await clientFor(fetchWithAuth).resolve('transient-request', presetId, false, signal);
    expect(fetchWithAuth).toHaveBeenCalledWith(`https://server.example/api/models/${modelPresetModelId(presetId)}/resolve`, {
      method: 'POST', headers: { 'X-Test-Capability': 'models', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'transient-request', requiresImage: false }), signal,
    });
  });

  test('keeps shared chat requests separate from independently cancellable quick answers', async () => {
    const fetchWithAuth = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const client = clientFor(fetchWithAuth);
    const first = client.resolve('same-id', ModelPresetId.Balanced, false);
    expect(client.resolve('same-id', ModelPresetId.Balanced, false)).toBe(first);
    const controller = new AbortController();
    const separate = client.resolve('same-id', ModelPresetId.Balanced, false, controller.signal);
    const rejected = expect(separate).rejects.toThrow();
    controller.abort();
    await rejected;
    await expect(first).resolves.toMatchObject({ modelId: 'resolved-model' });
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  test('rejects a response after the account changes', async () => {
    let current = true;
    let release!: (value: Response) => void;
    const client = clientFor(() => new Promise(resolve => { release = resolve; }), () => () => current);
    const pending = client.resolve('transient-request', ModelPresetId.Ultimate, false, new AbortController().signal);
    current = false;
    release(response());
    await expect(pending).rejects.toThrow('Account changed');
  });
});
