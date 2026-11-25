import React, { createContext, useContext, useEffect } from 'react';

export interface OfficePreviewZoomControlsConfig {
  zoomFactor: number;
  displayZoomFactor?: number;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onResetZoom: () => void;
}

export interface OfficePreviewSaveStatusConfig {
  label: string;
  isSaved: boolean;
  isReadOnly: boolean;
  canSave: boolean;
  isBusy: boolean;
  draftSafe?: boolean;
  onSave: () => void;
}

interface OfficePreviewActionsContextValue {
  setZoomControls: React.Dispatch<React.SetStateAction<OfficePreviewZoomControlsConfig | null>>;
  setSaveStatus?: React.Dispatch<React.SetStateAction<OfficePreviewSaveStatusConfig | null>>;
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

export function useRegisterOfficePreviewSaveStatus(
  status: OfficePreviewSaveStatusConfig | null,
): void {
  const actions = useOfficePreviewActions();

  useEffect(() => {
    const setSaveStatus = actions?.setSaveStatus;
    if (!setSaveStatus || !status) return undefined;

    setSaveStatus(status);
    return () => {
      setSaveStatus(current => (current === status ? null : current));
    };
  }, [actions, status]);
}
