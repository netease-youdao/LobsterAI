import { describe, expect, test, vi } from 'vitest';

import { ModelPresetId } from '../../shared/modelPresets/constants';
import { OpenClawProviderId } from '../../shared/providers';
import type { CoworkSession } from '../coworkStore';
import { createModelPresetClient, registerModelPresetIpc, type ResolvedPresetModel } from './modelPresets';

vi.mock('./claudeSettings', () => ({ getServerModelMetadata: () => undefined }));
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
