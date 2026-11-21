import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  normalizePetManifest,
  PET_ATLAS_CELL_HEIGHT,
  PET_ATLAS_CELL_WIDTH,
  PET_ATLAS_COLUMNS,
  PET_ATLAS_V1_ROWS,
  PET_ATLAS_V2_ROWS,
  PetAction,
  type PetActionResolutionInput,
  PetAtlasVersion,
  PetDragDirection,
  PetHoverBeat,
  type RawPetManifest,
  resolvePetAction,
} from './petAtlas';
import { COMPANION_SKINS, CompanionSkinKind, skinHasPetAtlas } from './skins';

const base: PetActionResolutionInput = {
  skinKind: CompanionSkinKind.Image,
  hasAtlas: true,
  mood: 'idle',
  dragDirection: PetDragDirection.None,
  landing: false,
  hovering: false,
  launcherOpen: false,
  panelOpen: false,
  reducedMotion: false,
  hoverBeat: PetHoverBeat.Waving,
};

describe('Codex pet atlas manifest', () => {
  test('parses Codex v1 and v2 manifests and resolves relative spritesheet paths', () => {
    const v2 = normalizePetManifest(
      { id: 'ruanruanxia', displayName: '软软虾', spriteVersionNumber: 2, spritesheetPath: 'spritesheet.webp' },
      './desktop-companion/pets/ruanruanxia/pet.json',
    );
    expect(v2).not.toBeNull();
    expect(v2!.version).toBe(PetAtlasVersion.V2);
    expect(v2!.rows).toBe(PET_ATLAS_V2_ROWS);
    expect(v2!.columns).toBe(PET_ATLAS_COLUMNS);
    expect(v2!.cellWidth).toBe(PET_ATLAS_CELL_WIDTH);
    expect(v2!.cellHeight).toBe(PET_ATLAS_CELL_HEIGHT);
    expect(v2!.spritesheetUrl).toBe('./desktop-companion/pets/ruanruanxia/spritesheet.webp');

    const v1 = normalizePetManifest(
      { id: 'classic', spriteVersionNumber: 1 },
      './desktop-companion/pets/classic/pet.json',
    );
    expect(v1!.version).toBe(PetAtlasVersion.V1);
    expect(v1!.rows).toBe(PET_ATLAS_V1_ROWS);
  });
});

describe('Codex pet action state machine', () => {
  test('stays completely still in calm idle, brand skin, reduced motion, snooze, and file-drop states', () => {
    expect(resolvePetAction(base)).toBeNull();
    expect(resolvePetAction({ ...base, skinKind: CompanionSkinKind.Brand, hovering: true })).toBeNull();
    expect(resolvePetAction({ ...base, reducedMotion: true, hovering: true })).toBeNull();
    expect(resolvePetAction({ ...base, hasAtlas: false, hovering: true })).toBeNull();
    expect(resolvePetAction({ ...base, mood: 'snooze', hovering: true })).toBeNull();
    expect(resolvePetAction({ ...base, mood: 'catch', hovering: true })).toBeNull();
    expect(resolvePetAction({ ...base, mood: 'curious', hovering: true })).toBeNull();
  });

  test('maps agent moods to failed, waiting, working, and review rows', () => {
    expect(resolvePetAction({ ...base, mood: 'error' })).toBe(PetAction.Failed);
    expect(resolvePetAction({ ...base, mood: 'attention' })).toBe(PetAction.Waiting);
    expect(resolvePetAction({ ...base, mood: 'working' })).toBe(PetAction.Working);
    expect(resolvePetAction({ ...base, mood: 'done' })).toBe(PetAction.Review);
  });

  test('plays only waving and jumping on hover/launcher and prioritizes drag and landing', () => {
    expect(resolvePetAction({ ...base, hovering: true, mood: 'working', hoverBeat: PetHoverBeat.Waving })).toBe(PetAction.Waving);
    expect(resolvePetAction({ ...base, launcherOpen: true, hoverBeat: PetHoverBeat.Jumping })).toBe(PetAction.Jumping);
    expect(resolvePetAction({ ...base, launcherOpen: true, panelOpen: true, hoverBeat: PetHoverBeat.Waving })).toBeNull();
    expect(resolvePetAction({ ...base, hovering: true, landing: true })).toBeNull();
    expect(resolvePetAction({ ...base, landing: true, dragDirection: PetDragDirection.Right })).toBe(PetAction.RunningRight);
    expect(resolvePetAction({ ...base, dragDirection: PetDragDirection.Left })).toBe(PetAction.RunningLeft);
    expect(resolvePetAction({ ...base, dragDirection: PetDragDirection.Hold })).toBe(PetAction.Jumping);
  });
});

describe('bundled Codex pet package integrity', () => {
  const publicDir = path.resolve(process.cwd(), 'public');

  test('brand skin never declares a pet atlas while every sea-friend skin ships a valid Codex WebP atlas on disk', () => {
    const brand = COMPANION_SKINS.find(skin => skin.kind === CompanionSkinKind.Brand);
    expect(brand?.petManifest).toBeUndefined();
    expect(skinHasPetAtlas(brand!.id)).toBe(false);

    const imageSkins = COMPANION_SKINS.filter(skin => skin.kind === CompanionSkinKind.Image);
    expect(imageSkins).toHaveLength(8);

    for (const skin of imageSkins) {
      expect(skin.petManifest, `missing petManifest for ${skin.id}`).toBeDefined();
      expect(skinHasPetAtlas(skin.id)).toBe(true);
      const manifestRel = skin.petManifest!.replace(/^\.\//, '');
      const manifestPath = path.join(publicDir, manifestRel);
      expect(fs.existsSync(manifestPath), `missing manifest ${manifestRel}`).toBe(true);

      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RawPetManifest;
      const manifest = normalizePetManifest(raw, skin.petManifest!);
      expect(manifest).not.toBeNull();

      const sheetRel = manifest!.spritesheetUrl.replace(/^\.\//, '');
      const sheetPath = path.join(publicDir, sheetRel);
      expect(fs.existsSync(sheetPath), `missing spritesheet ${sheetRel}`).toBe(true);

      const buf = fs.readFileSync(sheetPath);
      expect(buf.subarray(12, 16).toString('ascii')).toBe('VP8X');
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      expect(width).toBe(manifest!.columns * manifest!.cellWidth);
      expect(height).toBe(manifest!.rows * manifest!.cellHeight);
    }
  });
});
