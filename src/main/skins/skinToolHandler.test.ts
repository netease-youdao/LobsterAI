import { describe, expect, test, vi } from 'vitest';

import {
  SkinAssetExtension,
  SkinAssetFormat,
  SkinAssetMimeType,
  SkinAssetSlot,
  SkinParticleDensity,
  SkinPreferredAppearance,
  SkinPresentationMode,
  SkinRecordStatus,
  SkinStoreErrorCode,
  SkinToolAction,
  SkinWorkflowKind,
} from '../../shared/skin/constants';
import type { SkinPresentation } from '../../shared/skin/presentation';
import type { SkinAssetRecord, SkinRecord, SkinStore } from './skinStore';
import { createSkinToolHandler } from './skinToolHandler';

const timestamp = '2026-07-16T10:00:00.000Z';

const presentation: SkinPresentation = {
  mode: SkinPresentationMode.ImmersiveShell,
  preferredAppearance: SkinPreferredAppearance.Dark,
  palette: {
    canvas: '#12090b',
    panel: '#1d0d10',
    panelRaised: '#2a1216',
    accent: '#e5b941',
    accentForeground: '#160b0d',
    accentAlt: '#d85a45',
    foreground: '#f7eee8',
    muted: '#c7aaa5',
    border: '#745126',
  },
  art: { focusX: 0.72, focusY: 0.42 },
  effects: { particleDensity: SkinParticleDensity.Sparse },
};

const createAsset = (slot: SkinAssetSlot, hashChar: string): SkinAssetRecord => ({
  slot,
  format: SkinAssetFormat.Png,
  extension: SkinAssetExtension.Png,
  mimeType: SkinAssetMimeType.Png,
  width: slot === SkinAssetSlot.WorkspaceBackdrop ? 1600 : 256,
  height: slot === SkinAssetSlot.WorkspaceBackdrop ? 900 : 256,
  relativePath: `skin-one/assets/${slot}.png`,
  contentHash: hashChar.repeat(64),
  byteLength: 1024,
  registeredAt: timestamp,
});

const backdrop = createAsset(SkinAssetSlot.WorkspaceBackdrop, 'a');
const emblem = createAsset(SkinAssetSlot.HomeEmblem, 'b');

const draft: SkinRecord = {
  id: 'skin-one',
  name: 'Ocean glass',
  workflowKind: SkinWorkflowKind.SkinPack,
  baseThemeId: 'classic-dark',
  presentation,
  status: SkinRecordStatus.Draft,
  assets: {},
  createdAt: timestamp,
  updatedAt: timestamp,
};

const ready: SkinRecord = {
  ...draft,
  status: SkinRecordStatus.Ready,
  assets: {
    [SkinAssetSlot.WorkspaceBackdrop]: backdrop,
    [SkinAssetSlot.HomeEmblem]: emblem,
  },
};

const createStoreDouble = () => ({
  createDraft: vi.fn(async () => draft),
  registerAsset: vi.fn(async () => backdrop),
  registerAssetBuffer: vi.fn(async () => backdrop),
  getSkin: vi.fn(async () => ready),
  apply: vi.fn(async () => ready),
  deactivate: vi.fn(async () => undefined),
}) as unknown as SkinStore;

const context = {
  sessionKey: 'agent:main:lobsterai:test-session',
  toolCallId: 'tool-call-one',
};

describe('skin tool handler', () => {
  test('rejects calls outside a trusted skin workflow', async () => {
    const store = createStoreDouble();
    const handler = createSkinToolHandler({
      store,
      isWorkflowAllowed: () => false,
    });

    const result = await handler({
      args: { action: SkinToolAction.CreateDraft },
      context,
    });

    expect(result).toMatchObject({
      isError: true,
      details: { code: 'workflow_not_allowed' },
    });
    expect(store.createDraft).not.toHaveBeenCalled();
  });

  test('creates, registers, presents, and applies a managed skin', async () => {
    const store = createStoreDouble();
    const onChanged = vi.fn();
    const handler = createSkinToolHandler({
      store,
      isWorkflowAllowed: () => true,
      onChanged,
    });

    const createResult = await handler({
      args: {
        action: SkinToolAction.CreateDraft,
        name: draft.name,
        baseThemeId: draft.baseThemeId,
        presentation,
      },
      context,
    });
    expect(store.createDraft).toHaveBeenCalledWith({
      name: draft.name,
      baseThemeId: draft.baseThemeId,
      workflowKind: SkinWorkflowKind.SkinPack,
      presentation,
    });
    expect(createResult.details?.skinId).toBe(draft.id);

    const registerResult = await handler({
      args: {
        action: SkinToolAction.RegisterAsset,
        skinId: draft.id,
        slot: SkinAssetSlot.WorkspaceBackdrop,
        sourcePath: 'C:\\generated\\backdrop.png',
      },
      context,
    });
    expect(store.registerAsset).toHaveBeenCalledWith({
      skinId: draft.id,
      slot: SkinAssetSlot.WorkspaceBackdrop,
      source: 'C:\\generated\\backdrop.png',
    });
    expect(registerResult.details?.skin).toMatchObject({
      id: draft.id,
      assets: {
        [SkinAssetSlot.WorkspaceBackdrop]: {
          url: expect.stringContaining(`/${SkinAssetSlot.WorkspaceBackdrop}?v=${backdrop.contentHash}`),
          cacheKey: backdrop.contentHash,
        },
      },
    });

    const applyResult = await handler({
      args: { action: SkinToolAction.Apply, skinId: draft.id },
      context,
    });
    expect(applyResult).toMatchObject({
      details: { status: 'applied', skinId: draft.id },
    });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  test('resolves attached image reference tokens to local files or buffers and rejects unknown tokens', async () => {
    const store = createStoreDouble();
    const imageBytes = Buffer.from('fake-image-bytes');
    const handler = createSkinToolHandler({
      store,
      isWorkflowAllowed: () => true,
      resolveSourceReference: (_sessionKey, source) => {
        if (source === '@图片1') return { kind: 'path', path: '/uploads/wow.jpg' };
        if (source === '@图片2') return { kind: 'buffer', data: imageBytes };
        return null;
      },
    });

    await handler({
      args: {
        action: SkinToolAction.RegisterAsset,
        skinId: draft.id,
        slot: SkinAssetSlot.WorkspaceBackdrop,
        sourcePath: '@图片1',
      },
      context,
    });
    expect(store.registerAsset).toHaveBeenCalledWith({
      skinId: draft.id,
      slot: SkinAssetSlot.WorkspaceBackdrop,
      source: '/uploads/wow.jpg',
    });

    await handler({
      args: {
        action: SkinToolAction.RegisterAsset,
        skinId: draft.id,
        slot: SkinAssetSlot.WorkspaceBackdrop,
        sourcePath: '@图片2',
      },
      context,
    });
    expect(store.registerAssetBuffer).toHaveBeenCalledWith({
      skinId: draft.id,
      slot: SkinAssetSlot.WorkspaceBackdrop,
      data: imageBytes,
    });

    const missing = await handler({
      args: {
        action: SkinToolAction.RegisterAsset,
        skinId: draft.id,
        slot: SkinAssetSlot.WorkspaceBackdrop,
        sourcePath: '@图片9',
      },
      context,
    });
    expect(missing).toMatchObject({
      isError: true,
      details: { code: SkinStoreErrorCode.InvalidSource },
    });
  });
});
