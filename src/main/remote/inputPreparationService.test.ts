import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, promises as fs, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';

import { buildCoworkImageAttachmentPreviews } from '../../shared/cowork/imageAttachments';
import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteInputIntent, RemoteInputMode, RemoteInputReason, type RemotePreparationClaim } from '../../shared/remote/input';
import type { CoworkStore } from '../coworkStore';
import { payloadHash } from './canonical';
import { InputPreparationService, type LocalPreparedInput } from './inputPreparationService';
import type { RemoteAgentCatalog } from './remoteAgentCatalog';
import { RemoteModelCatalog } from './remoteModelCatalog';

const Target = { First: 'space-a-generation-7', Second: 'space-b-generation-4' } as const;
const owner = { userId: 'A', scopeKey: 'personal' };
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function fixture(getTargetId?: () => string | null) {
  const folder = mkdtempSync(path.join(tmpdir(), 'remote-input-')); folders.push(folder);
  const cwd = path.join(folder, 'cwd'); mkdirSync(cwd);
  const values = new Map<string, unknown>();
  let actor: RemoteOwner | null = owner;
  let version = '1'; let session: any = null; let enabled = true;
  const remote = { get: <T>(key: string): T | null => values.get(key) as T ?? null,
    put: (key: string, value: unknown) => values.set(key, structuredClone(value)),
    remove: (key: string) => values.delete(key),
    entries: (prefix: string, after = '', limit = 50) => [...values.entries()].filter(([key]) => key.startsWith(prefix) && key > after).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value })),
    owner: () => owner, localSessionId: () => session?.id, inputVersion: () => '0', controlVersion: () => '4' };
  const store = { remote, assertAgentAccess: vi.fn(), getAgent: () => ({ model: 'provider/model', thinkingLevel: 'high', enabled }),
    getSession: () => session, agentOwnership: { get: () => ({ version }), canPublish: () => !session } } as unknown as CoworkStore;
  const catalog = { refresh: vi.fn(async () => [{ agentId: 'main', version, defaultWorkspaceId: 'ws', workspaceAvailable: true }]), resolve: () => cwd } as unknown as RemoteAgentCatalog;
  const models = new RemoteModelCatalog(store.remote, () => [{ identity: 'configured-model', runtimeRef: 'provider/model', source: 'custom', displayName: 'Chat', providerLabel: 'Custom',
    available: true, image: true, toolCalling: true, thinking: { options: ['low', 'high'], default: 'low' }, configuration: {} }], getTargetId);
  const deps = { store, models, cacheRoot: path.join(folder, 'cache'), getOwner: () => actor, getTargetId, getDefaultModel: () => 'provider/model', getAgentCatalog: () => catalog };
  const service = new InputPreparationService(deps);
  const claim: RemotePreparationClaim = { preparationId: 'prep', claimId: 'claim', claimToken: 'token', claimUntil: new Date(Date.now() + 60_000).toISOString(), statusVersion: '1',
    request: { preparationId: 'prep', inputSchemaVersion: 2, purpose: 'create_session', draftId: 'draft',
      input: { text: ' hello ', agent: { agentId: 'main', expectedVersion: '1' }, model: { mode: RemoteInputMode.Agent } } } };
  const attach = (body: string, intent: 'file' | 'image' = RemoteInputIntent.File): void => {
    claim.request.input.text = '';
    claim.request.input.attachments = [{ kind: 'uploaded_asset', assetId: 'asset', version: '1', intent }];
    claim.attachments = [{ assetId: 'asset', version: '1', intent, sha256: createHash('sha256').update(body).digest('hex'), sizeBytes: String(Buffer.byteLength(body)), mimeType: intent === RemoteInputIntent.File ? 'text/plain' : 'image/png', fileName: 'report.txt' }];
  };
  return { service, deps, claim, attach, cwd, values, catalog,
    setActor: (next: RemoteOwner | null) => { actor = next; }, changeVersion: () => { version = '2'; }, disable: () => { enabled = false; },
    continueAnonymous: () => { session = { id: 'local', agentId: 'anon', cwd, modelOverride: 'provider/model', thinkingLevel: 'low' };
      claim.request = { ...claim.request, purpose: 'send_message', sessionId: 'remote', expectedInputVersion: '0', expectedControlVersion: '4',
        input: { text: 'continue', model: { mode: RemoteInputMode.Session } } }; } };
}
it('rejects preparation while the current target has not been verified', async () => {
  const { service, claim, values } = fixture(() => null);
  const download = vi.fn();
  await expect(service.prepare(owner, 'pc', claim, download, () => true)).rejects.toThrow(RemoteInputReason.Stale);
  expect(download).not.toHaveBeenCalled();
  expect(values.size).toBe(0);
});
it('isolates preparations and cached files across targets with identical preparation IDs', async () => {
  let targetId: string | null = Target.First;
  const { service, deps, claim, attach } = fixture(() => targetId); attach('hello');
  const first = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  expect(first.targetId).toBe(Target.First);
  targetId = Target.Second;
  expect(() => service.read('prep', owner, 'pc')).toThrow(RemoteInputReason.Stale);
  expect(() => service.validate(first, owner, 'pc', true)).toThrow(RemoteInputReason.Stale);
  expect(() => service.bind(first, 'command')).toThrow(RemoteInputReason.Stale);
  await expect(service.executionOptions(first, () => undefined)).rejects.toThrow(RemoteInputReason.Stale);
  const second = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  expect(second.targetId).toBe(Target.Second);
  expect(second.cacheDirectory).not.toBe(first.cacheDirectory);
  targetId = Target.First;
  expect(new InputPreparationService(deps).read('prep', owner, 'pc')).toEqual(first);
  expect(await service.cleanupExpired(first.expiresAt + 25 * 60 * 60_000)).toBe(2);
  expect(existsSync(second.cacheDirectory!)).toBe(false);
  expect(existsSync(first.cacheDirectory!)).toBe(false);
});
it('rejects old downloads after a target round trip without consuming their ready input', async () => {
  let targetId: string | null = Target.First;
  const { service, claim, attach, values } = fixture(() => targetId); attach('hello');
  const download = async () => {
    targetId = Target.Second; service.reset();
    targetId = Target.First; service.reset();
    return new Response('hello');
  };
  await expect(service.prepare(owner, 'pc', claim, download, () => true)).rejects.toThrow(RemoteInputReason.Account);
  expect([...values.keys()].filter(key => key.startsWith('inputPreparation:'))).toEqual([]);
});
it('does not return a cached text preparation if its route changes while validation yields', async () => {
  const { service, claim } = fixture(() => Target.First);
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true);
  const pending = service.prepare(owner, 'pc', claim, vi.fn(), () => true);
  service.reset();
  await expect(pending).rejects.toThrow(RemoteInputReason.Account);
  expect(service.read('prep', owner, 'pc')).toEqual(prepared);
});
it('rejects an attachment response if the target changes during download', async () => {
  let targetId: string | null = Target.First;
  const { service, claim, attach, values } = fixture(() => targetId); attach('hello');
  const download = async () => { targetId = Target.Second; return new Response('hello'); };
  await expect(service.prepare(owner, 'pc', claim, download, () => true)).rejects.toThrow(RemoteInputReason.Account);
  expect([...values.keys()].filter(key => key.startsWith('inputPreparation:'))).toEqual([]);
});
it('freezes Agent model, thinking and cwd without creating a run', async () => {
  const { service, claim, cwd, values } = fixture();
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true);
  expect(prepared.cwd).toBe(cwd);
  expect(prepared.resolvedInput.options).toEqual({ thinkingLevel: 'high' });
  expect(prepared.resolvedInput.text).toBe(' hello ');
  expect(prepared.inputDigest).toBe(payloadHash(prepared.resolvedInput));
  expect([...values.keys()].some(key => key.startsWith('run:'))).toBe(false);
  expect(JSON.stringify(prepared.resolvedInput)).not.toContain(cwd);
});
it('downloads an attachment only to a generated local path and reuses durable preparation', async () => {
  const { service, deps, claim, attach } = fixture(); attach('hello');
  const download = vi.fn(async () => new Response('hello'));
  const prepared = await service.prepare(owner, 'pc', claim, download, () => true);
  expect(readFileSync(prepared.files[0].path, 'utf8')).toBe('hello');
  const restarted = new InputPreparationService(deps);
  expect(await restarted.prepare(owner, 'pc', claim, download, () => true)).toEqual(prepared);
  expect(download).toHaveBeenCalledTimes(1);
  restarted.bind(prepared, 'cmd'); expect(() => restarted.bind(prepared, 'other')).toThrow(RemoteInputReason.Stale);
});
it('rejects changed content and does not save a ready manifest', async () => {
  const { service, claim, attach, values } = fixture(); attach('hello');
  await expect(service.prepare(owner, 'pc', claim, async () => new Response('other'), () => true)).rejects.toThrow(RemoteInputReason.Asset);
  expect(values.has('inputPreparation:prep')).toBe(false);
});
it('fences an account change during download including an old session generation', async () => {
  const { service, claim, attach, setActor } = fixture(); attach('hello'); let generation = 1;
  await expect(service.prepare(owner, 'pc', claim, async () => { setActor({ userId: 'B', scopeKey: 'personal' }); setActor(owner); generation++; return new Response('hello'); }, () => generation === 1)).rejects.toThrow(RemoteInputReason.Account);
});
it('keeps original cwd and allows an anonymous Agent for an owned continuation', async () => {
  const { service, claim, continueAnonymous, catalog, cwd, changeVersion } = fixture(); continueAnonymous();
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true);
  expect(prepared.cwd).toBe(cwd); expect(prepared.resolvedInput.agentId).toBe('anon');
  expect(prepared.resolvedInput.options.thinkingLevel).toBe('low'); expect(catalog.refresh).not.toHaveBeenCalled();
  changeVersion(); expect(() => service.validate(prepared, owner, 'pc', false)).not.toThrow();
});
it('invalidates a new preparation after default context changes without rebinding cwd', async () => {
  const { service, claim, changeVersion } = fixture();
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true); changeVersion();
  expect(() => service.validate(prepared, owner, 'pc', false)).toThrow(RemoteInputReason.AgentChanged);
});
it('refuses altered local assets and wrong device or identity at execution', async () => {
  const { service, claim, attach } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  expect(() => service.read('prep', owner, 'other')).toThrow(RemoteInputReason.Stale);
  expect(() => service.read('prep', { ...owner, scopeKey: 'team' }, 'pc')).toThrow(RemoteInputReason.Stale);
  writeFileSync(prepared.files[0].path, 'other');
  await expect(service.executionOptions(prepared, () => undefined)).rejects.toThrow(RemoteInputReason.Stale);
});

