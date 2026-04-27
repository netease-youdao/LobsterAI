export const OpenClawSessionResponseUsage = {
  Off: 'off',
  Tokens: 'tokens',
  Full: 'full',
} as const;

export type OpenClawSessionResponseUsage =
  typeof OpenClawSessionResponseUsage[keyof typeof OpenClawSessionResponseUsage];

export const OpenClawSessionSendPolicy = {
  Allow: 'allow',
  Deny: 'deny',
} as const;

export type OpenClawSessionSendPolicy =
  typeof OpenClawSessionSendPolicy[keyof typeof OpenClawSessionSendPolicy];

export interface OpenClawSessionPatch {
  model?: string | null;
  thinkingLevel?: string | null;
  reasoningLevel?: string | null;
  elevatedLevel?: string | null;
  responseUsage?: OpenClawSessionResponseUsage | null;
  sendPolicy?: OpenClawSessionSendPolicy | null;
}
