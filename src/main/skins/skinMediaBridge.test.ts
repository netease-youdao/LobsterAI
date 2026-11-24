import { describe, expect, test, vi } from 'vitest';

import type { InstalledKitRecord } from '../../shared/kit/constants';
import {
  SkinAssetExtension,
  SkinAssetFormat,
  SkinAssetMimeType,
  SkinAssetSlot,
  SkinRecordStatus,
  SkinToolAction,
  SkinWorkflowKind,
} from '../../shared/skin/constants';
import { SkinPackKitId } from '../../shared/skin/kit';
import { MediaSelectionMode } from '../mediaGenerationPolicy';
import {
  MediaAttachmentKind,
  type MediaAttachmentRefMain,
} from '../mediaGenerationReferences';
import { SkinMediaBridge } from './skinMediaBridge';
import type { SkinAssetRecord, SkinRecord, SkinStore } from './skinStore';
import { SkinWorkflowRegistry } from './skinWorkflowRegistry';

const timestamp = '2026-07-16T10:00:00.000Z';
const sessionId = 'session-one';
const sessionKey = 'agent:main:lobsterai:session-one';
const context = { sessionKey, toolCallId: 'tool-call-one' };

const installedKit: InstalledKitRecord = {
  id: SkinPackKitId.BuiltIn,
  version: '0.1.0',
  installedAt: 1,
  workflowKind: SkinWorkflowKind.SkinPack,
  skills: null,
  mcpServers: [],
  connectors: [],
};

const createAsset = (slot: SkinAssetSlot): SkinAssetRecord => ({
  slot,
  format: SkinAssetFormat.Png,
  extension: SkinAssetExtension.Png,
  mimeType: SkinAssetMimeType.Png,
  width: slot === SkinAssetSlot.WorkspaceBackdrop ? 1600 : 256,
  height: slot === SkinAssetSlot.WorkspaceBackdrop ? 900 : 256,
  relativePath: `skin-one/assets/${slot}.png`,
  contentHash: (slot === SkinAssetSlot.WorkspaceBackdrop ? 'a' : 'b').repeat(64),
  byteLength: 1024,
  registeredAt: timestamp,
});

