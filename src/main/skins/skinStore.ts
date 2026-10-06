import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  SKIN_ASSET_SLOTS,
  SKIN_REGISTRY_VERSION,
  SkinAssetExtension,
  type SkinAssetExtension as SkinAssetExtensionValue,
  SkinAssetFormat,
  SkinAssetMimeType,
  type SkinAssetMimeType as SkinAssetMimeTypeValue,
  SkinAssetSlot,
  SkinRecordStatus,
  SkinStoreErrorCode,
  SkinWorkflowKind,
} from '../../shared/skin/constants';
import {
  parseSkinPresentation,
  type SkinPresentation,
} from '../../shared/skin/presentation';
import { inspectSkinImage, SkinImageInfo } from './skinImageValidation';

export interface SkinAssetRecord extends SkinImageInfo {
  slot: SkinAssetSlot;
  relativePath: string;
  contentHash: string;
  byteLength: number;
  registeredAt: string;
}

export interface SkinRecord {
  id: string;
  name?: string;
  workflowKind: SkinWorkflowKind;
  baseThemeId?: string;
  // Optional so registries written by the released v1 skin feature remain valid.
  boundThemeId?: string;
  presentation?: SkinPresentation;
  status: SkinRecordStatus;
  assets: Partial<Record<SkinAssetSlot, SkinAssetRecord>>;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

interface SkinRegistry {
  version: number;
  activeSkinId: string | null;
  skins: Record<string, SkinRecord>;
}

export interface SkinStoreOptions {
  rootDir: string;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface CreateSkinDraftInput {
  name?: string;
  workflowKind?: SkinWorkflowKind;
  baseThemeId?: string;
  presentation?: SkinPresentation;
}

export interface RegisterSkinAssetInput {
  skinId: string;
  slot: SkinAssetSlot;
  source: string;
}

export interface ResolvedSkinProtocolAsset {
  relativePath: string;
  mimeType: SkinAssetMimeTypeValue;
  contentHash: string;
}

export interface DeleteSkinResult {
  wasActive: boolean;
}

export interface SkinAssetPolicy {
  maxBytes: number;
  minWidth: number;
  minHeight: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  minAspectRatio: number;
  maxAspectRatio: number;
}

export const SKIN_ASSET_POLICIES: Record<SkinAssetSlot, SkinAssetPolicy> = {
  [SkinAssetSlot.WorkspaceBackdrop]: {
    maxBytes: 16 * 1024 * 1024,
    minWidth: 1024,
    minHeight: 576,
    maxWidth: 8192,
    maxHeight: 8192,
    maxPixels: 32 * 1024 * 1024,
    minAspectRatio: 1.25,
    maxAspectRatio: 2.5,
  },
  [SkinAssetSlot.HomeEmblem]: {
    maxBytes: 8 * 1024 * 1024,
    minWidth: 64,
    minHeight: 64,
    maxWidth: 4096,
    maxHeight: 4096,
    maxPixels: 16 * 1024 * 1024,
    minAspectRatio: 0.25,
    maxAspectRatio: 4,
  },
};

const SKIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REGISTRY_FILE_NAME = 'registry.json';

const SLOT_FILE_PREFIX: Record<SkinAssetSlot, string> = {
  [SkinAssetSlot.WorkspaceBackdrop]: 'workspace-backdrop',
  [SkinAssetSlot.HomeEmblem]: 'home-emblem',
};

const FORMAT_EXTENSION: Record<SkinAssetFormat, SkinAssetExtensionValue> = {
  [SkinAssetFormat.Png]: SkinAssetExtension.Png,
  [SkinAssetFormat.Jpeg]: SkinAssetExtension.Jpeg,
  [SkinAssetFormat.Webp]: SkinAssetExtension.Webp,
};

const FORMAT_MIME_TYPE: Record<SkinAssetFormat, SkinAssetMimeTypeValue> = {
  [SkinAssetFormat.Png]: SkinAssetMimeType.Png,
  [SkinAssetFormat.Jpeg]: SkinAssetMimeType.Jpeg,
  [SkinAssetFormat.Webp]: SkinAssetMimeType.Webp,
};

export class SkinStoreError extends Error {
  readonly code: SkinStoreErrorCode;

