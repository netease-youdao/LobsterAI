import { useState } from 'react';

import { authService } from '../../services/auth';
import { configService } from '../../services/config';
import { i18nService } from '../../services/i18n';
import { SelectionError } from './SelectionCard';

/** Companion windows use the same portal resolution and callback flow as the main window. */
export default function SelectionLoginRequired() {
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const login = async () => {
    if (opening) return;
    setOpening(true);
    setFailed(false);
    try {
      await configService.init();
      const result = await authService.login();
      setFailed(!result.success);
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };
  return (
    <SelectionError
      message={i18nService.t(failed ? 'desktopToolsLoginFailed' : 'desktopToolsLoginRequired')}
      action={<button type="button" disabled={opening} onClick={() => { void login(); }}>{i18nService.t('desktopToolsLogin')}</button>}
    />
  );
}
