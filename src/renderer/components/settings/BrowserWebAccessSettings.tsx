import { PlusIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  BrowserCredentialSaveMode,
  type BrowserCredentialSaveMode as BrowserCredentialSaveModeValue,
  BrowserCredentialUseMode,
  type BrowserCredentialUseMode as BrowserCredentialUseModeValue,
} from '../../../shared/browserCredentials/constants';
import {
  BrowserDisplayMode,
  type BrowserWebAccessConfig,
  normalizeBrowserCdpUrl,
  normalizeBrowserHostnameList,
} from '../../../shared/browserWebAccess/constants';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';
import ThemedSelect from '../ui/ThemedSelect';
import BrowserCredentialSettings from './BrowserCredentialSettings';
import {
  type RegisterSettingsDirtyGuard,
  SETTINGS_FORM_SAVED_RESET_MS,
  SettingsFormFooterMode,
  SettingsFormStatus,
} from './settingsDirtyGuard';
import { SettingsFormFooter, SettingsFormStatusBadge } from './SettingsFormFooter';
import {
  SETTINGS_ACTION_BUTTON_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SettingsCard,
  SettingsCardMessage,
  SettingsItem,
  SettingsSection,
} from './SettingsLayout';
import { SETTINGS_DESCRIPTION_TEXT } from './settingsTypography';

interface BrowserWebAccessSettingsProps {
  value: BrowserWebAccessConfig;
  onCommit: (value: BrowserWebAccessConfig) => Promise<boolean>;
  onRegisterDirtyGuard?: RegisterSettingsDirtyGuard;
}

const HostnameListTarget = {
  BlockedHostnames: 'blockedHostnames',
} as const;

type HostnameListTarget = typeof HostnameListTarget[keyof typeof HostnameListTarget];

const SELECT_WIDTH_CLASS = 'w-64';

const HostnameList: React.FC<{
  title: string;
  description: string;
  hostnames: string[];
  onAdd: () => void;
  onRemove: (hostname: string) => void;
}> = ({ title, description, hostnames, onAdd, onRemove }) => (
  <SettingsSection
    title={title}
    description={description}
    action={(
      <button type="button" onClick={onAdd} className={SETTINGS_ACTION_BUTTON_CLASS}>
        <PlusIcon className="h-3.5 w-3.5" />
        {i18nService.t('add')}
      </button>
    )}
  >
    <SettingsCard>
      {hostnames.length > 0 ? (
        hostnames.map(hostname => (
          <div key={hostname} className="flex items-center justify-between gap-3 px-4 py-2">
            <span className={`truncate ${SETTINGS_DESCRIPTION_TEXT} text-foreground`}>{hostname}</span>
            <button
              type="button"
              onClick={() => onRemove(hostname)}
              className={SETTINGS_ICON_BUTTON_CLASS}
              title={i18nService.t('delete')}
              aria-label={i18nService.t('delete')}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        ))
      ) : (
        <SettingsCardMessage>{i18nService.t('browserHostnameListEmpty')}</SettingsCardMessage>
      )}
    </SettingsCard>
  </SettingsSection>
);

