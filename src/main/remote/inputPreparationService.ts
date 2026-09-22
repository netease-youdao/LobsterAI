import { createHash, randomUUID } from 'crypto';
import { constants, createReadStream, promises as fs, realpathSync, statSync } from 'fs';
import path from 'path';

import { AgentId } from '../../shared/agent/constants';
import { COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES, type CoworkImageAttachmentPayload, estimateBase64DecodedBytes } from '../../shared/cowork/imageAttachments';
import { REMOTE_TEXT_BYTES, type RemoteOwner } from '../../shared/remote/constants';
import { RemoteInputIntent, RemoteInputMode, RemoteInputReason, type RemotePreparationClaim, type RemoteResolvedInput } from '../../shared/remote/input';
import type { CoworkStore } from '../coworkStore';
import { payloadHash, sameOwner } from './canonical';
import type { RemoteAgentCatalog } from './remoteAgentCatalog';
import { RemoteInputError, type RemoteModelCatalog } from './remoteModelCatalog';

interface FileIdentity { realPath: string; dev: string; ino: string; size: number; mtimeMs: number }
interface InputImagePreview { mimeType: string; base64Data: string }
interface LocalAsset { preview?: InputImagePreview | null; assetId: string; version: string; path: string; identity: FileIdentity; imagePath?: string; imageIdentity?: FileIdentity; imageMime?: string }
export interface LocalPreparedInput {
  preparationId: string; owner: RemoteOwner; deviceId: string; requestHash: string; inputDigest: string;
  targetId?: string;
  resolvedInput: RemoteResolvedInput; cwd: string; directoryIdentity: FileIdentity; runtimeRef: string;
  sessionId: string | null; expectedInputVersion: string | null; expectedControlVersion: string | null;
  files: LocalAsset[]; createdAt: number; expiresAt: number; boundCommandId: string | null;
  cacheDirectory?: string; cacheCleanup?: 'deleting';
}
interface Dependencies {
  store: CoworkStore; models: RemoteModelCatalog; cacheRoot: string; getOwner(): RemoteOwner | null;
  getTargetId?(): string | null;
  getDefaultModel(): string; getAgentCatalog(): RemoteAgentCatalog | null;
  createImagePreview?(filePath: string): Promise<InputImagePreview | undefined>;
  convertImage?(filePath: string, mimeType: string, targetPath: string): Promise<{ path: string; mimeType: string }>;
}
const maxPreviewBytes = 128 * 1024;
const previewTimeoutMs = 750;
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const maxFileBytes = 100 * 1024 * 1024;
const maxTotalBytes = 256 * 1024 * 1024;
const imageFrameBytes = 29_500_000 - 64 * 1024;
const identity = (filePath: string): FileIdentity => {
  const value = statSync(filePath);
  return { realPath: realpathSync(filePath), dev: String(value.dev), ino: String(value.ino), size: value.size, mtimeMs: value.mtimeMs };
};
const sameFile = (filePath: string, expected: FileIdentity, directory = false): boolean => {
  try {
    const actual = identity(filePath);
    return actual.realPath === expected.realPath && actual.dev === expected.dev && actual.ino === expected.ino
      && (directory ? statSync(filePath).isDirectory() : statSync(filePath).isFile() && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs);
  } catch { return false; }
};
const hashFile = async (filePath: string, check: () => void): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) { check(); hash.update(chunk); }
  check(); return hash.digest('hex');
};

