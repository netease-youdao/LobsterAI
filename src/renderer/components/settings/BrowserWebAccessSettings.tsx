import { PlusIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useRef, useState } from 'react';

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
  onChange: (value: BrowserWebAccessConfig) => void;
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
  onChange,
}) => {
  const [hostnameDialogTarget, setHostnameDialogTarget] = useState<HostnameListTarget | null>(null);
  const [hostnameDraft, setHostnameDraft] = useState('');
  const hostnameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (hostnameDialogTarget) {
      hostnameInputRef.current?.focus();
    }
  }, [hostnameDialogTarget]);

  const update = (patch: Partial<BrowserWebAccessConfig>) => {
    onChange({
      ...value,
      ...patch,
    });
  };

  const updateHostnames = (hostnames: string[]) => {
    update({ blockedHostnames: normalizeBrowserHostnameList(hostnames) });
  };

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

  const external = value.displayMode === BrowserDisplayMode.External;
  const trimmedCdpUrl = value.cdpUrl?.trim() ?? '';
  const cdpUrlInvalid = external && Boolean(trimmedCdpUrl) && !normalizeBrowserCdpUrl(trimmedCdpUrl);

  return (
    <>
      <div className="space-y-6">
        <SettingsSection title={i18nService.t('browserSettingsGeneralSection')}>
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
                    onChange={displayMode => update({ displayMode: displayMode as BrowserDisplayMode })}
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
                      value={value.executablePath ?? ''}
                      onChange={event => update({ executablePath: event.target.value })}
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
                      value={value.cdpUrl ?? ''}
                      onChange={event => update({ cdpUrl: event.target.value })}
                    />
                  )}
                />
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
                        onChange={(mode) => update({
                          credentialUseMode: mode as BrowserCredentialUseModeValue,
                        })}
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
                        onChange={(mode) => update({
                          credentialSaveMode: mode as BrowserCredentialSaveModeValue,
                        })}
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
