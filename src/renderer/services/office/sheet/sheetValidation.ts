/** What Excel's error alert lets the user do with an entry a data validation rule refuses. */
export const ValidationAlertChoice = {
  /** Warning "Yes", information "OK": keep the entry. */
  Keep: 'keep',
  /** Stop "Retry", warning "No": enter it again, starting from what was typed. */
  Retry: 'retry',
  /** "Cancel": drop the entry. */
  Discard: 'discard',
} as const;
export type ValidationAlertChoice = typeof ValidationAlertChoice[keyof typeof ValidationAlertChoice];