it('reclaims expired never-bound inputs after the delivery grace period, without a server', async () => {
  const { service, claim, attach, values } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  expect(await service.cleanupExpired(prepared.expiresAt + 60_000)).toBe(0);
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(1);
  expect(existsSync(prepared.cacheDirectory!)).toBe(false); expect(values.has('inputPreparation:prep')).toBe(false);
});
it('never removes bound task inputs, and supports expired legacy file records', async () => {
  const { service, claim, attach, values } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  service.bind(prepared, 'command');
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(0);
  expect(readFileSync(prepared.files[0].path, 'utf8')).toBe('hello');
  values.set('inputPreparation:prep', { ...prepared, boundCommandId: null, cacheDirectory: undefined });
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(1);
});
it('blocks a stale in-memory bind after cleanup claims the record and retries deletion after restart', async () => {
  const { service, deps, claim, attach, values } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const remove = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('busy'));
  const cleanup = service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000);
  expect(() => service.bind(prepared, 'command')).toThrow(RemoteInputReason.Stale);
  expect(() => service.read('prep', owner, 'pc')).toThrow(RemoteInputReason.Stale);
  expect(await cleanup).toBe(0); expect(values.get('inputPreparation:prep')).toMatchObject({ cacheCleanup: 'deleting' });
  remove.mockRestore(); warning.mockRestore();
  const restarted = new InputPreparationService(deps);
  expect(await restarted.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(1);
});
it('does not follow a symlink or remove a path outside its owned cache', async () => {
  const { service, claim, attach, values, cwd } = fixture(); attach('hello');
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
  const safeFile = path.join(cwd, 'keep.txt'); writeFileSync(safeFile, 'keep');
  rmSync(prepared.cacheDirectory!, { recursive: true }); symlinkSync(cwd, prepared.cacheDirectory!, 'dir');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(0);
    expect(readFileSync(safeFile, 'utf8')).toBe('keep');
    values.set('inputPreparation:prep', { ...prepared, cacheDirectory: cwd });
    expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(0);
    expect(readFileSync(safeFile, 'utf8')).toBe('keep');
  } finally { warning.mockRestore(); }
});
it('advances a bounded cleanup scan past live and bound records', async () => {
  const { service, claim, values } = fixture();
  const prepared = await service.prepare(owner, 'pc', claim, vi.fn(), () => true);
  values.delete('inputPreparation:prep');
  for (let i = 0; i < 55; i++) values.set(`inputPreparation:${String(i).padStart(3, '0')}`, { ...prepared, preparationId: String(i), boundCommandId: i < 50 ? 'command' : null, cacheDirectory: undefined, files: [] } as LocalPreparedInput);
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(0);
  expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(5);
  expect([...values.keys()].filter(key => key.startsWith('inputPreparation:'))).toHaveLength(50);
});

