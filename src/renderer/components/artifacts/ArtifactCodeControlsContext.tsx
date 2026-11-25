import React, { createContext, useContext, useEffect } from 'react';

export interface ArtifactCodeControlsConfig {
  languageLabel: string;
  wrapLines: boolean;
  onToggleWrapLines: () => void;
  copied: boolean;
  onCopyCode: () => void;
}

interface ArtifactCodeControlsContextValue {
  setCodeControls: React.Dispatch<React.SetStateAction<ArtifactCodeControlsConfig | null>>;
}

export const ArtifactCodeControlsContext = createContext<ArtifactCodeControlsContextValue | null>(null);

export function useArtifactCodeControlsHost(): ArtifactCodeControlsContextValue | null {
  return useContext(ArtifactCodeControlsContext);
}

export function useRegisterArtifactCodeControls(
  controls: ArtifactCodeControlsConfig | null,
): void {
  const host = useArtifactCodeControlsHost();

  useEffect(() => {
    if (!host || !controls) return undefined;

    host.setCodeControls(controls);
    return () => {
      host.setCodeControls(current => (current === controls ? null : current));
    };
  }, [controls, host]);
}
