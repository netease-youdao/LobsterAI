/**
 * About tab content for the Settings dialog.
 * Self-contained component that manages its own state for version checking,
 * email copying, log export, and developer test mode.
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { i18nService, LanguageType } from '../../services/i18n';
import { checkForAppUpdate } from '../../services/appUpdate';
import type { AppUpdateInfo } from '../../services/appUpdate';
import {
  ABOUT_CONTACT_EMAIL,
  ABOUT_USER_MANUAL_URL,
  ABOUT_SERVICE_TERMS_URL,
  copyTextToClipboard,
} from './settingsTypes';

interface AboutTabProps {
  language: LanguageType;
  testMode: boolean;
  setTestMode: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (error: string | null) => void;
  setNoticeMessage: (message: string | null) => void;
  onUpdateFound?: (info: AppUpdateInfo) => void;
}

const AboutTab: React.FC<AboutTabProps> = ({
  language,
  testMode,
  setTestMode,
  setError,
  setNoticeMessage,
  onUpdateFound,
}) => {
  const [appVersion, setAppVersion] = useState('');
  const [emailCopied, setEmailCopied] = useState(false);
  const [isExportingLogs, setIsExportingLogs] = useState(false);
  const [logoClickCount, setLogoClickCount] = useState(0);
  const [testModeUnlocked, setTestModeUnlocked] = useState(testMode);
  const [updateCheckStatus, setUpdateCheckStatus] = useState<'idle' | 'checking' | 'upToDate' | 'error'>('idle');

  const emailCopiedTimerRef = useRef<number | null>(null);
  const updateCheckTimerRef = useRef<number | null>(null);

  useEffect(() => {
    window.electron.appInfo.getVersion().then(setAppVersion);
  }, []);

  useEffect(() => () => {
    if (emailCopiedTimerRef.current != null) {
      window.clearTimeout(emailCopiedTimerRef.current);
    }
    if (updateCheckTimerRef.current != null) {
      window.clearTimeout(updateCheckTimerRef.current);
    }
  }, []);

  const handleCopyContactEmail = useCallback(async () => {
    const copied = await copyTextToClipboard(ABOUT_CONTACT_EMAIL);
    if (copied) {
      setEmailCopied(true);
      if (emailCopiedTimerRef.current != null) {
        window.clearTimeout(emailCopiedTimerRef.current);
      }
      emailCopiedTimerRef.current = window.setTimeout(() => {
        setEmailCopied(false);
        emailCopiedTimerRef.current = null;
      }, 1200);
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    if (updateCheckStatus === 'checking' || !appVersion) return;
    setUpdateCheckStatus('checking');
    try {
      const info = await checkForAppUpdate(appVersion, true);
      if (info) {
        setUpdateCheckStatus('idle');
        onUpdateFound?.(info);
      } else {
        setUpdateCheckStatus('upToDate');
        if (updateCheckTimerRef.current != null) {
          window.clearTimeout(updateCheckTimerRef.current);
        }
        updateCheckTimerRef.current = window.setTimeout(() => {
          setUpdateCheckStatus('idle');
          updateCheckTimerRef.current = null;
        }, 3000);
      }
    } catch {
      setUpdateCheckStatus('error');
      if (updateCheckTimerRef.current != null) {
        window.clearTimeout(updateCheckTimerRef.current);
      }
      updateCheckTimerRef.current = window.setTimeout(() => {
        setUpdateCheckStatus('idle');
        updateCheckTimerRef.current = null;
      }, 3000);
    }
  }, [appVersion, updateCheckStatus, onUpdateFound]);

  const handleOpenUserManual = useCallback(() => {
    void window.electron.shell.openExternal(ABOUT_USER_MANUAL_URL);
  }, []);

  const handleOpenServiceTerms = useCallback(() => {
    void window.electron.shell.openExternal(ABOUT_SERVICE_TERMS_URL);
  }, []);

  const handleExportLogs = useCallback(async () => {
    if (isExportingLogs) return;

    setError(null);
    setNoticeMessage(null);
    setIsExportingLogs(true);
    try {
      const result = await window.electron.log.exportZip();
      if (!result.success) {
        setError(result.error || i18nService.t('aboutExportLogsFailed'));
        return;
      }
      if (result.canceled) return;

      if (result.path) {
        await window.electron.shell.showItemInFolder(result.path);
      }

      if ((result.missingEntries?.length ?? 0) > 0) {
        const missingList = result.missingEntries?.join(', ') || '';
        setNoticeMessage(`${i18nService.t('aboutExportLogsPartial')}: ${missingList}`);
      } else {
        setNoticeMessage(i18nService.t('aboutExportLogsSuccess'));
      }
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : i18nService.t('aboutExportLogsFailed'));
    } finally {
      setIsExportingLogs(false);
    }
  }, [isExportingLogs, setError, setNoticeMessage]);

  return (
    <div className="flex min-h-full flex-col items-center pt-6 pb-3">
      {/* Logo & App Name */}
      <img
        src="logo.png"
        alt="LobsterAI"
        className="w-16 h-16 mb-3 cursor-pointer select-none"
        onClick={() => {
          const next = logoClickCount + 1;
          setLogoClickCount(next);
          if (next >= 10 && !testModeUnlocked) {
            setTestModeUnlocked(true);
          }
        }}
      />
      <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">LobsterAI</h3>
      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">v{appVersion}</span>

      {/* Info Card */}
      <div className="w-full mt-8 rounded-xl border border-claude-border dark:border-claude-darkBorder overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-claude-border dark:border-claude-darkBorder">
          <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('aboutVersion')}</span>
          <div className="flex items-center gap-2">
            <span className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{appVersion}</span>
            <button
              type="button"
              disabled={updateCheckStatus === 'checking'}
              onClick={(e) => {
                e.stopPropagation();
                void handleCheckUpdate();
              }}
              className="text-xs px-2 py-0.5 rounded-md border border-claude-border dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent hover:border-claude-accent dark:hover:border-claude-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {updateCheckStatus === 'checking' && i18nService.t('updateChecking')}
              {updateCheckStatus === 'upToDate' && i18nService.t('updateUpToDate')}
              {updateCheckStatus === 'error' && i18nService.t('updateCheckFailed')}
              {updateCheckStatus === 'idle' && i18nService.t('checkForUpdate')}
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-claude-border dark:border-claude-darkBorder">
          <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('aboutContactEmail')}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleCopyContactEmail();
              }}
              title={i18nService.t('copyToClipboard')}
              className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary bg-transparent border-none appearance-none p-0 m-0 cursor-pointer focus:outline-none"
            >
              {ABOUT_CONTACT_EMAIL}
            </button>
            {emailCopied && (
              <span className="text-[11px] leading-4 text-emerald-600 dark:text-emerald-400">
                {language === 'zh' ? '已复制' : 'Copied'}
              </span>
            )}
          </div>
        </div>
        <div className={`flex items-center justify-between px-4 py-3${testModeUnlocked ? ' border-b border-claude-border dark:border-claude-darkBorder' : ''}`}>
          <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('aboutUserManual')}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleOpenUserManual();
            }}
            className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer focus:outline-none dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            {ABOUT_USER_MANUAL_URL}
          </button>
        </div>
        {testModeUnlocked && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('testMode')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={testMode}
              onClick={() => setTestMode((prev) => !prev)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                testMode ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  testMode ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-auto w-full pt-14 pb-2 flex flex-col items-center">
        <div className="flex items-center justify-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleOpenServiceTerms();
            }}
            className="bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
          >
            {i18nService.t('aboutServiceTerms')}
          </button>
          <span className="mx-3 text-xs opacity-40">|</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleExportLogs();
            }}
            disabled={isExportingLogs}
            className="bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer hover:text-claude-accent dark:hover:text-claude-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExportingLogs ? i18nService.t('aboutExportingLogs') : i18nService.t('aboutExportLogs')}
          </button>
        </div>

        <p className="mt-5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {language === 'zh' ? '网易有道 版权所有' : 'NetEase Youdao. All rights reserved.'}
        </p>
        <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          Copyright &copy; {new Date().getFullYear()} NetEase Youdao. All Rights Reserved.
        </p>
      </div>
    </div>
  );
};

export default AboutTab;
