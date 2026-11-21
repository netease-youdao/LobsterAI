import { CompanionSkinKind } from './skins';

/** Standard OpenAI Codex Pets grid dimensions (v1: 8x9, v2: 8x11). */
export const PET_ATLAS_COLUMNS = 8;
export const PET_ATLAS_CELL_WIDTH = 192;
export const PET_ATLAS_CELL_HEIGHT = 208;
export const PET_ATLAS_V1_ROWS = 9;
export const PET_ATLAS_V2_ROWS = 11;

export const PetAtlasVersion = {
  V1: 1,
  V2: 2,
} as const;
export type PetAtlasVersion = typeof PetAtlasVersion[keyof typeof PetAtlasVersion];

export const PetAction = {
  Idle: 'idle',
  RunningRight: 'running-right',
  RunningLeft: 'running-left',
  Waving: 'waving',
  Jumping: 'jumping',
  Failed: 'failed',
  Waiting: 'waiting',
  Working: 'working',
  Review: 'review',
} as const;
export type PetAction = typeof PetAction[keyof typeof PetAction];

export const PetDragDirection = {
  None: 'none',
  Left: 'left',
  Right: 'right',
  Hold: 'hold',
} as const;
export type PetDragDirection = typeof PetDragDirection[keyof typeof PetDragDirection];

export const PetHoverBeat = {
  Waving: 'waving',
  Jumping: 'jumping',
} as const;
export type PetHoverBeat = typeof PetHoverBeat[keyof typeof PetHoverBeat];

export interface PetActionSpec {
  row: number;
  frames: number;
  fps: number;
}

/** Standard Codex Pets v1/v2 animation row mapping (rows 0..8). */
export const DEFAULT_PET_ACTION_SPECS: Readonly<Record<PetAction, PetActionSpec>> = {
  [PetAction.Idle]: { row: 0, frames: 6, fps: 5 },
  [PetAction.RunningRight]: { row: 1, frames: 8, fps: 12 },
  [PetAction.RunningLeft]: { row: 2, frames: 8, fps: 12 },
  [PetAction.Waving]: { row: 3, frames: 4, fps: 8 },
  [PetAction.Jumping]: { row: 4, frames: 5, fps: 10 },
  [PetAction.Failed]: { row: 5, frames: 8, fps: 8 },
  [PetAction.Waiting]: { row: 6, frames: 6, fps: 8 },
  [PetAction.Working]: { row: 7, frames: 8, fps: 10 },
  [PetAction.Review]: { row: 8, frames: 6, fps: 8 },
};

/** Raw Codex-compatible `pet.json` manifest shape. */
export interface RawPetManifest {
  id?: unknown;
  displayName?: unknown;
  description?: unknown;
  spriteVersionNumber?: unknown;
  spritesheetPath?: unknown;
  cellWidth?: unknown;
  cellHeight?: unknown;
  columns?: unknown;
  actions?: Partial<Record<PetAction, Partial<PetActionSpec>>>;
}

export interface PetManifest {
  id: string;
  displayName: string;
  description: string;
  version: PetAtlasVersion;
  spritesheetUrl: string;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  actions: Record<PetAction, PetActionSpec>;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function resolveRelativeAsset(manifestUrl: string, relativePath: string): string {
  const clean = relativePath.replace(/^\.\//, '');
  const slash = manifestUrl.lastIndexOf('/');
  return slash >= 0 ? `${manifestUrl.slice(0, slash + 1)}${clean}` : clean;
}

/** Parses a Codex-compatible `pet.json` manifest and resolves its spritesheet URL. */
export function normalizePetManifest(raw: RawPetManifest, manifestUrl: string): PetManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
  const spritesheetPath = typeof raw.spritesheetPath === 'string' && raw.spritesheetPath.trim()
    ? raw.spritesheetPath.trim()
    : 'spritesheet.webp';
  if (!id) return null;

  const version: PetAtlasVersion = raw.spriteVersionNumber === PetAtlasVersion.V1
    ? PetAtlasVersion.V1
    : PetAtlasVersion.V2;
  const columns = positiveInt(raw.columns, PET_ATLAS_COLUMNS);
  const cellWidth = positiveInt(raw.cellWidth, PET_ATLAS_CELL_WIDTH);
  const cellHeight = positiveInt(raw.cellHeight, PET_ATLAS_CELL_HEIGHT);
  const rows = version === PetAtlasVersion.V2 ? PET_ATLAS_V2_ROWS : PET_ATLAS_V1_ROWS;

  const actions = {} as Record<PetAction, PetActionSpec>;
  for (const key of Object.keys(DEFAULT_PET_ACTION_SPECS) as PetAction[]) {
    const def = DEFAULT_PET_ACTION_SPECS[key];
    const custom = raw.actions?.[key];
    actions[key] = {
      row: typeof custom?.row === 'number' && Number.isInteger(custom.row) && custom.row >= 0 ? custom.row : def.row,
      frames: Math.min(columns, positiveInt(custom?.frames, def.frames)),
      fps: positiveInt(custom?.fps, def.fps),
    };
  }

  return {
    id,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    version,
    spritesheetUrl: resolveRelativeAsset(manifestUrl, spritesheetPath),
    columns,
    rows,
    cellWidth,
    cellHeight,
    actions,
  };
}

export interface PetActionResolutionInput {
  skinKind: CompanionSkinKind;
  hasAtlas: boolean;
  /** CompanionMood string value (kept loosely typed to avoid shared->renderer imports). */
  mood: string;
  dragDirection: PetDragDirection;
  landing: boolean;
  hovering: boolean;
  launcherOpen: boolean;
  panelOpen: boolean;
  reducedMotion: boolean;
  hoverBeat: PetHoverBeat;
}

/**
 * Resolves which Codex atlas action should render right now, or `null` when the
 * static character image should stay completely still (calm idle, brand logo,
 * snooze, file drop, reduced motion, or landing bounce).
 */
export function resolvePetAction(input: PetActionResolutionInput): PetAction | null {
  if (input.reducedMotion || input.skinKind === CompanionSkinKind.Brand || !input.hasAtlas) return null;
  if (input.mood === 'snooze' || input.mood === 'catch' || input.mood === 'curious') return null;

  if (input.dragDirection === PetDragDirection.Right) return PetAction.RunningRight;
  if (input.dragDirection === PetDragDirection.Left) return PetAction.RunningLeft;
  if (input.dragDirection === PetDragDirection.Hold) return PetAction.Jumping;

  if (input.landing) return null;

  if (input.hovering || (input.launcherOpen && !input.panelOpen)) {
    return input.hoverBeat === PetHoverBeat.Jumping ? PetAction.Jumping : PetAction.Waving;
  }

  if (input.mood === 'error') return PetAction.Failed;
  if (input.mood === 'attention') return PetAction.Waiting;
  if (input.mood === 'working') return PetAction.Working;
  if (input.mood === 'done') return PetAction.Review;

  return null;
}
