import { describe, expect, test } from 'vitest';

import { SkinAssetSlot, SkinWorkflowKind } from '../../../shared/skin/constants';
import { buildMediaGenerationTurnInstruction } from './mediaGenerationTurnInstruction';

describe('buildMediaGenerationTurnInstruction', () => {
  test('keeps an ordinary image request to exactly one generation call', () => {
    const instruction = buildMediaGenerationTurnInstruction({
      mode: 'image',
      imageModelId: 'image-model',
    });

    expect(instruction).toContain('exactly once with action="generate"');
    expect(instruction).not.toContain('[AI skin pack workflow: strict two-asset transaction]');
    expect(instruction).not.toContain('lobsterai_skin_manage');
  });

  test('guides a two-slot serial skin flow without a hard generation quota', () => {
    const instruction = buildMediaGenerationTurnInstruction(
      { mode: 'image', imageModelId: 'image-model' },
      false,
      SkinWorkflowKind.SkinPack,
    );

    const backdropIndex = instruction.indexOf(`1. ${SkinAssetSlot.WorkspaceBackdrop}`);
    const emblemIndex = instruction.indexOf(`2. ${SkinAssetSlot.HomeEmblem}`);

    expect(backdropIndex).toBeGreaterThan(-1);
    expect(emblemIndex).toBeGreaterThan(backdropIndex);
    expect(instruction).toContain('soft budget of about two serial lobsterai_image_generate calls');
    expect(instruction).toContain('guidance, not a hard quota');
    expect(instruction).toContain('Extra serial attempts are allowed');
    expect(instruction).toContain('action="status" exactly once');
    expect(instruction).toContain('action="register_asset" succeeds');
    expect(instruction).toContain('action="apply" with the same skinId');
    expect(instruction).toContain('Never start parallel generations');
    expect(instruction).not.toContain('you must call the lobsterai_image_generate tool exactly once');
  });

  test('uses the native image route for a skin workflow without LobsterAI image selection', () => {
    const instruction = buildMediaGenerationTurnInstruction(
      undefined,
      false,
      SkinWorkflowKind.SkinPack,
    );

    expect(instruction).toContain('[AI skin pack workflow: two-asset serial flow]');
    expect(instruction).toContain('locked to the OpenClaw-native image_generate tool');
    expect(instruction).toContain('soft budget of about two serial image_generate calls');
    expect(instruction).toContain('(count=1)');
    expect(instruction).toContain('There is no lobsterai_image_generate status step');
    expect(instruction).toContain('lobsterai_skin_manage');
    expect(instruction).not.toContain('LobsterAI media generation tools - NOT AVAILABLE');
  });

  test('uses the LobsterAI image route for auto media selection', () => {
    const instruction = buildMediaGenerationTurnInstruction(
      { mode: 'auto', imageModelId: 'image-model' },
      false,
      SkinWorkflowKind.SkinPack,
    );

    expect(instruction).toContain('locked to lobsterai_image_generate');
    expect(instruction).toContain('model "image-model" for both image generation jobs');
    expect(instruction).not.toContain('OpenClaw-native image_generate tool');
  });

  test('preserves the media-skill fallback when LobsterAI tools are unavailable', () => {
    const instruction = buildMediaGenerationTurnInstruction(undefined, true);

    expect(instruction).toContain('LobsterAI media generation tools - NOT AVAILABLE');
    expect(instruction).toContain('You may use it');
  });
});
