/**
 * Escape handling for the settings panel.
 *
 * The panel stacks several confirmations that are plain absolutely-positioned
 * layers rather than portalled modals, so Escape has to dismiss the innermost
 * open one first and close the panel only when nothing is stacked on top.
 * Dialogs rendered through `Modal` handle Escape on their own.
 */

export const SettingsEscapeAction = {
  /** A long-running operation owns the panel; Escape does nothing. */
  Ignore: 'ignore',
  DismissLayer: 'dismissLayer',
  ClosePanel: 'closePanel',
} as const;
export type SettingsEscapeAction = typeof SettingsEscapeAction[keyof typeof SettingsEscapeAction];

export interface SettingsEscapeLayer {
  isOpen: boolean;
  dismiss: () => void;
}

export interface SettingsEscapeInput {
  /** True while a backup/restore/repair/clean runs, or while a shortcut is being recorded. */
  isBlocked: boolean;
  /** Layers stacked inside the panel, topmost first. */
  layers: readonly SettingsEscapeLayer[];
}

export type SettingsEscapeResolution =
  | { action: typeof SettingsEscapeAction.Ignore }
  | { action: typeof SettingsEscapeAction.DismissLayer; dismiss: () => void }
  | { action: typeof SettingsEscapeAction.ClosePanel };

export const resolveSettingsEscapeAction = (
  { isBlocked, layers }: SettingsEscapeInput,
): SettingsEscapeResolution => {
  if (isBlocked) return { action: SettingsEscapeAction.Ignore };

  const openLayer = layers.find(layer => layer.isOpen);
  if (openLayer) {
    return { action: SettingsEscapeAction.DismissLayer, dismiss: openLayer.dismiss };
  }

  return { action: SettingsEscapeAction.ClosePanel };
};
