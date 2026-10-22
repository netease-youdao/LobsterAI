import { describe, expect, test, vi } from 'vitest';

import { ModelPresetId, modelPresetModelId } from '../../shared/modelPresets/constants';
import { ApiFormat } from '../../shared/providers';
import { createModelPresetClient } from './modelPresets';

vi.mock('./claudeSettings', () => ({ getServerModelMetadata: vi.fn(), resolveRawApiConfig: vi.fn() }));

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
