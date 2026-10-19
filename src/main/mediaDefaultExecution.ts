import { type MediaDefaultModel, MediaType } from '../shared/media/defaultPolicy';

export function applyMediaDefaultParameters(
  params: Record<string, unknown>, defaults: MediaDefaultModel | undefined, type: MediaType,
): Record<string, unknown> {
  if (!defaults) return params;
  const merged = { ...defaults.params, ...params };
  if (type === MediaType.Image) {
    // Default image execution has one output per call; additional calls require confirmation.
    merged.n = 1;
    merged.count = 1;
    merged.sequential_image_generation = 'disabled';
  }
  return merged;
}

/** A turn's snapshot is shared by descendant sessions. Reserve before any await. */
export class MediaDefaultImageBudget {
  private readonly attempts = new WeakMap<MediaDefaultModel, Map<string, boolean>>();

  needsConfirmation(defaults: MediaDefaultModel | undefined, callId: string): boolean {
    if (!defaults) return false;
    const attempts = this.attempts.get(defaults) ?? new Map<string, boolean>();
    if (attempts.has(callId)) return attempts.get(callId)!;
    const needsConfirmation = attempts.size >= defaults.maxOutputsPerTurn;
    attempts.set(callId, needsConfirmation);
    this.attempts.set(defaults, attempts);
    return needsConfirmation;
  }
}
