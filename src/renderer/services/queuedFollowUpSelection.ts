import type { CoworkPendingSteer } from '../../shared/cowork/steer';

/**
 * Selects the exact requested follow-up, or the queue head for normal FIFO
 * processing. A missing requested item must not fall back to another message.
 */
export const selectQueuedFollowUp = (
  pendingSteers: readonly CoworkPendingSteer[],
  requestedSteerId?: string | null,
): CoworkPendingSteer | undefined => {
  if (requestedSteerId !== undefined && requestedSteerId !== null) {
    return pendingSteers.find(steer => steer.id === requestedSteerId);
  }

  return pendingSteers[0];
};
