export const OpenClawSessionIpc = {
  Patch: 'openclaw:session:patch',
} as const;

export type OpenClawSessionIpc =
  typeof OpenClawSessionIpc[keyof typeof OpenClawSessionIpc];
