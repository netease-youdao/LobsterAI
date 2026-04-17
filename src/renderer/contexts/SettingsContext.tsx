import { createContext, useContext } from 'react';

import type { SettingsOpenOptions } from '@/components/Settings';

type SettingsContextValue = {
  openSettings: (options?: SettingsOpenOptions) => void;
};

const SettingsContext = createContext<SettingsContextValue>({
  openSettings: () => {},
});

export const SettingsProvider = SettingsContext.Provider;

export function useSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