  constructor(code: SkinStoreErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SkinStoreError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isSkinAssetSlot(value: unknown): value is SkinAssetSlot {
  return typeof value === 'string' && SKIN_ASSET_SLOTS.includes(value as SkinAssetSlot);
}

function isSkinAssetFormat(value: unknown): value is SkinAssetFormat {
  return Object.values(SkinAssetFormat).includes(value as SkinAssetFormat);
}

function isSkinWorkflowKind(value: unknown): value is SkinWorkflowKind {
  return Object.values(SkinWorkflowKind).includes(value as SkinWorkflowKind);
}

function isSkinRecordStatus(value: unknown): value is SkinRecordStatus {
  return Object.values(SkinRecordStatus).includes(value as SkinRecordStatus);
}

function isOptionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= maxLength);
}

function expectedRelativeAssetPath(
  skinId: string,
  slot: SkinAssetSlot,
  contentHash: string,
  extension: SkinAssetExtensionValue,
): string {
  return `${skinId}/assets/${SLOT_FILE_PREFIX[slot]}-${contentHash}.${extension}`;
}

function isValidAssetRecord(value: unknown, skinId: string, expectedSlot: SkinAssetSlot): value is SkinAssetRecord {
  if (!isRecord(value)) return false;
  if (
    value.slot !== expectedSlot ||
    !isSkinAssetFormat(value.format) ||
    typeof value.extension !== 'string' ||
    value.extension !== FORMAT_EXTENSION[value.format] ||
    value.mimeType !== FORMAT_MIME_TYPE[value.format] ||
    typeof value.contentHash !== 'string' ||
    !CONTENT_HASH_PATTERN.test(value.contentHash) ||
    typeof value.relativePath !== 'string' ||
    value.relativePath !== expectedRelativeAssetPath(skinId, expectedSlot, value.contentHash, value.extension) ||
    typeof value.byteLength !== 'number' ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    typeof value.width !== 'number' ||
    !Number.isSafeInteger(value.width) ||
    value.width <= 0 ||
    typeof value.height !== 'number' ||
    !Number.isSafeInteger(value.height) ||
    value.height <= 0 ||
    typeof value.registeredAt !== 'string'
  ) {
    return false;
  }
  return hasValidDimensions(expectedSlot, value.width, value.height) &&
    value.byteLength <= SKIN_ASSET_POLICIES[expectedSlot].maxBytes;
}

function parseSkinRecord(value: unknown, key: string): SkinRecord | null {
  if (!isRecord(value) || value.id !== key || !SKIN_ID_PATTERN.test(key)) return null;
  const presentation = value.presentation === undefined
    ? undefined
    : parseSkinPresentation(value.presentation);
  if (
    !isOptionalBoundedString(value.name, 128) ||
    !isSkinWorkflowKind(value.workflowKind) ||
    !isOptionalBoundedString(value.baseThemeId, 256) ||
    !isOptionalBoundedString(value.boundThemeId, 256) ||
    !isSkinRecordStatus(value.status) ||
    !isRecord(value.assets) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isOptionalBoundedString(value.appliedAt, 64)
    || (value.presentation !== undefined && !presentation)
  ) {
    return null;
  }

  const assets: Partial<Record<SkinAssetSlot, SkinAssetRecord>> = {};
  for (const [slot, asset] of Object.entries(value.assets)) {
    if (!isSkinAssetSlot(slot) || !isValidAssetRecord(asset, key, slot)) return null;
    assets[slot] = asset;
  }
  const ready = SKIN_ASSET_SLOTS.every(slot => Boolean(assets[slot]));
  if (value.status !== (ready ? SkinRecordStatus.Ready : SkinRecordStatus.Draft)) return null;

  return {
    id: key,
    ...(value.name === undefined ? {} : { name: value.name }),
    workflowKind: value.workflowKind,
    ...(value.baseThemeId === undefined ? {} : { baseThemeId: value.baseThemeId }),
    ...(value.boundThemeId === undefined ? {} : { boundThemeId: value.boundThemeId }),
    ...(presentation ? { presentation } : {}),
    status: value.status,
    assets,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.appliedAt === undefined ? {} : { appliedAt: value.appliedAt }),
  };
}

function parseRegistry(value: unknown): SkinRegistry | null {
  if (!isRecord(value) || value.version !== SKIN_REGISTRY_VERSION || !isRecord(value.skins)) return null;
  const activeSkinId = value.activeSkinId;
  if (activeSkinId !== null && typeof activeSkinId !== 'string') return null;
  const parsedActiveSkinId: string | null = typeof activeSkinId === 'string' ? activeSkinId : null;

  const skins: Record<string, SkinRecord> = {};
  for (const [skinId, skinValue] of Object.entries(value.skins)) {
    const skin = parseSkinRecord(skinValue, skinId);
    if (!skin) return null;
    skins[skinId] = skin;
  }
  if (parsedActiveSkinId && !skins[parsedActiveSkinId]) return null;

  return {
    version: SKIN_REGISTRY_VERSION,
    activeSkinId: parsedActiveSkinId,
    skins,
  };
}

function createEmptyRegistry(): SkinRegistry {
  return {
    version: SKIN_REGISTRY_VERSION,
    activeSkinId: null,
    skins: {},
  };
}

function cloneSkinRecord(record: SkinRecord): SkinRecord {
  return structuredClone(record);
}

function hasValidDimensions(slot: SkinAssetSlot, width: number, height: number): boolean {
  const policy = SKIN_ASSET_POLICIES[slot];
  const aspectRatio = width / height;
  return width >= policy.minWidth &&
    height >= policy.minHeight &&
    width <= policy.maxWidth &&
    height <= policy.maxHeight &&
    width * height <= policy.maxPixels &&
    aspectRatio >= policy.minAspectRatio &&
    aspectRatio <= policy.maxAspectRatio;
}

function validateDraftInput(input: CreateSkinDraftInput): SkinPresentation | undefined {
  if (!isOptionalBoundedString(input.name, 128)) {
    throw new SkinStoreError(SkinStoreErrorCode.InvalidDraft, 'Skin name must be a non-empty string of at most 128 characters');
  }
  if (!isOptionalBoundedString(input.baseThemeId, 256)) {
    throw new SkinStoreError(SkinStoreErrorCode.InvalidDraft, 'Base theme id must be a non-empty string of at most 256 characters');
  }
  if (input.workflowKind !== undefined && !isSkinWorkflowKind(input.workflowKind)) {
    throw new SkinStoreError(SkinStoreErrorCode.InvalidDraft, 'Unsupported skin workflow kind');
  }
  const presentation = input.presentation === undefined
    ? undefined
    : parseSkinPresentation(input.presentation);
  if (input.presentation !== undefined && !presentation) {
    throw new SkinStoreError(
      SkinStoreErrorCode.InvalidDraft,
      'Skin presentation must use the supported mode, palette, focus, effects, and accessible color contrast',
    );
  }
  return presentation;
}

export class SkinStore {
  readonly rootDir: string;
  private readonly registryPath: string;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: SkinStoreOptions) {
    if (!path.isAbsolute(options.rootDir)) {
      throw new SkinStoreError(SkinStoreErrorCode.UnsafeAssetPath, 'Skin root directory must be absolute');
    }
    this.rootDir = path.resolve(options.rootDir);
    this.registryPath = path.join(this.rootDir, REGISTRY_FILE_NAME);
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? randomUUID;
  }

