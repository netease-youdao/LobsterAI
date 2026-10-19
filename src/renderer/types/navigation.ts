export const MainView = {
  Cowork: 'cowork',
  Experts: 'experts',
  Kits: 'kits',
  Skills: 'skills',
  Connectors: 'mcp',
  ScheduledTasks: 'scheduledTasks',
  Library: 'library',
} as const;
export type MainView = typeof MainView[keyof typeof MainView];
