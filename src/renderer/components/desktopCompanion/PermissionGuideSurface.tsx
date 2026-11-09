import './permissionGuide.css';

import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { ArrowUpIcon } from '@heroicons/react/24/solid';
import { useEffect, useId, useState } from 'react';

import { CompanionPermission } from '../../../shared/desktopCompanion/constants';
import { type CompanionPermissionGuideInfo, CompanionPermissionGuideStage } from '../../../shared/desktopCompanion/permissionGuide';
import { i18nService } from '../../services/i18n';
import LobsterMark from './mascot/LobsterMark';

const t = (key: string) => i18nService.t(key);

const INTRO_COPY_KEYS: Record<CompanionPermission, string> = {
  [CompanionPermission.Accessibility]: 'desktopCompanionPermissionIntroAccessibility',
  [CompanionPermission.ScreenRecording]: 'desktopCompanionPermissionIntroScreenRecording',
};

/** Drawn after the System Settings icons, so the row matches what the user looks for there. */
function PermissionIcon({ permission }: { permission: CompanionPermission }) {
  const gradient = useId();
  const [from, to] = permission === CompanionPermission.ScreenRecording ? ['#ff6b5e', '#ec3a2e'] : ['#4ba3ff', '#1677f2'];
  return (
    <svg className="permission-intro-icon" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="7.5" fill={`url(#${gradient})`} />
      {permission === CompanionPermission.ScreenRecording ? (
        <>
          <circle cx="16" cy="16" r="8.4" fill="none" stroke="#fff" strokeWidth="2.4" />
          <circle cx="16" cy="16" r="4.4" fill="#fff" />
        </>
      ) : (
        <g fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
          <circle cx="16" cy="16" r="10" strokeWidth="1.8" />
          <circle cx="16" cy="10.6" r="1.6" fill="#fff" stroke="none" />
          <path d="M10.5 13.6h11M16 13.6v5M16 18.6l-2.8 4.4M16 18.6l2.8 4.4" />
        </g>
      )}
    </svg>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="permission-guide-close" aria-label={t('desktopCompanionPermissionGuideClose')}
      title={t('desktopCompanionPermissionGuideClose')} onClick={onClose}>
      <XMarkIcon aria-hidden="true" />
    </button>
  );
}

/** Explains the permission where the feature needed it; 去开启 turns this card into the guide. */
function PermissionIntro({ info, onProceed, onClose }: {
  info: CompanionPermissionGuideInfo;
  onProceed: () => void;
  onClose: () => void;
}) {
  const pane = t(info.paneKey);
  const titleId = useId();
  const detailId = useId();
  return (
    <section className="permission-guide-card permission-intro" role="dialog" aria-labelledby={titleId} aria-describedby={detailId}>
      <div className="permission-intro-head">
        <h2 id={titleId} className="permission-intro-title">{t('desktopCompanionPermissionIntroTitle').replace('{pane}', pane)}</h2>
        <CloseButton onClose={onClose} />
      </div>
      <p id={detailId} className="permission-intro-detail">{t(INTRO_COPY_KEYS[info.permission]).replace('{name}', info.appName)}</p>
      <button type="button" className="permission-intro-row" onClick={onProceed}>
        <PermissionIcon permission={info.permission} />
        <span className="permission-intro-pane">{pane}</span>
        <span className="permission-intro-action">
          {t('desktopCompanionPermissionIntroOpen')}
          <ChevronRightIcon aria-hidden="true" />
        </span>
      </button>
    </section>
  );
}

/** Floats beside System Settings: names the app to switch on, and offers it to drag in when it is not listed. */
function PermissionGuide({ info, onClose }: { info: CompanionPermissionGuideInfo; onClose: () => void }) {
  const api = window.electron.desktopCompanion;
  const [relaunching, setRelaunching] = useState(false);
  const message = t('desktopCompanionPermissionGuideList').replace('{name}', info.appName);
  return (
    <section className="permission-guide-card" aria-label={message}>
      <div className="permission-guide-head">
        <ArrowUpIcon className="permission-guide-arrow" aria-hidden="true" />
        <p className="permission-guide-message">{message}</p>
        <CloseButton onClose={onClose} />
      </div>
      <div
        className="permission-guide-app"
        draggable
        role="img"
        aria-label={`${info.appName} · ${t('desktopCompanionPermissionGuideDrag')}`}
        title={t('desktopCompanionPermissionGuideDrag')}
        onDragStart={event => {
          // The main process drags the app bundle itself; the page's own drag would carry nothing.
          event.preventDefault();
          api.dragPermissionGuideApp();
        }}
      >
        {info.appIcon
          ? <img className="permission-guide-app-icon" src={info.appIcon} alt="" draggable={false} />
          : <LobsterMark size={36} />}
        <span className="permission-guide-app-name">{info.appName}</span>
        <span className="permission-guide-app-hint">{t('desktopCompanionPermissionGuideDrag')}</span>
      </div>
      {info.relaunchRequired && (
        <p className="permission-guide-relaunch">
          {t('desktopCompanionPermissionGuideRelaunchNote').replace('{name}', info.appName)}
          <button type="button" className="permission-guide-relaunch-button" disabled={relaunching}
            onClick={() => {
              setRelaunching(true);
              void api.relaunchForPermission().catch(() => setRelaunching(false));
            }}>
            {t('desktopCompanionPermissionGuideRelaunch')}
          </button>
        </p>
      )}
    </section>
  );
}

export default function PermissionGuideSurface() {
  const api = window.electron.desktopCompanion;
  const [info, setInfo] = useState<CompanionPermissionGuideInfo | null>(null);
  const intro = info?.stage === CompanionPermissionGuideStage.Intro;

  useEffect(() => {
    let active = true;
    void api.getPermissionGuide()
      .then(value => { if (active) setInfo(value); })
      .catch(() => { if (active) setInfo(null); });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!intro) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') void api.closePermissionGuide(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api, intro]);

  if (!info) return null;
  const close = () => { void api.closePermissionGuide(); };
  return (
    <div className="permission-guide">
      {intro
        ? <PermissionIntro info={info} onClose={close} onProceed={() => {
          void api.proceedPermissionGuide().then(next => { if (next) setInfo(next); }).catch(close);
        }} />
        : <PermissionGuide info={info} onClose={close} />}
    </div>
  );
}