  async createDraft(input: CreateSkinDraftInput = {}): Promise<SkinRecord> {
    const presentation = validateDraftInput(input);
    return this.enqueueMutation(async () => {
      const registry = await this.readRegistry();
      const skinId = this.idGenerator();
      if (!SKIN_ID_PATTERN.test(skinId) || registry.skins[skinId]) {
        throw new SkinStoreError(SkinStoreErrorCode.InvalidSkinId, 'Generated skin id is invalid or already exists');
      }

      const timestamp = this.now().toISOString();
      const record: SkinRecord = {
        id: skinId,
        ...(input.name === undefined ? {} : { name: input.name }),
        workflowKind: input.workflowKind ?? SkinWorkflowKind.SkinPack,
        ...(input.baseThemeId === undefined ? {} : { baseThemeId: input.baseThemeId }),
        ...(presentation ? { presentation } : {}),
        status: SkinRecordStatus.Draft,
        assets: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      registry.skins[skinId] = record;
      await this.writeRegistry(registry);
      return cloneSkinRecord(record);
    });
  }

  async registerAsset(input: RegisterSkinAssetInput): Promise<SkinAssetRecord> {
    if (!SKIN_ID_PATTERN.test(input.skinId)) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSkinId, 'Skin id is invalid');
    }
    if (!isSkinAssetSlot(input.slot)) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSlot, 'Skin asset slot is invalid');
    }

    const sourcePath = await this.resolveSourcePath(input.source);
    const policy = SKIN_ASSET_POLICIES[input.slot];
    const sourceStat = await this.getRegularSourceStat(sourcePath);
    if (sourceStat.size > policy.maxBytes) {
      throw new SkinStoreError(SkinStoreErrorCode.AssetTooLarge, 'Skin asset exceeds the slot size limit');
    }

    const data = await fs.promises.readFile(sourcePath);
    if (data.length === 0 || data.length > policy.maxBytes) {
      throw new SkinStoreError(SkinStoreErrorCode.AssetTooLarge, 'Skin asset exceeds the slot size limit');
    }
    const image = inspectSkinImage(data);
    if (!image) {
      throw new SkinStoreError(SkinStoreErrorCode.UnsupportedAssetFormat, 'Skin asset is not a valid PNG, JPEG, or WebP image');
    }
    if (!hasValidDimensions(input.slot, image.width, image.height)) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidAssetDimensions, 'Skin asset dimensions do not satisfy the slot policy');
    }

    const contentHash = createHash('sha256').update(data).digest('hex');
    const relativePath = expectedRelativeAssetPath(input.skinId, input.slot, contentHash, image.extension);
    const destinationPath = this.resolveManagedPath(relativePath);

    return this.enqueueMutation(async () => {
      const registry = await this.readRegistry();
      const skin = registry.skins[input.skinId];
      if (!skin) {
        throw new SkinStoreError(SkinStoreErrorCode.SkinNotFound, 'Skin does not exist');
      }
      if (skin.assets[input.slot]) {
        throw new SkinStoreError(SkinStoreErrorCode.SlotAlreadyRegistered, 'Skin asset slot is already registered');
      }
      if (
        input.slot === SkinAssetSlot.HomeEmblem &&
        !skin.assets[SkinAssetSlot.WorkspaceBackdrop]
      ) {
        throw new SkinStoreError(SkinStoreErrorCode.SlotOutOfOrder, 'Workspace backdrop must be registered first');
      }
      if (registry.activeSkinId === input.skinId) {
        throw new SkinStoreError(SkinStoreErrorCode.ActiveSkinImmutable, 'Deactivate the skin before changing its assets');
      }

      await this.writeContentAddressedAsset(destinationPath, data, contentHash);
      const timestamp = this.now().toISOString();
      const asset: SkinAssetRecord = {
        ...image,
        slot: input.slot,
        relativePath,
        contentHash,
        byteLength: data.length,
        registeredAt: timestamp,
      };
      skin.assets[input.slot] = asset;
      skin.status = SKIN_ASSET_SLOTS.every(slot => Boolean(skin.assets[slot]))
        ? SkinRecordStatus.Ready
        : SkinRecordStatus.Draft;
      skin.updatedAt = timestamp;
      await this.writeRegistry(registry);
      return structuredClone(asset);
    });
  }

  async apply(skinId: string, boundThemeId?: string): Promise<SkinRecord> {
    if (!SKIN_ID_PATTERN.test(skinId)) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSkinId, 'Skin id is invalid');
    }
    if (!isOptionalBoundedString(boundThemeId, 256)) {
      throw new SkinStoreError(
        SkinStoreErrorCode.InvalidThemeId,
        'Bound theme id must be a non-empty string of at most 256 characters',
      );
    }
    return this.enqueueMutation(async () => {
      const registry = await this.readRegistry();
      const skin = registry.skins[skinId];
      if (!skin) {
        throw new SkinStoreError(SkinStoreErrorCode.SkinNotFound, 'Skin does not exist');
      }
      if (skin.status !== SkinRecordStatus.Ready) {
        throw new SkinStoreError(SkinStoreErrorCode.SkinIncomplete, 'Skin is missing one or more required assets');
      }
      for (const slot of SKIN_ASSET_SLOTS) {
        const asset = skin.assets[slot];
        if (!asset || !(await this.isStoredAssetIntact(asset))) {
          throw new SkinStoreError(SkinStoreErrorCode.SkinIncomplete, 'Skin contains a missing or invalid managed asset');
        }
      }

      const timestamp = this.now().toISOString();
      registry.activeSkinId = skinId;
      if (skin.boundThemeId === undefined && boundThemeId !== undefined) {
        skin.boundThemeId = boundThemeId;
      }
      skin.appliedAt = timestamp;
      skin.updatedAt = timestamp;
      await this.writeRegistry(registry);
      return cloneSkinRecord(skin);
    });
  }

  async bindTheme(skinId: string, themeId: string): Promise<SkinRecord> {
    if (!SKIN_ID_PATTERN.test(skinId)) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSkinId, 'Skin id is invalid');
    }
    if (!isOptionalBoundedString(themeId, 256)) {
      throw new SkinStoreError(
        SkinStoreErrorCode.InvalidThemeId,
        'Bound theme id must be a non-empty string of at most 256 characters',
      );
    }

    return this.enqueueMutation(async () => {
      const registry = await this.readRegistry();
      const skin = registry.skins[skinId];
      if (!skin) {
        throw new SkinStoreError(SkinStoreErrorCode.SkinNotFound, 'Skin does not exist');
      }
      if (skin.boundThemeId !== undefined) {
        return cloneSkinRecord(skin);
      }

      skin.boundThemeId = themeId;
      skin.updatedAt = this.now().toISOString();
      await this.writeRegistry(registry);
      return cloneSkinRecord(skin);
    });
  }

  async deactivate(): Promise<void> {
    return this.enqueueMutation(async () => {
      const registry = await this.readRegistry();
      if (registry.activeSkinId === null) return;
      registry.activeSkinId = null;
      await this.writeRegistry(registry);
    });
  }

  async deleteSkin(skinId: string): Promise<DeleteSkinResult> {
    if (!SKIN_ID_PATTERN.test(skinId)) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSkinId, 'Skin id is invalid');
    }
    return this.enqueueMutation(async () => {
      const registry = await this.readRegistry();
      if (!registry.skins[skinId]) {
        throw new SkinStoreError(SkinStoreErrorCode.SkinNotFound, 'Skin does not exist');
      }

      const wasActive = registry.activeSkinId === skinId;
      if (wasActive) registry.activeSkinId = null;
      delete registry.skins[skinId];
      await this.writeRegistry(registry);

      const managedSkinDir = this.resolveManagedPath(skinId);
      try {
        await fs.promises.rm(managedSkinDir, { recursive: true, force: true });
      } catch (error) {
        console.warn(
          `[Skin] Failed to remove managed files for deleted skin "${skinId}".`,
          error,
        );
      }
      return { wasActive };
    });
  }

  async getActive(): Promise<SkinRecord | null> {
    await this.mutationQueue;
    const registry = await this.readRegistry();
    const record = registry.activeSkinId ? registry.skins[registry.activeSkinId] : undefined;
    return record ? cloneSkinRecord(record) : null;
  }

  async listSkins(): Promise<SkinRecord[]> {
    await this.mutationQueue;
    const registry = await this.readRegistry();
    return Object.values(registry.skins)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneSkinRecord);
  }

  async getSkin(skinId: string): Promise<SkinRecord | null> {
    if (!SKIN_ID_PATTERN.test(skinId)) return null;
    await this.mutationQueue;
    const registry = await this.readRegistry();
    const record = registry.skins[skinId];
    return record ? cloneSkinRecord(record) : null;
  }

  async resolveProtocolAsset(skinId: string, slot: SkinAssetSlot): Promise<ResolvedSkinProtocolAsset | null> {
    if (!SKIN_ID_PATTERN.test(skinId) || !isSkinAssetSlot(slot)) return null;
    await this.mutationQueue;
    const registry = await this.readRegistry();
    const asset = registry.skins[skinId]?.assets[slot];
    if (!asset) return null;
    return {
      relativePath: asset.relativePath,
      mimeType: asset.mimeType,
      contentHash: asset.contentHash,
    };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then((): void => undefined, (): void => undefined);
    return result;
  }

  private async readRegistry(): Promise<SkinRegistry> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.registryPath, 'utf8');
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) return createEmptyRegistry();
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidRegistry, 'Skin registry contains invalid JSON', error);
    }
    const registry = parseRegistry(parsed);
    if (!registry) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidRegistry, 'Skin registry failed schema validation');
    }
    return registry;
  }

  private async writeRegistry(registry: SkinRegistry): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    const tempPath = path.join(this.rootDir, `.${REGISTRY_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await fs.promises.rename(tempPath, this.registryPath);
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch((): void => undefined);
    }
  }

  private async resolveSourcePath(source: string): Promise<string> {
    if (typeof source !== 'string' || source.length === 0 || source.includes('\0')) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSource, 'Skin asset source is invalid');
    }
    if (path.isAbsolute(source)) return path.resolve(source);

    let sourceUrl: URL;
    try {
      sourceUrl = new URL(source);
    } catch (error) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSource, 'Skin asset source must be an absolute path or file URL', error);
    }
    if (sourceUrl.protocol !== 'file:') {
      throw new SkinStoreError(SkinStoreErrorCode.UnsupportedSourceScheme, 'Only local file URLs are supported');
    }
    if (
      (sourceUrl.hostname !== '' && sourceUrl.hostname !== 'localhost') ||
      sourceUrl.username !== '' ||
      sourceUrl.password !== '' ||
      sourceUrl.port !== '' ||
      sourceUrl.search !== '' ||
      sourceUrl.hash !== ''
    ) {
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSource, 'Skin asset file URL contains unsupported components');
    }

    try {
      const filePath = fileURLToPath(sourceUrl);
      if (!path.isAbsolute(filePath)) {
        throw new SkinStoreError(SkinStoreErrorCode.InvalidSource, 'Skin asset file URL is not absolute');
      }
      return path.resolve(filePath);
    } catch (error) {
      if (error instanceof SkinStoreError) throw error;
      throw new SkinStoreError(SkinStoreErrorCode.InvalidSource, 'Skin asset file URL is invalid', error);
    }
  }

  private async getRegularSourceStat(sourcePath: string): Promise<fs.Stats> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(sourcePath);
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) {
        throw new SkinStoreError(SkinStoreErrorCode.SourceNotFound, 'Skin asset source does not exist', error);
      }
      throw error;
    }
    if (!stat.isFile()) {
      throw new SkinStoreError(SkinStoreErrorCode.SourceNotRegularFile, 'Skin asset source must be a regular local file');
    }
    return stat;
  }

  private resolveManagedPath(relativePath: string): string {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.includes('\\') ||
      relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new SkinStoreError(SkinStoreErrorCode.UnsafeAssetPath, 'Managed skin asset path is invalid');
    }
    const resolved = path.resolve(this.rootDir, ...relativePath.split('/'));
    const relative = path.relative(this.rootDir, resolved);
    if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new SkinStoreError(SkinStoreErrorCode.UnsafeAssetPath, 'Managed skin asset path escapes the skin root');
    }
    return resolved;
  }

  private async writeContentAddressedAsset(destinationPath: string, data: Buffer, expectedHash: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
    if (await this.existingFileMatches(destinationPath, expectedHash)) return;

    const tempPath = `${destinationPath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, data, { flag: 'wx' });
      try {
        await fs.promises.link(tempPath, destinationPath);
      } catch (error) {
        if (!isNodeErrorWithCode(error, 'EEXIST') || !(await this.existingFileMatches(destinationPath, expectedHash))) {
          throw error;
        }
      }
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch((): void => undefined);
    }
  }

  private async existingFileMatches(filePath: string, expectedHash: string): Promise<boolean> {
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile()) return false;
      const hash = createHash('sha256').update(await fs.promises.readFile(filePath)).digest('hex');
      return hash === expectedHash;
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

  private async isStoredAssetIntact(asset: SkinAssetRecord): Promise<boolean> {
    const filePath = this.resolveManagedPath(asset.relativePath);
    try {
      const stat = await fs.promises.lstat(filePath);
      if (!stat.isFile() || stat.size !== asset.byteLength) return false;
      const data = await fs.promises.readFile(filePath);
      const hash = createHash('sha256').update(data).digest('hex');
      if (hash !== asset.contentHash) return false;
      const image = inspectSkinImage(data);
      return Boolean(
        image &&
        image.format === asset.format &&
        image.width === asset.width &&
        image.height === asset.height,
      );
    } catch (error) {
      if (isNodeErrorWithCode(error, 'ENOENT')) return false;
      throw error;
    }
  }

}