it('finishes cleanup when the cache root or account directory is already absent', async () => {
  for (const removeRoot of [false, true]) {
    const { service, deps, claim, attach, values } = fixture(); attach('hello');
    const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('hello'), () => true);
    rmSync(removeRoot ? deps.cacheRoot : path.dirname(prepared.cacheDirectory!), { recursive: true });
    expect(await service.cleanupExpired(prepared.expiresAt + 25 * 60 * 60_000)).toBe(1);
    expect(values.has('inputPreparation:prep')).toBe(false);
  }
});

it('keeps a bounded desktop thumbnail for large mobile images without persisting original image bytes', async () => {
  const { deps, claim, attach } = fixture();
  const original = 'x'.repeat(600 * 1024); attach(original, RemoteInputIntent.Image);
  claim.attachments![0].fileName = 'mobile.png';
  const preview = { mimeType: 'image/jpeg', base64Data: Buffer.from('small thumbnail').toString('base64') };
  const createImagePreview = vi.fn(async () => preview);
  const service = new InputPreparationService({ ...deps, createImagePreview });
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response(original), () => true);
  expect(JSON.stringify(prepared)).not.toContain(Buffer.from(original).toString('base64'));
  const options = await service.executionOptions(prepared, () => undefined);
  expect(options.imageAttachments[0].base64Data).toBe(Buffer.from(original).toString('base64'));
  expect(buildCoworkImageAttachmentPreviews(options.imageAttachments)).toMatchObject([{ name: 'mobile.png', mimeType: 'image/jpeg', base64Data: preview.base64Data }]);
  expect(options.prompt).toBe(' ');
  expect(createImagePreview).toHaveBeenCalledTimes(1);
});
it('adds desktop previews when executing a preparation saved by an older client', async () => {
  const { deps, service, claim, attach } = fixture(); const original = 'x'.repeat(600 * 1024); attach(original, RemoteInputIntent.Image);
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response(original), () => true);
  delete prepared.files[0].preview; // Legacy durable records predate the preview field.
  const createImagePreview = vi.fn(async () => ({ mimeType: 'image/jpeg', base64Data: 'cHJldmlldw==' }));
  const restarted = new InputPreparationService({ ...deps, createImagePreview });
  const options = await restarted.executionOptions(prepared, () => undefined);
  expect(options.imageAttachments[0].previewBase64Data).toBe('cHJldmlldw==');
  expect(createImagePreview).toHaveBeenCalledWith(prepared.files[0].imagePath);
});
it('retains visible filenames and original model images when thumbnail generation fails or exceeds its budget', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    for (const createImagePreview of [
      async () => { throw new Error('thumbnail unsupported'); },
      async () => ({ mimeType: 'image/jpeg', base64Data: Buffer.alloc(128 * 1024 + 1).toString('base64') }),
    ]) {
      const { deps, claim, attach } = fixture(); const original = 'x'.repeat(600 * 1024); attach(original, RemoteInputIntent.Image);
      claim.attachments![0].fileName = 'mobile.png';
      const service = new InputPreparationService({ ...deps, createImagePreview });
      const prepared = await service.prepare(owner, 'pc', claim, async () => new Response(original), () => true);
      const options = await service.executionOptions(prepared, () => undefined);
      expect(options.imageAttachments[0].base64Data).toBe(Buffer.from(original).toString('base64'));
      expect(options.imageAttachments[0].previewBase64Data).toBeUndefined();
      expect(options.prompt).toBe('[File: "mobile.png"]');
      expect(options.prompt).not.toContain(prepared.cacheDirectory);
    }
  } finally { warning.mockRestore(); }
});
it('rechecks the account after an asynchronous thumbnail before accepting a preparation', async () => {
  const { deps, claim, attach, setActor, values } = fixture(); attach('image', RemoteInputIntent.Image);
  const service = new InputPreparationService({ ...deps, createImagePreview: async () => {
    setActor({ userId: 'B', scopeKey: 'personal' });
    return { mimeType: 'image/jpeg', base64Data: 'cHJldmlldw==' };
  } });
  await expect(service.prepare(owner, 'pc', claim, async () => new Response('image'), () => true)).rejects.toThrow(RemoteInputReason.Account);
  expect(values.has('inputPreparation:prep')).toBe(false);
});

