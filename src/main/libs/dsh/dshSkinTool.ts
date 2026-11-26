import {
  SKIN_ASSET_SLOTS,
  SkinBackdropVisibility,
  SkinParticleDensity,
  SkinPresentationMode,
  SkinToolAction,
  SkinToolName,
} from '../../../shared/skin/constants';
import type { SkinPresentationPalette } from '../../../shared/skin/presentation';
import type { DshHostToolDescriptor } from './dshHostManager';

const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const palette = {
  canvas: color, panel: color, panelRaised: color, accent: color, accentForeground: color,
  accentAlt: color, foreground: color, muted: color, border: color,
} satisfies Record<keyof SkinPresentationPalette, typeof color>;
const focus = { type: 'number', minimum: 0, maximum: 1 };

export const dshSkinTool: DshHostToolDescriptor = {
  name: SkinToolName.Manage,
  description: 'Manage the current AI Skin Designer kit draft. Create it with a name and accessible palette, register the backdrop (generated local image or attached image token) and optional emblem, check status, and apply the ready skin.',
  inputSchema: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: Object.values(SkinToolAction) },
      name: { type: 'string', description: 'User-visible name for create_draft.' },
      skinId: { type: 'string', description: 'ID returned by create_draft for this workflow.' },
      slot: { type: 'string', enum: SKIN_ASSET_SLOTS },
      sourcePath: {
        type: 'string',
        description: 'Exact local image path, file URL, or attached image reference token (e.g. "@图片1") for register_asset.',
      },
      presentation: {
        type: 'object', required: ['mode', 'palette'], additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: [SkinPresentationMode.ImmersiveShell] },
          palette: { type: 'object', properties: palette, required: Object.keys(palette), additionalProperties: false },
          art: { type: 'object', properties: { focusX: focus, focusY: focus }, required: ['focusX', 'focusY'], additionalProperties: false },
          effects: { type: 'object', properties: { particleDensity: { type: 'string', enum: Object.values(SkinParticleDensity) } }, required: ['particleDensity'], additionalProperties: false },
          backdropVisibility: {
            type: 'string',
            enum: Object.values(SkinBackdropVisibility),
            description: 'Host-controlled backdrop clarity preset: subtle, balanced (default), or vivid.',
          },
        },
      },
    },
  },
};
