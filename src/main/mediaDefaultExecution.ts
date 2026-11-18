import { type MediaDefaultModel, MediaType } from '../shared/media/defaultPolicy';

const normalizeOutputFormat = (params: Record<string, unknown>): Record<string, unknown> => {
  const { outputFormat, ...normalized } = params;
  if (outputFormat != null && normalized.output_format == null) normalized.output_format = outputFormat;
  return normalized;
};

export function applyMediaDefaultParameters(
  params: Record<string, unknown>, defaults: MediaDefaultModel | undefined, type: MediaType,
): Record<string, unknown> {
  const explicit = type === MediaType.Image ? normalizeOutputFormat(params) : params;
  if (!defaults) return explicit;
  const fallback = type === MediaType.Image ? normalizeOutputFormat(defaults.params) : defaults.params;
  const merged = { ...fallback, ...explicit };
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
  private readonly declined = new WeakSet<MediaDefaultModel>();
  private readonly turnGroups = new WeakMap<MediaDefaultModel, string>();
  private readonly turnApprovals = new WeakMap<MediaDefaultModel, Set<string>>();
  private nextTurnGroup = 0;

  /** Groups one turn's confirmations for one model, so one turn approval can cover its queued requests. */
  turnGroup(defaults: MediaDefaultModel | undefined, model: string): string | undefined {
    if (!defaults) return undefined;
    let group = this.turnGroups.get(defaults);
    if (!group) {
      group = `image-turn-${++this.nextTurnGroup}`;
      this.turnGroups.set(defaults, group);
    }
    return JSON.stringify([group, model]);
  }

  /** The user approved the rest of this turn for one model at one quote; a new price asks again. */
  approveTurn(defaults: MediaDefaultModel | undefined, model: string, quote: string): void {
    if (!defaults) return;
    const approvals = this.turnApprovals.get(defaults) ?? new Set<string>();
    approvals.add(JSON.stringify([model, quote]));
    this.turnApprovals.set(defaults, approvals);
  }

  isTurnApproved(defaults: MediaDefaultModel | undefined, model: string, quote: string): boolean {
    return defaults !== undefined && this.turnApprovals.get(defaults)?.has(JSON.stringify([model, quote])) === true;
  }

  decline(defaults: MediaDefaultModel | undefined): void {
    if (defaults) this.declined.add(defaults);
  }

  wasDeclined(defaults: MediaDefaultModel | undefined): boolean {
    return defaults !== undefined && this.declined.has(defaults);
  }

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