/** No runtime mutation occurs here. An immutable local manifest is required again at dispatch. */
export class InputPreparationService {
  private operationEpoch = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupRunning = false;
  private cleanupCursor = '';
  constructor(private readonly deps: Dependencies) {}
  reset(): void { this.operationEpoch++; }
  startCleanup(): void {
    if (this.cleanupTimer) return;
    const run = (): void => { void this.cleanupExpired().catch(() => console.warn('[RemoteInput] Cache cleanup deferred')); };
    this.cleanupTimer = setInterval(run, 60_000); this.cleanupTimer.unref?.(); run();
  }
  stopCleanup(): void { if (this.cleanupTimer) clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  /** Remote command lifetimes are <=60s. Keep unbound ready files a further day so a
   * previously accepted command cannot lose its input while waiting for delivery. */
  async cleanupExpired(now = Date.now()): Promise<number> {
    if (this.cleanupRunning) return 0;
    this.cleanupRunning = true;
    let removed = 0;
    try {
      const rows = this.deps.store.remote.entries<LocalPreparedInput>('inputPreparation:', this.cleanupCursor, 50);
      for (const row of rows) {
        this.cleanupCursor = row.key;
        const current = this.deps.store.remote.get<LocalPreparedInput>(row.key);
        if (!current || current.boundCommandId || !Number.isFinite(current.expiresAt) || current.expiresAt > now - 24 * 60 * 60_000) continue;
        // Claim synchronously before filesystem awaits; bind/read reject this durable marker.
        this.deps.store.remote.put(row.key, { ...current, cacheCleanup: 'deleting' });
        try {
          const folder = await this.cleanupDirectory(current);
          if (folder) await fs.rm(folder, { recursive: true, force: true });
          this.deps.store.remote.remove(row.key); removed++;
        } catch { console.warn('[RemoteInput] Expired input retained for cleanup retry'); }
      }
      if (rows.length < 50) this.cleanupCursor = '';
      return removed;
    } finally { this.cleanupRunning = false; }
  }
  private async cleanupDirectory(prepared: LocalPreparedInput): Promise<string | null> {
    const paths = prepared.files.flatMap(file => [file.path, ...(file.imagePath ? [file.imagePath] : [])]);
    const folder = prepared.cacheDirectory || (paths.length ? path.dirname(paths[0]) : null);
    if (!folder) return null; // Old text-only records did not retain their empty directory.
    const root = path.resolve(this.deps.cacheRoot);
    const parent = path.join(root, payloadHash([prepared.owner.userId, prepared.owner.scopeKey, prepared.deviceId]));
    if (path.dirname(path.resolve(folder)) !== parent || !/^[0-9a-f-]{36}$/iu.test(path.basename(folder))
      || paths.some(file => path.dirname(path.resolve(file)) !== path.resolve(folder))) throw new Error('Unsafe input cache directory');
    // Refuse symlinked owner/directory components. rm must never traverse into user files.
    try {
      const rootReal = await fs.realpath(root);
      const parentInfo = await fs.lstat(parent);
      if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory() || await fs.realpath(parent) !== path.join(rootReal, path.basename(parent))) throw new Error('Unsafe input cache parent');
      const info = await fs.lstat(folder);
      if (info.isSymbolicLink() || !info.isDirectory() || await fs.realpath(folder) !== path.join(rootReal, path.basename(parent), path.basename(folder))) throw new Error('Unsafe input cache directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return folder;
  }
  private async imagePreview(filePath: string, check: () => void): Promise<InputImagePreview | undefined> {
    if (!this.deps.createImagePreview) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let preview: InputImagePreview | undefined;
    try {
      preview = await Promise.race([
        this.deps.createImagePreview(filePath),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), previewTimeoutMs); }),
      ]);
    } catch {
      console.warn('[RemoteInput] Image preview unavailable; retaining file attachment');
    } finally { if (timer) clearTimeout(timer); }
    check(); // A failed preview must not swallow a revoked execution/account permit.
    if (!preview || !imageMimes.has(preview.mimeType) || !preview.base64Data
      || preview.base64Data.length > 4 * Math.ceil(maxPreviewBytes / 3)
      || estimateBase64DecodedBytes(preview.base64Data) > maxPreviewBytes) return undefined;
    return preview;
  }
  private targetId(): string | undefined {
    const targetId = this.deps.getTargetId?.();
    if (this.deps.getTargetId && !targetId) throw new RemoteInputError(RemoteInputReason.Stale);
    return targetId ?? undefined;
  }
  private key(id: string): string { return `inputPreparation:${this.deps.getTargetId ? JSON.stringify([this.targetId(), id]) : id}`; }
  private assertTarget(prepared: LocalPreparedInput): void {
    if (prepared.targetId !== this.targetId()) throw new RemoteInputError(RemoteInputReason.Stale);
  }
  private assertOwner(owner: RemoteOwner, current: () => boolean): void {
    if (!sameOwner(owner, this.deps.getOwner()) || !current()) throw new RemoteInputError(RemoteInputReason.Account);
  }
  private sessionInputVersion(sessionId: string): string { return this.deps.store.remote.inputVersion(sessionId); }
  async prepare(owner: RemoteOwner, deviceId: string, claim: RemotePreparationClaim,
    download: (assetId: string) => Promise<Response>, current: () => boolean): Promise<LocalPreparedInput> {
    const targetId = this.targetId(), epoch = this.operationEpoch;
    const check = (): void => this.assertOwner(owner, () => current() && this.deps.getTargetId?.() === targetId && this.operationEpoch === epoch);
    check();
    const request = claim.request;
    if (request.inputSchemaVersion !== 2 || request.preparationId !== claim.preparationId) throw new RemoteInputError(RemoteInputReason.Invalid);
    const previous = this.deps.store.remote.get<LocalPreparedInput>(this.key(claim.preparationId));
    if (previous) {
      if (previous.requestHash !== payloadHash(request) || previous.deviceId !== deviceId || !sameOwner(previous.owner, owner)) throw new RemoteInputError(RemoteInputReason.Stale);
      this.validate(previous, owner, deviceId, false);
      await this.validateFiles(previous, check);
      check();
      return previous;
    }
    const store = this.deps.store;
    const continuation = request.purpose === 'send_message';
    const sessionId = continuation ? store.remote.localSessionId(request.sessionId || '') : null;
    const session = sessionId ? store.getSession(sessionId, 0) : null;
    if (continuation && (!session || !sameOwner(store.remote.owner(session.id), owner))) throw new RemoteInputError(RemoteInputReason.Account);
    if (session && (request.expectedInputVersion !== this.sessionInputVersion(session.id) || request.expectedControlVersion !== store.remote.controlVersion(session.id))) throw new RemoteInputError(RemoteInputReason.Version);
    const agentId = session?.agentId || request.input.agent?.agentId || AgentId.Main;
    store.assertAgentAccess(agentId, owner);
    const agent = store.getAgent(agentId);
    const ownership = store.agentOwnership.get(agentId);
    if (!agent?.enabled || !ownership || (!continuation && !store.agentOwnership.canPublish(agentId, owner))) throw new RemoteInputError(RemoteInputReason.AgentUnavailable);
    if (!continuation && request.input.agent?.expectedVersion !== ownership.version) throw new RemoteInputError(RemoteInputReason.AgentChanged);
    let workspaceId = session ? store.remote.get<string>(`workspace:${session.id}`) : null;
    let cwd = session?.cwd || '';
    if (!session) {
      const catalog = this.deps.getAgentCatalog();
      const items = await catalog?.refresh(owner, deviceId, current);
      check();
      const item = items?.find(value => value.agentId === agentId);
      if (!item || item.version !== request.input.agent?.expectedVersion || !item.workspaceAvailable || !item.defaultWorkspaceId) throw new RemoteInputError(RemoteInputReason.AgentChanged);
      workspaceId = item.defaultWorkspaceId;
      cwd = catalog!.resolve(owner, deviceId, agentId, item.version, workspaceId);
    }
    await fs.access(cwd, constants.R_OK | constants.W_OK); check();
    if (!statSync(cwd).isDirectory()) throw new RemoteInputError(RemoteInputReason.Workspace);
    const directoryIdentity = identity(cwd);
    const mode = request.input.model.mode;
    if ((!continuation && mode === RemoteInputMode.Session) || !Object.values(RemoteInputMode).includes(mode)) throw new RemoteInputError(RemoteInputReason.Invalid);
    const model = mode === RemoteInputMode.Selected
      ? this.deps.models.resolve(owner, deviceId, request.input.model.modelRef || '', request.input.model.expectedVersion || '')
      : this.deps.models.resolveRuntime(owner, deviceId, mode === RemoteInputMode.Session
        ? session?.modelOverride || agent.model || this.deps.getDefaultModel() : agent.model || this.deps.getDefaultModel());
    const inheritedThinking = mode === RemoteInputMode.Session ? session?.thinkingLevel : mode === RemoteInputMode.Agent ? agent.thinkingLevel : undefined;
    const thinkingLevel = request.input.options?.thinkingLevel ?? (inheritedThinking || model.item.thinking.default);
    if (thinkingLevel && !model.item.thinking.options.includes(thinkingLevel)) throw new RemoteInputError(RemoteInputReason.Invalid);
    const text = request.input.text || '';
    const requestedAssets = request.input.attachments || [];
    if ((!text.trim() && !requestedAssets.length) || Buffer.byteLength(text) > REMOTE_TEXT_BYTES || requestedAssets.length > 20) throw new RemoteInputError(RemoteInputReason.Invalid);
    const attachments = requestedAssets.map(ref => {
      const asset = claim.attachments?.find(value => value.assetId === ref.assetId && value.version === ref.version);
      if (!asset || asset.intent !== ref.intent || !/^[a-f0-9]{64}$/u.test(asset.sha256) || !/^\d+$/u.test(asset.sizeBytes)) throw new RemoteInputError(RemoteInputReason.Asset);
      const size = Number(asset.sizeBytes);
      if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes || ref.kind !== 'uploaded_asset') throw new RemoteInputError(RemoteInputReason.Invalid);
      if (asset.intent === RemoteInputIntent.Image && !model.item.inputCapabilities.image) throw new RemoteInputError(RemoteInputReason.Invalid);
      return { assetId: asset.assetId, version: asset.version, intent: asset.intent, sha256: asset.sha256, sizeBytes: asset.sizeBytes,
        mimeType: asset.mimeType, fileName: asset.fileName };
    });
    if (attachments.reduce((total, value) => total + Number(value.sizeBytes), 0) > maxTotalBytes) throw new RemoteInputError(RemoteInputReason.Invalid);
    const resolvedInput: RemoteResolvedInput = { text, agentId, expectedAgentVersion: ownership.version, workspaceId,
      model: { modelRef: model.item.modelRef, version: model.item.version }, options: thinkingLevel ? { thinkingLevel } : {}, attachments };
    const folder = path.join(this.deps.cacheRoot, payloadHash([owner.userId, owner.scopeKey, deviceId]), randomUUID());
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const files: LocalAsset[] = [];
    let frameBytes = 0;
    try {
      check();
      for (const asset of attachments) {
        check();
        const extension = path.extname(asset.fileName).replace(/[^.a-zA-Z0-9]/gu, '').slice(0, 12);
        const filePath = path.join(folder, `${randomUUID()}${extension}`);
        const temporary = `${filePath}.part`;
        const response = await download(asset.assetId); check();
        if (response.status !== 200 || !response.body) throw new RemoteInputError(RemoteInputReason.Asset);
        const handle = await fs.open(temporary, 'wx', 0o600);
        let count = 0; const hash = createHash('sha256');
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            check(); count += chunk.byteLength;
            if (count > Number(asset.sizeBytes)) throw new RemoteInputError(RemoteInputReason.Asset);
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
              const written = await handle.write(chunk, offset, chunk.byteLength - offset);
              if (!written.bytesWritten) throw new RemoteInputError(RemoteInputReason.Asset);
              offset += written.bytesWritten; check();
            }
          }
          if (count !== Number(asset.sizeBytes) || hash.digest('hex') !== asset.sha256) throw new RemoteInputError(RemoteInputReason.Asset);
          await handle.sync();
        } finally { await handle.close(); }
        check(); await fs.rename(temporary, filePath); check();
        const file: LocalAsset = { assetId: asset.assetId, version: asset.version, path: filePath, identity: identity(filePath) };
        if (asset.intent === RemoteInputIntent.Image) {
          let image = { path: filePath, mimeType: asset.mimeType };
          if (this.deps.convertImage) {
            image = await this.deps.convertImage(filePath, asset.mimeType, path.join(folder, `${randomUUID()}.png`)); check();
          }
          if (!imageMimes.has(image.mimeType)) throw new RemoteInputError(RemoteInputReason.Invalid);
          file.imagePath = image.path; file.imageMime = image.mimeType; file.imageIdentity = identity(image.path);
          file.preview = await this.imagePreview(image.path, check) || null;
          frameBytes += 4 * Math.ceil(file.imageIdentity.size / 3);
          if (frameBytes > imageFrameBytes) throw new RemoteInputError(RemoteInputReason.Invalid);
        }
        files.push(file);
      }
      check();
      const prepared: LocalPreparedInput = { preparationId: claim.preparationId, owner, deviceId, requestHash: payloadHash(request),
        ...(targetId ? { targetId } : {}),
        inputDigest: payloadHash(resolvedInput), resolvedInput, cwd, directoryIdentity, runtimeRef: model.local.runtimeRef,
        sessionId: session?.id || null, expectedInputVersion: request.expectedInputVersion || null, expectedControlVersion: request.expectedControlVersion || null,
        files, cacheDirectory: folder, createdAt: Date.now(), expiresAt: Math.min(Date.now() + 15 * 60_000, claim.expiresAt ? Date.parse(claim.expiresAt) : Infinity), boundCommandId: null };
      this.validate(prepared, owner, deviceId, false);
      this.deps.store.remote.put(this.key(claim.preparationId), prepared);
      return prepared;
    } catch (error) { await fs.rm(folder, { recursive: true, force: true }); throw error; }
  }
  read(id: string, owner: RemoteOwner, deviceId: string): LocalPreparedInput {
    const prepared = this.deps.store.remote.get<LocalPreparedInput>(this.key(id));
    if (!prepared || prepared.cacheCleanup || !sameOwner(prepared.owner, owner) || prepared.deviceId !== deviceId) throw new RemoteInputError(RemoteInputReason.Stale);
    this.assertTarget(prepared);
    return prepared;
  }
  validate(prepared: LocalPreparedInput, owner: RemoteOwner, deviceId: string, bound: boolean): void {
    this.assertTarget(prepared);
    if (prepared.cacheCleanup || !sameOwner(prepared.owner, owner) || !sameOwner(owner, this.deps.getOwner()) || prepared.deviceId !== deviceId
      || (!bound && prepared.expiresAt <= Date.now()) || payloadHash(prepared.resolvedInput) !== prepared.inputDigest) throw new RemoteInputError(RemoteInputReason.Stale);
    const input = prepared.resolvedInput;
    const model = this.deps.models.resolve(owner, deviceId, input.model.modelRef, input.model.version);
    if (model.local.runtimeRef !== prepared.runtimeRef) throw new RemoteInputError(RemoteInputReason.ModelChanged);
    this.deps.store.assertAgentAccess(input.agentId, owner);
    if (!this.deps.store.getAgent(input.agentId)?.enabled) throw new RemoteInputError(RemoteInputReason.AgentUnavailable);
    if (!bound && !prepared.sessionId && this.deps.store.agentOwnership.get(input.agentId)?.version !== input.expectedAgentVersion) throw new RemoteInputError(RemoteInputReason.AgentChanged);
    if (prepared.sessionId) {
      const session = this.deps.store.getSession(prepared.sessionId, 0);
      if (!session || !sameOwner(this.deps.store.remote.owner(session.id), owner) || session.cwd !== prepared.cwd || session.agentId !== input.agentId) throw new RemoteInputError(RemoteInputReason.Stale);
      if (!bound && (this.sessionInputVersion(session.id) !== prepared.expectedInputVersion || this.deps.store.remote.controlVersion(session.id) !== prepared.expectedControlVersion)) throw new RemoteInputError(RemoteInputReason.Version);
    }
    if (!sameFile(prepared.cwd, prepared.directoryIdentity, true)) throw new RemoteInputError(RemoteInputReason.Workspace);
    for (const file of prepared.files) if (!sameFile(file.path, file.identity) || file.imagePath && !sameFile(file.imagePath, file.imageIdentity!)) throw new RemoteInputError(RemoteInputReason.Stale);
  }
  bind(prepared: LocalPreparedInput, commandId: string): void {
    this.assertTarget(prepared);
    const current = this.deps.store.remote.get<LocalPreparedInput>(this.key(prepared.preparationId));
    if (!current || current.cacheCleanup || current.requestHash !== prepared.requestHash || !sameOwner(current.owner, prepared.owner)
      || current.targetId !== prepared.targetId || current.deviceId !== prepared.deviceId
      || current.boundCommandId && current.boundCommandId !== commandId) throw new RemoteInputError(RemoteInputReason.Stale);
    Object.assign(prepared, current, { boundCommandId: commandId }); this.deps.store.remote.put(this.key(prepared.preparationId), prepared);
  }
  confirmReady(id: string, owner: RemoteOwner, deviceId: string, expiresAt: string): void {
    const prepared = this.read(id, owner, deviceId);
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) throw new RemoteInputError(RemoteInputReason.Stale);
    prepared.expiresAt = Math.min(prepared.expiresAt, expiry);
    this.deps.store.remote.put(this.key(id), prepared);
  }
  private async validateFiles(prepared: LocalPreparedInput, check: () => void): Promise<void> {
    for (const file of prepared.files) {
      const asset = prepared.resolvedInput.attachments.find(value => value.assetId === file.assetId && value.version === file.version)!;
      if (!sameFile(file.path, file.identity) || await hashFile(file.path, check) !== asset.sha256 || !sameFile(file.path, file.identity)) throw new RemoteInputError(RemoteInputReason.Stale);
    }
  }
  async executionOptions(prepared: LocalPreparedInput, check: () => void): Promise<{ prompt: string; modelOverride: string; thinkingLevel?: string; imageAttachments: CoworkImageAttachmentPayload[] }> {
    const checkCurrent = check, epoch = this.operationEpoch;
    check = () => {
      this.assertTarget(prepared);
      if (epoch !== this.operationEpoch) throw new RemoteInputError(RemoteInputReason.Stale);
      checkCurrent();
    };
    check();
    await this.validateFiles(prepared, check);
    check();
    const imageAttachments: CoworkImageAttachmentPayload[] = [];
    const references: string[] = [];
    for (const file of prepared.files) {
      check();
      const asset = prepared.resolvedInput.attachments.find(value => value.assetId === file.assetId)!;
      if (asset.intent === RemoteInputIntent.Image) {
        if (!sameFile(file.imagePath!, file.imageIdentity!)) throw new RemoteInputError(RemoteInputReason.Stale);
        const data = await fs.readFile(file.imagePath!); check();
        if (!sameFile(file.imagePath!, file.imageIdentity!)) throw new RemoteInputError(RemoteInputReason.Stale);
        // Preparations saved before preview support can still produce a desktop thumbnail.
        const preview = file.preview === undefined ? await this.imagePreview(file.imagePath!, check) : file.preview;
        check();
        if (!sameFile(file.imagePath!, file.imageIdentity!)) throw new RemoteInputError(RemoteInputReason.Stale);
        imageAttachments.push({ name: asset.fileName, mimeType: file.imageMime!, base64Data: data.toString('base64'), sizeBytes: data.length, localPath: file.path,
          ...(preview ? { previewBase64Data: preview.base64Data, previewMimeType: preview.mimeType } : {}) });
        // Large images without a thumbnail are omitted by the shared preview builder.
        // Keep a visible filename while sending the original image to the model.
        if (!preview && data.length > COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES) references.push(`[File: ${JSON.stringify(asset.fileName)}]`);
      } else references.push(`[File: ${JSON.stringify(asset.fileName)}] ${JSON.stringify(file.path)}`);
    }
    return { prompt: [prepared.resolvedInput.text, ...references].filter(Boolean).join('\n\n') || ' ', modelOverride: prepared.runtimeRef,
      ...(prepared.resolvedInput.options.thinkingLevel ? { thinkingLevel: prepared.resolvedInput.options.thinkingLevel } : {}), imageAttachments };
  }
}
