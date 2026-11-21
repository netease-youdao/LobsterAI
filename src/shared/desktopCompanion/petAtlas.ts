import { CompanionSkinKind } from './skins';

/** Standard OpenAI Codex Pets grid dimensions (v1: 8x9, v2: 8x11). */
export const PET_ATLAS_COLUMNS = 8;
export const PET_ATLAS_CELL_WIDTH = 192;
export const PET_ATLAS_CELL_HEIGHT = 208;
export const PET_ATLAS_V1_ROWS = 9;
export const PET_ATLAS_V2_ROWS = 11;

/**
 * Default standing vertical bounds inside a 192x208 Codex Pets cell:
 * characters stand from y=42 to y=194 (~73.1% fill), leaving headroom above
 * for jumps/waves and placing the standing midpoint at y=118 (below cell center 104).
 */
export const PET_ATLAS_STANDING_TOP_RATIO = 42 / PET_ATLAS_CELL_HEIGHT;
export const PET_ATLAS_STANDING_BOTTOM_RATIO = 194 / PET_ATLAS_CELL_HEIGHT;
export const PET_ATLAS_ALPHA_THRESHOLD = 16;

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

export interface PetAtlasVerticalBounds {
  /** Top-most opaque pixel row in cell coordinates (inclusive). */
  top: number;
  /** Bottom-most opaque pixel row in cell coordinates (exclusive). */
  bottom: number;
}

export interface PetAtlasLayoutInput {
  /** Square character box size in CSS pixels that the static `.webp` fits into via `object-fit: contain`. */
  boxSize: number;
  cellWidth: number;
  cellHeight: number;
  /** Natural dimensions of the static skin image (if loaded) to match its `object-fit: contain` height. */
  staticWidth?: number;
  staticHeight?: number;
  /** Measured standing-frame vertical bounds inside one atlas cell; falls back to standard Codex ratios. */
  standingBounds?: PetAtlasVerticalBounds | null;
}

export interface PetAtlasLayout {
  displayWidth: number;
  displayHeight: number;
  /** Vertical CSS offset from box center so the standing pose aligns with the static image center. */
  offsetY: number;
}

/** Scans an RGBA pixel buffer of one atlas cell to find the opaque vertical span `[top, bottom)`. */
export function findVerticalAlphaBounds(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  alphaThreshold = PET_ATLAS_ALPHA_THRESHOLD,
): PetAtlasVerticalBounds | null {
  if (width <= 0 || height <= 0 || rgba.length < width * height * 4) return null;

  const rowHasOpaquePixel = (y: number): boolean => {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[rowOffset + x * 4 + 3] > alphaThreshold) return true;
    }
    return false;
  };

  let top = -1;
  for (let y = 0; y < height; y++) {
    if (rowHasOpaquePixel(y)) {
      top = y;
      break;
    }
  }
  if (top < 0) return null;

  let bottom = top + 1;
  for (let y = height - 1; y >= top; y--) {
    if (rowHasOpaquePixel(y)) {
      bottom = y + 1;
      break;
    }
  }
  return { top, bottom };
}

/**
 * Computes canvas size and vertical offset so an atlas cell's standing character
 * matches the static `.webp` skin in both visual height and vertical center.
 */
export function computePetAtlasLayout(input: PetAtlasLayoutInput): PetAtlasLayout {
  const { boxSize, cellWidth, cellHeight } = input;
  if (boxSize <= 0 || cellWidth <= 0 || cellHeight <= 0) {
    return { displayWidth: 0, displayHeight: 0, offsetY: 0 };
  }

  const staticHeightRatio =
    typeof input.staticWidth === 'number' && input.staticWidth > 0
    && typeof input.staticHeight === 'number' && input.staticHeight > 0
      ? Math.min(1, input.staticHeight / input.staticWidth)
      : 1;
  const targetStandingHeight = boxSize * staticHeightRatio;

  const bounds = input.standingBounds;
  const hasValidBounds =
    !!bounds
    && Number.isFinite(bounds.top)
    && Number.isFinite(bounds.bottom)
    && bounds.top >= 0
    && bounds.bottom <= cellHeight
    && bounds.bottom > bounds.top;

  const standingTop = hasValidBounds ? bounds.top : cellHeight * PET_ATLAS_STANDING_TOP_RATIO;
  const standingBottom = hasValidBounds ? bounds.bottom : cellHeight * PET_ATLAS_STANDING_BOTTOM_RATIO;
  const standingHeight = standingBottom - standingTop;
  const standingCenterY = (standingTop + standingBottom) / 2;

  const displayHeight = Math.round(cellHeight * (targetStandingHeight / standingHeight));
  const displayWidth = Math.round(displayHeight * (cellWidth / cellHeight));
  const rawOffsetY = -((standingCenterY - cellHeight / 2) * (displayHeight / cellHeight));
  const offsetY = Math.round(rawOffsetY * 2) / 2;

  return { displayWidth, displayHeight, offsetY };
}