const BrowserWebAccessSettings: React.FC<BrowserWebAccessSettingsProps> = ({
  value,
  onCommit,
  onRegisterDirtyGuard,
}) => {
  const [hostnameDialogTarget, setHostnameDialogTarget] = useState<HostnameListTarget | null>(null);
  const [hostnameDraft, setHostnameDraft] = useState('');
  const [externalDraft, setExternalDraft] = useState(() => ({
    executablePath: value.executablePath ?? '',
    cdpUrl: value.cdpUrl ?? '',
  }));
  const [formStatus, setFormStatus] = useState<SettingsFormStatus>(SettingsFormStatus.Idle);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hostnameInputRef = useRef<HTMLInputElement>(null);
  const savedTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    };
  }, []);

  const savedExecutablePath = value.executablePath ?? '';
  const savedCdpUrl = value.cdpUrl ?? '';
  const external = value.displayMode === BrowserDisplayMode.External;
  const isExternalDirty = external && (
    externalDraft.executablePath.trim() !== savedExecutablePath.trim()
    || externalDraft.cdpUrl.trim() !== savedCdpUrl.trim()
  );

  // Keep draft aligned with persisted config whenever there are no local unsaved edits.
  useEffect(() => {
    setExternalDraft({
      executablePath: savedExecutablePath,
      cdpUrl: savedCdpUrl,
    });
  }, [savedExecutablePath, savedCdpUrl]);

  useEffect(() => {
    if (hostnameDialogTarget) {
      hostnameInputRef.current?.focus();
    }
  }, [hostnameDialogTarget]);

  const clearSavedTimer = useCallback(() => {
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
      savedTimerRef.current = null;
    }
  }, []);

  const commitImmediate = useCallback(async (patch: Partial<BrowserWebAccessConfig>) => {
    setSaveError(null);
    const nextConfig: BrowserWebAccessConfig = {
      ...value,
      ...patch,
    };
    await onCommit(nextConfig);
  }, [onCommit, value]);

  const handleDisplayModeChange = useCallback((displayMode: BrowserDisplayMode) => {
    if (displayMode !== BrowserDisplayMode.External) {
      clearSavedTimer();
      setExternalDraft({
        executablePath: savedExecutablePath,
        cdpUrl: savedCdpUrl,
      });
      setFormStatus(SettingsFormStatus.Idle);
      setSaveError(null);
    }
    void commitImmediate({ displayMode });
  }, [clearSavedTimer, commitImmediate, savedCdpUrl, savedExecutablePath]);

  const updateHostnames = (hostnames: string[]) => {
    void commitImmediate({ blockedHostnames: normalizeBrowserHostnameList(hostnames) });
  };

  const trimmedCdpUrl = externalDraft.cdpUrl.trim();
  const cdpUrlInvalid = external && Boolean(trimmedCdpUrl) && !normalizeBrowserCdpUrl(trimmedCdpUrl);

  const handleExternalDraftChange = useCallback((patch: Partial<{ executablePath: string; cdpUrl: string }>) => {
    clearSavedTimer();
    setSaveError(null);
    setExternalDraft(prev => {
      const next = { ...prev, ...patch };
      const nextDirty = next.executablePath.trim() !== savedExecutablePath.trim()
        || next.cdpUrl.trim() !== savedCdpUrl.trim();
      setFormStatus(nextDirty ? SettingsFormStatus.Dirty : SettingsFormStatus.Idle);
      return next;
    });
  }, [clearSavedTimer, savedCdpUrl, savedExecutablePath]);

  const handleDiscardExternal = useCallback(() => {
    clearSavedTimer();
    setExternalDraft({
      executablePath: savedExecutablePath,
      cdpUrl: savedCdpUrl,
    });
    setSaveError(null);
    setFormStatus(SettingsFormStatus.Idle);
  }, [clearSavedTimer, savedCdpUrl, savedExecutablePath]);

  const handleSaveExternal = useCallback(async (): Promise<boolean> => {
    if (!external || cdpUrlInvalid || !isExternalDirty) {
      return !cdpUrlInvalid;
    }
    clearSavedTimer();
    setFormStatus(SettingsFormStatus.Saving);
    setSaveError(null);
    try {
      const ok = await onCommit({
        ...value,
        executablePath: externalDraft.executablePath.trim() || undefined,
        cdpUrl: externalDraft.cdpUrl.trim() || undefined,
      });
      if (!mountedRef.current) return ok;
      if (!ok) {
        setFormStatus(SettingsFormStatus.Error);
        setSaveError(i18nService.t('failedToSaveSettings'));
        return false;
      }
      setFormStatus(SettingsFormStatus.Saved);
      savedTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          setFormStatus(SettingsFormStatus.Idle);
        }
        savedTimerRef.current = null;
      }, SETTINGS_FORM_SAVED_RESET_MS);
      return true;
    } catch (error) {
      if (mountedRef.current) {
        setFormStatus(SettingsFormStatus.Error);
        setSaveError(error instanceof Error ? error.message : i18nService.t('failedToSaveSettings'));
      }
      return false;
    }
  }, [cdpUrlInvalid, clearSavedTimer, external, externalDraft, isExternalDirty, onCommit, value]);

  useEffect(() => {
    if (!onRegisterDirtyGuard) return;
    if (isExternalDirty) {
      onRegisterDirtyGuard({
        isDirty: true,
        canSave: !cdpUrlInvalid,
        save: handleSaveExternal,
        discard: handleDiscardExternal,
      });
    } else {
      onRegisterDirtyGuard(null);
    }
    return () => {
      onRegisterDirtyGuard(null);
    };
  }, [cdpUrlInvalid, handleDiscardExternal, handleSaveExternal, isExternalDirty, onRegisterDirtyGuard]);

  const openHostnameDialog = (target: HostnameListTarget) => {
    setHostnameDraft('');
    setHostnameDialogTarget(target);
  };

  const closeHostnameDialog = () => {
    setHostnameDialogTarget(null);
    setHostnameDraft('');
  };

  const normalizedHostnameDraft = normalizeBrowserHostnameList([hostnameDraft])[0] ?? '';
  const currentDialogHostnames = hostnameDialogTarget ? value.blockedHostnames : [];
  const canAddHostname = Boolean(
    hostnameDialogTarget
    && normalizedHostnameDraft
    && !currentDialogHostnames.includes(normalizedHostnameDraft),
  );

  const submitHostnameDialog = () => {
    if (!hostnameDialogTarget || !canAddHostname) {
      return;
    }

    updateHostnames([...currentDialogHostnames, normalizedHostnameDraft]);
    closeHostnameDialog();
  };

  const removeHostname = (hostname: string) => {
    updateHostnames(value.blockedHostnames.filter(item => item !== hostname));
  };

  const hostnameDialogTitle = i18nService.t('browserAddBlockedHostnameTitle');
  const hostnameDialogDescription = i18nService.t('browserAddBlockedHostnameDescription');

  const resolvedFormStatus: SettingsFormStatus = formStatus === SettingsFormStatus.Saving
    ? SettingsFormStatus.Saving
    : formStatus === SettingsFormStatus.Error
      ? SettingsFormStatus.Error
      : isExternalDirty
        ? SettingsFormStatus.Dirty
        : formStatus === SettingsFormStatus.Saved
          ? SettingsFormStatus.Saved
          : SettingsFormStatus.Idle;

  return (
    <>
      <div className="space-y-6">
        <SettingsSection
          title={i18nService.t('browserSettingsGeneralSection')}
          action={external ? <SettingsFormStatusBadge status={resolvedFormStatus} /> : undefined}
        >
          <SettingsCard>
            <SettingsItem
              title={i18nService.t('browserDisplayModeTitle')}
              description={i18nService.t(external ? 'browserDisplayModeExternalDescription' : 'browserDisplayModeInAppDescription')}
              control={(
                <div className={SELECT_WIDTH_CLASS}>
                  <ThemedSelect
                    id="browser-display-mode"
                    size="sm"
                    value={value.displayMode}
                    onChange={displayMode => handleDisplayModeChange(displayMode as BrowserDisplayMode)}
                    options={[
                      { value: BrowserDisplayMode.InApp, label: i18nService.t('browserDisplayModeInApp') },
                      { value: BrowserDisplayMode.External, label: i18nService.t('browserDisplayModeExternal') },
                    ]}
                  />
                </div>
              )}
            />
            {external ? (
              <>
                <SettingsItem
                  title={i18nService.t('browserExecutablePath')}
                  description={i18nService.t('browserExecutablePathDescription')}
                  control={(
                    <input
                      aria-label={i18nService.t('browserExecutablePath')}
                      className="h-8 w-64 rounded-lg border border-border bg-surface px-2.5 text-xs text-foreground outline-none placeholder:text-secondary focus:border-primary focus:ring-1 focus:ring-primary/40"
                      value={externalDraft.executablePath}
                      onChange={event => handleExternalDraftChange({ executablePath: event.target.value })}
                    />
                  )}
                />
                <SettingsItem
                  title={i18nService.t('browserCdpUrl')}
                  description={(
                    <>
                      <span>{i18nService.t('browserCdpUrlDescription')}</span>
                      {cdpUrlInvalid ? (
                        <p className="mt-1 text-red-500">{i18nService.t('browserCdpUrlInvalid')}</p>
                      ) : null}
                    </>
                  )}
                  control={(
                    <input
                      aria-label={i18nService.t('browserCdpUrl')}
                      aria-invalid={cdpUrlInvalid}
                      placeholder="http://127.0.0.1:9222"
                      className={`h-8 w-64 rounded-lg border bg-surface px-2.5 text-xs text-foreground outline-none placeholder:text-secondary focus:ring-1 ${
                        cdpUrlInvalid
                          ? 'border-red-500 focus:border-red-500 focus:ring-red-500/40'
                          : 'border-border focus:border-primary focus:ring-primary/40'
                      }`}
                      value={externalDraft.cdpUrl}
                      onChange={event => handleExternalDraftChange({ cdpUrl: event.target.value })}
                    />
                  )}
                />
                {resolvedFormStatus !== SettingsFormStatus.Idle && resolvedFormStatus !== SettingsFormStatus.Saved ? (
                  <div className="px-4 py-3">
                    <SettingsFormFooter
                      status={resolvedFormStatus}
                      mode={SettingsFormFooterMode.DirtyBar}
                      canSave={isExternalDirty && !cdpUrlInvalid}
                      errorMessage={saveError}
                      onSave={handleSaveExternal}
                      onDiscard={handleDiscardExternal}
                    />
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <SettingsItem
                  title={i18nService.t('browserCredentialUseModeTitle')}
                  description={value.credentialUseMode === BrowserCredentialUseMode.Disabled
                    ? i18nService.t('browserCredentialUseModeDisabledDescription')
                    : value.credentialUseMode === BrowserCredentialUseMode.OncePerTask
                      ? i18nService.t('browserCredentialUseModeOncePerTaskDescription')
                      : i18nService.t('browserCredentialUseModeAlwaysAskDescription')}
                  control={(
                    <div className={SELECT_WIDTH_CLASS}>
                      <ThemedSelect
                        id="browser-credential-use-mode"
                        size="sm"
                        value={value.credentialUseMode}
                        onChange={(mode) => {
                          void commitImmediate({
                            credentialUseMode: mode as BrowserCredentialUseModeValue,
                          });
                        }}
                        options={[
                          {
                            value: BrowserCredentialUseMode.AlwaysAsk,
                            label: i18nService.t('browserCredentialUseModeAlwaysAsk'),
                          },
                          {
                            value: BrowserCredentialUseMode.OncePerTask,
                            label: i18nService.t('browserCredentialUseModeOncePerTask'),
                          },
                          {
                            value: BrowserCredentialUseMode.Disabled,
                            label: i18nService.t('browserCredentialUseModeDisabled'),
                          },
                        ]}
                      />
                    </div>
                  )}
                />

                <SettingsItem
                  title={i18nService.t('browserCredentialSaveModeTitle')}
                  description={value.credentialSaveMode === BrowserCredentialSaveMode.Never
                    ? i18nService.t('browserCredentialSaveModeNeverDescription')
                    : i18nService.t('browserCredentialSaveModeAskDescription')}
                  control={(
                    <div className={SELECT_WIDTH_CLASS}>
                      <ThemedSelect
                        id="browser-credential-save-mode"
                        size="sm"
                        value={value.credentialSaveMode}
                        onChange={(mode) => {
                          void commitImmediate({
                            credentialSaveMode: mode as BrowserCredentialSaveModeValue,
                          });
                        }}
                        options={[
                          {
                            value: BrowserCredentialSaveMode.Ask,
                            label: i18nService.t('browserCredentialSaveModeAsk'),
                          },
                          {
                            value: BrowserCredentialSaveMode.Never,
                            label: i18nService.t('browserCredentialSaveModeNever'),
                          },
                        ]}
                      />
                    </div>
                  )}
                />
              </>
            )}
          </SettingsCard>
        </SettingsSection>

        <BrowserCredentialSettings externalMode={external} />

        <HostnameList
          title={i18nService.t('browserBlockedHostnames')}
          description={i18nService.t('browserBlockedHostnamesDescription')}
          hostnames={value.blockedHostnames}
          onAdd={() => openHostnameDialog(HostnameListTarget.BlockedHostnames)}
          onRemove={removeHostname}
        />
      </div>

      {hostnameDialogTarget ? (
        <Modal
          onClose={closeHostnameDialog}
          onEscape={closeHostnameDialog}
          overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/25"
          className="w-full max-w-[420px] rounded-2xl border border-border bg-background p-5 shadow-modal"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-base font-semibold text-foreground">{hostnameDialogTitle}</h3>
              <p className="mt-2 text-sm text-secondary">{hostnameDialogDescription}</p>
            </div>
            <button
              type="button"
              onClick={closeHostnameDialog}
              className="rounded-md p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>

          <input
            ref={hostnameInputRef}
            type="text"
            value={hostnameDraft}
            onChange={(event) => setHostnameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitHostnameDialog();
              }
            }}
            placeholder={i18nService.t('browserHostnameInputPlaceholder')}
            className="mt-4 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-secondary focus:border-primary focus:ring-1 focus:ring-primary/40"
          />

          <div className="mt-4 flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={closeHostnameDialog}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={submitHostnameDialog}
              disabled={!canAddHostname}
              className="rounded-lg bg-action px-4 py-2 text-sm font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:bg-gray-400 disabled:text-white"
            >
              {i18nService.t('add')}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
};

export default BrowserWebAccessSettings;
