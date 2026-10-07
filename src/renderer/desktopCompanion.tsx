import './components/desktopCompanion/desktopCompanion.css';

import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';

import { DesktopCompanionSurface } from '../shared/desktopCompanion/constants';
import CompanionOrb from './components/desktopCompanion/CompanionOrb';
import CompanionPanel from './components/desktopCompanion/CompanionPanel';
import CompanionStage from './components/desktopCompanion/CompanionStage';
import SelectionSurface from './components/desktopCompanion/SelectionSurface';
import { useDesktopCompanionState } from './components/desktopCompanion/useDesktopCompanionState';
import { i18nService } from './services/i18n';
import { THEME_APPEARANCE_STORAGE_KEY } from './theme/engine/theme-manager';

const surface = new URLSearchParams(window.location.search).get('surface');

function DesktopCompanion() {
  const { state, error } = useDesktopCompanionState();
  const [, setLanguageRevision] = useState(0);
  useEffect(() => {
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => {
      const appearance = localStorage.getItem(THEME_APPEARANCE_STORAGE_KEY);
      document.documentElement.dataset.appearance = appearance === 'dark' || appearance === 'light'
        ? appearance
        : scheme.matches ? 'dark' : 'light';
      const language = localStorage.getItem('lobster-language');
      if (language === 'zh' || language === 'en') void i18nService.setLanguage(language, { persist: false });
      document.documentElement.lang = i18nService.getLanguage();
      document.documentElement.dataset.surface = surface ?? '';
      document.title = i18nService.t(surface === DesktopCompanionSurface.Panel ? 'desktopCompanionOpenPanel' : 'desktopCompanionTitle');
    };
    const unsubscribe = i18nService.subscribe(() => setLanguageRevision(value => value + 1));
    sync();
    window.addEventListener('storage', sync);
    scheme.addEventListener('change', sync);
    return () => { unsubscribe(); window.removeEventListener('storage', sync); scheme.removeEventListener('change', sync); };
  }, []);
  if (error) return surface === DesktopCompanionSurface.Panel ? <div className="companion-load-error">{i18nService.t('desktopCompanionRequestFailed')}</div> : null;
  if (!state) return null;
  switch (surface) {
    case DesktopCompanionSurface.Mascot: return <CompanionOrb state={state} />;
    case DesktopCompanionSurface.Stage: return <CompanionStage state={state} />;
    case DesktopCompanionSurface.Selection: return <SelectionSurface state={state} />;
    default: return <CompanionPanel state={state} />;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><DesktopCompanion /></React.StrictMode>);
