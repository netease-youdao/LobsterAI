export const AppQuitDialogIpc = {
  Ready: 'appQuitDialog:ready',
  Respond: 'appQuitDialog:respond',
} as const;

export type AppQuitDialogIpc = typeof AppQuitDialogIpc[keyof typeof AppQuitDialogIpc];
