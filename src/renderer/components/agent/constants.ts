export const AgentDetailTab = {
  Prompt: 'prompt',
  Identity: 'identity',
  User: 'user',
  Skills: 'skills',
  Collaboration: 'collaboration',
  Im: 'im',
} as const;

export type AgentDetailTab = typeof AgentDetailTab[keyof typeof AgentDetailTab];

export const AgentPersonaFileTab = {
  Identity: 'IDENTITY.md',
  Soul: 'SOUL.md',
  User: 'USER.md',
} as const;

export type AgentPersonaFileTab = typeof AgentPersonaFileTab[keyof typeof AgentPersonaFileTab];

export const AgentConfirmDialogVariant = {
  Unsaved: 'unsaved',
  Delete: 'delete',
} as const;

export type AgentConfirmDialogVariant = typeof AgentConfirmDialogVariant[keyof typeof AgentConfirmDialogVariant];