it('times out optional thumbnails without blocking a mobile image command', async () => {
  const { deps, service, claim, attach } = fixture(); const original = 'x'.repeat(600 * 1024); attach(original, RemoteInputIntent.Image);
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response(original), () => true);
  delete prepared.files[0].preview;
  let previewStarted!: () => void;
  const started = new Promise<void>(resolve => { previewStarted = resolve; });
  const resumed = new InputPreparationService({ ...deps, createImagePreview: async () => {
    previewStarted(); return new Promise<undefined>(() => undefined);
  } });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const executing = resumed.executionOptions(prepared, () => undefined);
    await started;
    await vi.advanceTimersByTimeAsync(750);
    const options = await executing;
    expect(options.imageAttachments).toHaveLength(1);
    expect(options.prompt).toContain('report.txt');
    expect(options.prompt).not.toContain(prepared.cacheDirectory);
  } finally { vi.useRealTimers(); }
});
it('does not swallow a revoked execution permit while a legacy thumbnail is being generated', async () => {
  const { deps, service, claim, attach } = fixture(); attach('image', RemoteInputIntent.Image);
  const prepared = await service.prepare(owner, 'pc', claim, async () => new Response('image'), () => true);
  delete prepared.files[0].preview;
  let permitted = true;
  const resumed = new InputPreparationService({ ...deps, createImagePreview: async () => {
    permitted = false; throw new Error('thumbnail failed');
  } });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await expect(resumed.executionOptions(prepared, () => { if (!permitted) throw new Error('permit revoked'); })).rejects.toThrow('permit revoked');
  } finally { warning.mockRestore(); }
});
