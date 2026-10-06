import React, { createContext, useContext, useEffect } from 'react';

export interface OfficePreviewZoomControlsConfig {
  zoomFactor: number;
  displayZoomFactor?: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetZoom: () => void;
}

interface OfficePreviewActionsContextValue {
  setZoomControls: React.Dispatch<React.SetStateAction<OfficePreviewZoomControlsConfig | null>>;
}

export const OfficePreviewActionsContext = createContext<OfficePreviewActionsContextValue | null>(null);

export function useOfficePreviewActions(): OfficePreviewActionsContextValue | null {
  return useContext(OfficePreviewActionsContext);
}

export function useRegisterOfficePreviewZoomControls(
  controls: OfficePreviewZoomControlsConfig | null,
): void {
  const actions = useOfficePreviewActions();

  useEffect(() => {
    if (!actions || !controls) return undefined;

    actions.setZoomControls(controls);
    return () => {
      actions.setZoomControls(current => (current === controls ? null : current));
    };
  }, [actions, controls]);
}
