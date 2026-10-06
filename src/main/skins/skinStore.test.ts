import {
  SkinAssetSlot,
  SkinParticleDensity,
  SkinPreferredAppearance,
  SkinPresentationMode,
  SkinRecordStatus,
  SkinStoreErrorCode,
  SkinWorkflowKind,
} from '@shared/skin/constants';
import type { SkinPresentation } from '@shared/skin/presentation';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, test } from 'vitest';

import { SkinStore } from './skinStore';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempWorkspace(): { rootDir: string; sourceDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-skins-'));
  tempDirs.push(tempDir);
  const rootDir = path.join(tempDir, 'managed');
  const sourceDir = path.join(tempDir, 'sources');
  fs.mkdirSync(sourceDir, { recursive: true });
  return { rootDir, sourceDir };
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function createPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createWebp(width: number, height: number): Buffer {
  const widthMinusOne = width - 1;
  const heightMinusOne = height - 1;
  const payload = Buffer.from([
    0x2f,
    widthMinusOne & 0xff,
    ((widthMinusOne >> 8) & 0x3f) | ((heightMinusOne & 0x03) << 6),
    (heightMinusOne >> 2) & 0xff,
    (heightMinusOne >> 10) & 0x0f,
  ]);
  const paddedPayload = Buffer.concat([payload, Buffer.alloc(payload.length % 2)]);
  const result = Buffer.alloc(20 + paddedPayload.length);
  result.write('RIFF', 0, 'ascii');
  result.writeUInt32LE(result.length - 8, 4);
  result.write('WEBP', 8, 'ascii');
  result.write('VP8L', 12, 'ascii');
  result.writeUInt32LE(payload.length, 16);
  paddedPayload.copy(result, 20);
  return result;
}

function writeSource(sourceDir: string, fileName: string, data: Buffer): string {
  const filePath = path.join(sourceDir, fileName);
  fs.writeFileSync(filePath, data);
  return filePath;
}

function createStore(rootDir: string, ids: string[] = ['skin-one']): SkinStore {
  let idIndex = 0;
  return new SkinStore({
    rootDir,
    now: () => new Date('2026-07-16T10:00:00.000Z'),
    idGenerator: () => ids[idIndex++] ?? `skin-${idIndex}`,
  });
}

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

describe('SkinStore', () => {
  test('persists a draft with workflow and base theme metadata', async () => {
    const { rootDir } = createTempWorkspace();
    const store = createStore(rootDir);

    const draft = await store.createDraft({
      name: 'Rose horizon',
      baseThemeId: 'light',
      presentation,
    });

    expect(draft).toMatchObject({
      id: 'skin-one',
      name: 'Rose horizon',
      workflowKind: SkinWorkflowKind.SkinPack,
      baseThemeId: 'light',
      presentation,
      status: SkinRecordStatus.Draft,
      assets: {},
    });
    const restored = await createStore(rootDir).getSkin('skin-one');
    expect(restored).toEqual(draft);
  });

  test('rejects inaccessible or extensible presentation metadata before generation', async () => {
    const { rootDir } = createTempWorkspace();
    const store = createStore(rootDir);

    await expect(store.createDraft({
      presentation: {
        ...presentation,
        palette: { ...presentation.palette, foreground: '#201010' },
      },
    })).rejects.toMatchObject({ code: SkinStoreErrorCode.InvalidDraft });

    await expect(store.createDraft({
      presentation: {
        ...presentation,
        css: 'body { display: none; }',
      } as SkinPresentation,
    })).rejects.toMatchObject({ code: SkinStoreErrorCode.InvalidDraft });
  });

  test('copies validated assets into content-addressed managed paths and applies one skin', async () => {
    const { rootDir, sourceDir } = createTempWorkspace();
    const backdropPath = writeSource(sourceDir, 'background.any-extension', createPng(1600, 900));
    const emblemPath = writeSource(sourceDir, 'emblem.webp', createWebp(256, 256));
    const store = createStore(rootDir);
    await store.createDraft();

    const backdrop = await store.registerAsset({
      skinId: 'skin-one',
      slot: SkinAssetSlot.WorkspaceBackdrop,
      source: backdropPath,
    });
    const emblem = await store.registerAsset({
      skinId: 'skin-one',
      slot: SkinAssetSlot.HomeEmblem,
      source: pathToFileURL(emblemPath).toString(),
    });

    expect(backdrop.relativePath).toMatch(/^skin-one\/assets\/workspace-backdrop-[a-f0-9]{64}\.png$/);
    expect(emblem.relativePath).toMatch(/^skin-one\/assets\/home-emblem-[a-f0-9]{64}\.webp$/);
    expect(path.isAbsolute(backdrop.relativePath)).toBe(false);
    expect(fs.readFileSync(path.join(rootDir, ...backdrop.relativePath.split('/')))).toEqual(fs.readFileSync(backdropPath));

    const ready = await store.getSkin('skin-one');
    expect(ready?.status).toBe(SkinRecordStatus.Ready);
    await store.apply('skin-one', 'midnight');
    expect(await createStore(rootDir).getActive()).toMatchObject({
      id: 'skin-one',
      boundThemeId: 'midnight',
    });
    await store.apply('skin-one', 'ocean');
    expect((await store.getActive())?.boundThemeId).toBe('midnight');
    await store.deactivate();
    expect(await store.getActive()).toBeNull();
    expect((await createStore(rootDir).listSkins()).map(skin => skin.id)).toEqual(['skin-one']);
  });

  test('requires all slots before apply and keeps only one active skin', async () => {
    const { rootDir, sourceDir } = createTempWorkspace();
    const backdropPath = writeSource(sourceDir, 'background.png', createPng(1600, 900));
    const emblemPath = writeSource(sourceDir, 'emblem.png', createPng(256, 256));
    const store = createStore(rootDir, ['skin-one', 'skin-two']);
    await store.createDraft();
    await expect(store.apply('skin-one')).rejects.toMatchObject({ code: SkinStoreErrorCode.SkinIncomplete });

    for (const skinId of ['skin-one', 'skin-two']) {
      if (skinId === 'skin-two') await store.createDraft();
      await store.registerAsset({ skinId, slot: SkinAssetSlot.WorkspaceBackdrop, source: backdropPath });
      await store.registerAsset({ skinId, slot: SkinAssetSlot.HomeEmblem, source: emblemPath });
    }

    await store.apply('skin-one');
    await store.apply('skin-two');
    expect((await store.getActive())?.id).toBe('skin-two');
  });

  test('adds a theme binding to an existing skin without requiring a registry migration', async () => {
    const { rootDir } = createTempWorkspace();
    const store = createStore(rootDir);
    const legacySkin = await store.createDraft();

    expect(legacySkin.boundThemeId).toBeUndefined();

    await expect(store.bindTheme('skin-one', 'classic-dark')).resolves.toMatchObject({
      id: 'skin-one',
      boundThemeId: 'classic-dark',
    });
    await expect(store.bindTheme('skin-one', 'ocean')).resolves.toMatchObject({
      boundThemeId: 'classic-dark',
    });
    expect((await createStore(rootDir).getSkin('skin-one'))?.boundThemeId)
      .toBe('classic-dark');
  });

  test('lists newer skins first without reordering them when an older skin is applied', async () => {
    const { rootDir, sourceDir } = createTempWorkspace();
    const backdropPath = writeSource(sourceDir, 'background.png', createPng(1600, 900));
    const emblemPath = writeSource(sourceDir, 'emblem.png', createPng(256, 256));
    const ids = ['skin-older', 'skin-newer'];
    let idIndex = 0;
    let timestamp = new Date('2026-07-16T10:00:00.000Z');
    const store = new SkinStore({
      rootDir,
      now: () => timestamp,
      idGenerator: () => ids[idIndex++] ?? `skin-${idIndex}`,
    });

    await store.createDraft();
    await store.registerAsset({
      skinId: 'skin-older',
      slot: SkinAssetSlot.WorkspaceBackdrop,
      source: backdropPath,
    });
    await store.registerAsset({
      skinId: 'skin-older',
      slot: SkinAssetSlot.HomeEmblem,
      source: emblemPath,
    });

    timestamp = new Date('2026-07-16T11:00:00.000Z');
    await store.createDraft();
    await store.registerAsset({
      skinId: 'skin-newer',
      slot: SkinAssetSlot.WorkspaceBackdrop,
      source: backdropPath,
    });
    await store.registerAsset({
      skinId: 'skin-newer',
      slot: SkinAssetSlot.HomeEmblem,
      source: emblemPath,
    });

    expect((await store.listSkins()).map(skin => skin.id)).toEqual([
      'skin-newer',
      'skin-older',
    ]);

    timestamp = new Date('2026-07-16T12:00:00.000Z');
    await store.apply('skin-older');

    expect((await store.getSkin('skin-older'))?.updatedAt).toBe(timestamp.toISOString());
    expect((await store.listSkins()).map(skin => skin.id)).toEqual([
      'skin-newer',
      'skin-older',
    ]);
  });

  test('deletes inactive and active skins without touching generated source files', async () => {
    const { rootDir, sourceDir } = createTempWorkspace();
    const backdropPath = writeSource(sourceDir, 'background.png', createPng(1600, 900));
    const emblemPath = writeSource(sourceDir, 'emblem.png', createPng(256, 256));
    const store = createStore(rootDir, ['skin-one', 'skin-two']);

    for (const skinId of ['skin-one', 'skin-two']) {
      await store.createDraft();
      await store.registerAsset({
        skinId,
        slot: SkinAssetSlot.WorkspaceBackdrop,
        source: backdropPath,
      });
      await store.registerAsset({
        skinId,
        slot: SkinAssetSlot.HomeEmblem,
        source: emblemPath,
      });
    }
    await store.apply('skin-one');

    await expect(store.deleteSkin('skin-two')).resolves.toEqual({ wasActive: false });
    expect((await store.getActive())?.id).toBe('skin-one');
    expect(await store.getSkin('skin-two')).toBeNull();
    expect(fs.existsSync(path.join(rootDir, 'skin-two'))).toBe(false);

    await expect(store.deleteSkin('skin-one')).resolves.toEqual({ wasActive: true });
    expect(await store.getActive()).toBeNull();
    expect(await store.listSkins()).toEqual([]);
    expect(fs.existsSync(path.join(rootDir, 'skin-one'))).toBe(false);
    expect(fs.existsSync(backdropPath)).toBe(true);
    expect(fs.existsSync(emblemPath)).toBe(true);
  });

  test('rejects invalid and missing skin deletion targets', async () => {
    const { rootDir } = createTempWorkspace();
    const store = createStore(rootDir);

    await expect(store.deleteSkin('../outside'))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.InvalidSkinId });
    await expect(store.deleteSkin('missing-skin'))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.SkinNotFound });
  });

  test('rejects remote, relative, non-file, oversized, malformed, and invalid-dimension sources', async () => {
    const { rootDir, sourceDir } = createTempWorkspace();
    const store = createStore(rootDir);
    await store.createDraft();
    const baseInput = { skinId: 'skin-one', slot: SkinAssetSlot.WorkspaceBackdrop };

    await expect(store.registerAsset({ ...baseInput, source: 'https://example.com/image.png' }))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.UnsupportedSourceScheme });
    await expect(store.registerAsset({ ...baseInput, source: 'data:image/png;base64,AAAA' }))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.UnsupportedSourceScheme });
    await expect(store.registerAsset({ ...baseInput, source: 'relative/image.png' }))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.InvalidSource });
    await expect(store.registerAsset({ ...baseInput, source: sourceDir }))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.SourceNotRegularFile });

    const malformedPath = writeSource(sourceDir, 'spoof.png', Buffer.from('not an image'));
    await expect(store.registerAsset({ ...baseInput, source: malformedPath }))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.UnsupportedAssetFormat });

    const smallPath = writeSource(sourceDir, 'small.png', createPng(512, 512));
    await expect(store.registerAsset({ ...baseInput, source: smallPath }))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.InvalidAssetDimensions });

    const oversizedPath = path.join(sourceDir, 'oversized.png');
    fs.writeFileSync(oversizedPath, Buffer.from([0]));
    fs.truncateSync(oversizedPath, 16 * 1024 * 1024 + 1);
    await expect(store.registerAsset({ ...baseInput, source: oversizedPath }))
      .rejects.toMatchObject({ code: SkinStoreErrorCode.AssetTooLarge });
  });

  test('enforces slot order and one registration per slot, including concurrent attempts', async () => {
    const { rootDir, sourceDir } = createTempWorkspace();
    const backdropPath = writeSource(sourceDir, 'background.png', createPng(1600, 900));
    const emblemPath = writeSource(sourceDir, 'emblem.png', createPng(256, 256));
    const store = createStore(rootDir);
    await store.createDraft();

    await expect(store.registerAsset({
      skinId: 'skin-one',
      slot: SkinAssetSlot.HomeEmblem,
      source: emblemPath,
    })).rejects.toMatchObject({ code: SkinStoreErrorCode.SlotOutOfOrder });

    const concurrentResults = await Promise.allSettled([
      store.registerAsset({ skinId: 'skin-one', slot: SkinAssetSlot.WorkspaceBackdrop, source: backdropPath }),
      store.registerAsset({ skinId: 'skin-one', slot: SkinAssetSlot.WorkspaceBackdrop, source: backdropPath }),
    ]);
    expect(concurrentResults.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = concurrentResults.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: SkinStoreErrorCode.SlotAlreadyRegistered },
    });

    await store.registerAsset({ skinId: 'skin-one', slot: SkinAssetSlot.HomeEmblem, source: emblemPath });
    await expect(store.registerAsset({
      skinId: 'skin-one',
      slot: SkinAssetSlot.HomeEmblem,
      source: emblemPath,
    })).rejects.toMatchObject({ code: SkinStoreErrorCode.SlotAlreadyRegistered });
  });
});
