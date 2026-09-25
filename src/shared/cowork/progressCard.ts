export const ProgressCardStepStatus = {
  Pending: 'pending', InProgress: 'in_progress', Completed: 'completed',
} as const;
export const ProgressCardGatewayMethod = { Get: 'progressCard.get', Put: 'progressCard.put', Refresh: 'progressCard.refresh' } as const;
export const ProgressCardEvent = { Changed: 'progressCardChanged', GatewayChanged: 'progressCard.changed' } as const;
export const PROGRESS_CARD_TOOL_NAME = 'progress_card';

/** OpenClaw v2026.8.1 progressCard.get/put wire contract. */
export interface OpenClawProgressCard {
  sessionKey: string;
  revision: number;
  updatedAt: number;
  markdown?: string;
  steps?: Array<{ step: string; status: 'pending' | 'in_progress' | 'completed' }>;
}
export type ProgressCardResponse = { success: boolean; card?: OpenClawProgressCard | null; error?: string };

export function parseProgressCard(value: unknown, sessionKey: string): OpenClawProgressCard | null {
  if (!value || typeof value !== 'object' || !('card' in value)) throw new Error('Invalid progress card response');
  if (value.card === null) return null;
  const c = value.card as OpenClawProgressCard;
  if (!c || c.sessionKey !== sessionKey || !Number.isSafeInteger(c.revision) || c.revision < 1
    || !Number.isSafeInteger(c.updatedAt) || c.updatedAt < 0
    || (c.markdown !== undefined && typeof c.markdown !== 'string')
    || (c.steps !== undefined && (!Array.isArray(c.steps) || c.steps.some(s => !s || typeof s.step !== 'string'
      || !s.step.trim() || !['pending', 'in_progress', 'completed'].includes(s.status))))
    || (!c.markdown && !c.steps?.length)) throw new Error('Invalid progress card response');
  return { sessionKey: c.sessionKey, revision: c.revision, updatedAt: c.updatedAt, markdown: c.markdown, steps: c.steps };
}

export const ProgressCardRefreshStatus = { Accepted: 'accepted' } as const;

/** Accepted is a baseline receipt, not evidence that a fresh card has arrived. */
export interface ProgressCardRefreshReceipt { runId: string; status: 'accepted'; revision: number }
export type ProgressCardRefreshResponse = { success: boolean; receipt?: ProgressCardRefreshReceipt; error?: string; terminal?: boolean };
export function parseProgressCardRefreshReceipt(value: unknown): ProgressCardRefreshReceipt {
  const receipt = value as ProgressCardRefreshReceipt | null;
  if (!receipt || typeof receipt.runId !== 'string' || !receipt.runId.trim()
    || receipt.status !== ProgressCardRefreshStatus.Accepted || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) {
    throw new Error('Invalid progress refresh receipt');
  }
  return { runId: receipt.runId, status: ProgressCardRefreshStatus.Accepted, revision: receipt.revision };
}
