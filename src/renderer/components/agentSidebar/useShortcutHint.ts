import { useEffect, useState } from 'react';

import { defaultConfig, type ShortcutAction } from '../../config';
import { configService, ConfigServiceEvent } from '../../services/config';
import { formatShortcutHint } from '../../services/shortcuts';

const readShortcutHint = (action: ShortcutAction): string => {
  const binding = configService.getConfig().shortcuts?.[action] ?? defaultConfig.shortcuts?.[action];
  const isMac = typeof window !== 'undefined' && window.electron?.platform === 'darwin';
  return formatShortcutHint(binding, { isMac });
};

// Current binding of a shortcut action in tooltip form ("⌘K"), kept in sync with Settings.
export const useShortcutHint = (action: ShortcutAction): string => {
  const [hint, setHint] = useState(() => readShortcutHint(action));

  useEffect(() => {
    const sync = () => setHint(readShortcutHint(action));
    sync();
    window.addEventListener(ConfigServiceEvent.Updated, sync);
    return () => window.removeEventListener(ConfigServiceEvent.Updated, sync);
  }, [action]);

  return hint;
};
