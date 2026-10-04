/**
 * OpenClaw's native progress card: the plan or status note an agent keeps
 * current with its `progress_card` tool, persisted per session by the
 * Gateway (`progressCard.get`/`put`, `progressCard.changed`).
 */
export const ProgressCardStepStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Completed: 'completed',
} as const;
export type ProgressCardStepStatus = typeof ProgressCardStepStatus[keyof typeof ProgressCardStepStatus];

export const ProgressCardGatewayMethod = {
  Get: 'progressCard.get',
  Put: 'progressCard.put',
} as const;

export const ProgressCardEvent = {
  /** Runtime → router → main process: a watched session's card changed. */
  Changed: 'progressCardChanged',
  /** Gateway broadcast after any card write or clear. */
  GatewayChanged: 'progressCard.changed',
} as const;

/** Wire shape of OpenClaw v2026.8.1 `progressCard.get`/`put` results. */
export interface OpenClawProgressCard {
  sessionKey: string;
  revision: number;
  updatedAt: number;
  markdown?: string;
  steps?: Array<{ step: string; status: ProgressCardStepStatus }>;
}

export type ProgressCardResponse = {
  success: boolean;
  card?: OpenClawProgressCard | null;
  error?: string;
};

const STEP_STATUSES = new Set<string>(Object.values(ProgressCardStepStatus));

/**
 * The Gateway canonicalizes session keys before storing a card (for example
 * lowercasing channel conversation ids), so the key a card comes back with
 * may differ in case from the one it was requested with.
 */
export const isSameProgressCardSessionKey = (left: string, right: string): boolean => (
  left.trim().toLowerCase() === right.trim().toLowerCase()
);

const isValidStep = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const step = value as { step?: unknown; status?: unknown };
  return typeof step.step === 'string'
    && step.step.trim() !== ''
    && typeof step.status === 'string'
    && STEP_STATUSES.has(step.status);
};

/**
 * Validates a `progressCard.get`/`put` result for the requested session:
 * null when the session has no card, the card otherwise. Throws on anything
 * malformed or belonging to another session.
 */
export const parseProgressCard = (value: unknown, sessionKey: string): OpenClawProgressCard | null => {
  if (!value || typeof value !== 'object' || !('card' in value)) {
    throw new Error('Invalid progress card response');
  }
  const raw = (value as { card: unknown }).card;
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid progress card response');
  }
  const card = raw as Partial<OpenClawProgressCard>;
  const hasValidSteps = card.steps === undefined
    || (Array.isArray(card.steps) && card.steps.every(isValidStep));
  const isValid = typeof card.sessionKey === 'string'
    && isSameProgressCardSessionKey(card.sessionKey, sessionKey)
    && Number.isSafeInteger(card.revision) && (card.revision as number) >= 1
    && Number.isSafeInteger(card.updatedAt) && (card.updatedAt as number) >= 0
    && (card.markdown === undefined || typeof card.markdown === 'string')
    && hasValidSteps
    && Boolean(card.markdown?.trim() || card.steps?.length);
  if (!isValid) {
    throw new Error('Invalid progress card response');
  }
  return {
    sessionKey: card.sessionKey as string,
    revision: card.revision as number,
    updatedAt: card.updatedAt as number,
    ...(card.markdown !== undefined ? { markdown: card.markdown } : {}),
    ...(card.steps !== undefined ? { steps: card.steps } : {}),
  };
};