const createHarness = (mediaRefsBySession: Record<string, MediaAttachmentRefMain[]> = {}) => {
  let current: SkinRecord = {
    id: 'skin-one',
    workflowKind: SkinWorkflowKind.SkinPack,
    status: SkinRecordStatus.Draft,
    assets: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const store = {
    createDraft: vi.fn(async () => current),
    registerAsset: vi.fn(async ({ slot }: { slot: SkinAssetSlot }) => {
      const asset = createAsset(slot);
      current = {
        ...current,
        status: SkinRecordStatus.Ready,
        assets: { ...current.assets, [slot]: asset },
      };
      return asset;
    }),
    registerAssetBuffer: vi.fn(async ({ slot }: { slot: SkinAssetSlot }) => {
      const asset = createAsset(slot);
      current = {
        ...current,
        status: SkinRecordStatus.Ready,
        assets: { ...current.assets, [slot]: asset },
      };
      return asset;
    }),
    getSkin: vi.fn(async () => current),
    apply: vi.fn(async () => current),
    deactivate: vi.fn(async () => undefined),
  } as unknown as SkinStore;
  const workflowRegistry = new SkinWorkflowRegistry({
    getInstalledKits: () => ({ [SkinPackKitId.BuiltIn]: installedKit }),
    getParentSessionId: () => null,
  });
  const selection = { mode: MediaSelectionMode.Image };
  workflowRegistry.prepareTurn({
    sessionId,
    kitIds: [SkinPackKitId.BuiltIn],
    mediaGenerationEntitled: true,
    mediaSelection: selection,
  });
  const bridge = new SkinMediaBridge({
    store,
    workflowRegistry,
    resolveSessionId: key => key === sessionKey ? sessionId : null,
    resolveMediaSelection: () => selection,
    resolveMediaReferences: id => (id ? mediaRefsBySession[id] : undefined),
  });
  return { bridge, store, workflowRegistry };
};

describe('skin media bridge', () => {
  test('requires a draft, allows generation retries, and leaves slot order to the store', async () => {
    const { bridge, store } = createHarness();

    expect(await bridge.preflightLobsterImageGeneration(
      sessionId,
      { mode: MediaSelectionMode.Image },
    )).toMatchObject({
      isError: true,
      details: { code: 'draft_required' },
    });

    const createResult = await bridge.handleToolRequest({
      args: { action: SkinToolAction.CreateDraft },
      context,
    });
    expect(createResult.isError).not.toBe(true);

    expect(await bridge.preflightLobsterImageGeneration(
      sessionId,
      { mode: MediaSelectionMode.Image },
    )).toBeNull();
    expect(await bridge.preflightLobsterImageGeneration(
      sessionId,
      { mode: MediaSelectionMode.Image },
    )).toBeNull();

    await bridge.handleToolRequest({
      args: {
        action: SkinToolAction.RegisterAsset,
        skinId: 'skin-one',
        slot: SkinAssetSlot.WorkspaceBackdrop,
        sourcePath: 'C:\\generated\\backdrop.png',
      },
      context,
    });
    expect(await bridge.preflightLobsterImageGeneration(
      sessionId,
      { mode: MediaSelectionMode.Image },
    )).toBeNull();
    expect(store.registerAsset).toHaveBeenCalledTimes(1);
  });

  test('clears the owning workflow only after a successful apply', async () => {
    const { bridge, workflowRegistry } = createHarness();
    await bridge.handleToolRequest({
      args: { action: SkinToolAction.CreateDraft },
      context,
    });

    const result = await bridge.handleToolRequest({
      args: { action: SkinToolAction.Apply, skinId: 'skin-one' },
      context,
    });

    expect(result.isError).not.toBe(true);
    expect(workflowRegistry.resolve(sessionId)).toBeUndefined();
  });

  test('resolves attached image tokens from localPath or inline dataUrl for direct skin registration', async () => {
    const pastedBytes = Buffer.from([1, 2, 3, 4]);
    const { bridge, store } = createHarness({
      [sessionId]: [
        {
          token: '@图片1',
          mediaType: MediaAttachmentKind.Image,
          index: 1,
          fileId: '/uploads/wow.jpg',
          fileName: 'wow.jpg',
          mimeType: 'image/jpeg',
          localPath: '/uploads/wow.jpg',
        },
        {
          token: '@图片2',
          mediaType: MediaAttachmentKind.Image,
          index: 2,
          fileId: 'inline:pasted-1',
          fileName: 'pasted.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${pastedBytes.toString('base64')}`,
        },
      ],
    });

    await bridge.handleToolRequest({
      args: { action: SkinToolAction.CreateDraft },
      context,
    });

    const fileResult = await bridge.handleToolRequest({
      args: {
        action: SkinToolAction.RegisterAsset,
        skinId: 'skin-one',
        slot: SkinAssetSlot.WorkspaceBackdrop,
        sourcePath: '@图片1',
      },
      context,
    });
    expect(fileResult.isError).not.toBe(true);
    expect(store.registerAsset).toHaveBeenCalledWith({
      skinId: 'skin-one',
      slot: SkinAssetSlot.WorkspaceBackdrop,
      source: '/uploads/wow.jpg',
    });

    const pastedResult = await bridge.handleToolRequest({
      args: {
        action: SkinToolAction.RegisterAsset,
        skinId: 'skin-one',
        slot: SkinAssetSlot.HomeEmblem,
        sourcePath: '@图片2',
      },
      context,
    });
    expect(pastedResult.isError).not.toBe(true);
    expect(store.registerAssetBuffer).toHaveBeenCalledWith({
      skinId: 'skin-one',
      slot: SkinAssetSlot.HomeEmblem,
      data: pastedBytes,
    });
  });
});
