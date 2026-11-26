import React, { createContext, useContext, useEffect, useLayoutEffect } from 'react';

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

export interface OfficePreviewDocumentActions {
  canShare: boolean;
  onShare: () => void;
  canDownload: boolean;
  onDownload: () => void;
  canRefresh: boolean;
  onRefresh: () => void;
  canRevealInFolder: boolean;
  onRevealInFolder: () => void;
  canOpenFileList: boolean;
  onOpenFileList?: () => void;
  isFileListDrawerOpen?: boolean;
  fileListButtonRef?: React.RefObject<HTMLButtonElement>;
}

interface OfficePreviewActionsContextValue {
  setZoomControls: React.Dispatch<React.SetStateAction<OfficePreviewZoomControlsConfig | null>>;
  setSaveStatus?: React.Dispatch<React.SetStateAction<OfficePreviewSaveStatusConfig | null>>;
  setOwnsDocumentToolbar?: React.Dispatch<React.SetStateAction<boolean>>;
  documentActions?: OfficePreviewDocumentActions | null;
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

export function useRegisterOfficeOwnsDocumentToolbar(owns: boolean): void {
  const actions = useOfficePreviewActions();

  useLayoutEffect(() => {
    const setOwns = actions?.setOwnsDocumentToolbar;
    if (!setOwns || !owns) return undefined;

    setOwns(true);
    return () => {
      setOwns(false);
    };
  }, [actions, owns]);
}
