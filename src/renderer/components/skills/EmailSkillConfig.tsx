import { EyeIcon, EyeSlashIcon, XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import {
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  EnvelopeIcon,
  PlusIcon,
  SignalIcon,
  SparklesIcon,
  TrashIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import {
  type EmailSkillAccountConfig,
  type EmailSkillAccountsConfig,
  skillService,
} from '../../services/skill';
import Modal from '../common/Modal';
import type { RegisterSettingsDirtyGuard } from '../settings/settingsDirtyGuard';
import {
  SETTINGS_ACTION_BUTTON_CLASS,
  SETTINGS_ICON_BUTTON_CLASS,
  SettingsCard,
  SettingsItem,
  SettingsSwitch,
} from '../settings/SettingsLayout';
import {
  SETTINGS_DESCRIPTION_TEXT,
  SETTINGS_ITEM_TITLE_TEXT,
  SETTINGS_META_TEXT,
  SETTINGS_SECTION_TITLE_TEXT,
} from '../settings/settingsTypography';
import ThemedSelect from '../ui/ThemedSelect';
import {
  applyProviderPresetToDraft,
  commitEmailAccountDraft,
  createDraftEmailAccount,
  detectKnownEmailDomainPreset,
  EMAIL_PROVIDER_ORDER,
  EMAIL_PROVIDER_PRESETS,
  EmailProviderId,
  extractEmailDomain,
  getEmailProviderPreset,
  isEmailAccountConfigured,
  isLikelyValidEmailDomain,
  nextEmailAccountId,
  normalizeEmailAccountsConfig,
  removeEmailAccount,
  toggleEmailAccountEnabled,
} from './emailSkillConfigHelpers';

const SKILL_ID = 'imap-smtp-email';
const EMAIL_ANALYTICS_SOURCE = 'settings_email';

const EditMode = {
  Create: 'create',
  Edit: 'edit',
} as const;

type EditMode = typeof EditMode[keyof typeof EditMode];

type EmailConnectivityCheck = {
  code: 'imap_connection' | 'smtp_connection';
  level: 'pass' | 'fail';
  message: string;
  durationMs: number;
};

type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: 'pass' | 'fail';
  checks: EmailConnectivityCheck[];
};

interface EditingAccountState {
  mode: EditMode;
  draft: EmailSkillAccountConfig;
  makeDefault: boolean;
  previousEmail?: string;
  initialSnapshot: string;
}

interface EmailSkillConfigProps {
  onRegisterDirtyGuard?: RegisterSettingsDirtyGuard;
}

const getAccountDisplayName = (account: EmailSkillAccountConfig): string => {
  if (account.id === 'default' && (account.name === 'Default' || account.name === 'default')) {
    return i18nService.t('emailDefaultAccountDisplayName');
  }
  return account.name || account.email || account.id;
};

const getChangedAccountKeys = (
  previous: EmailSkillAccountConfig | null,
  next: EmailSkillAccountConfig,
): string => {
  if (!previous) return 'account_added';
  const fieldMappings: Array<[keyof EmailSkillAccountConfig, string]> = [
    ['provider', 'provider'],
    ['email', 'email'],
    ['password', 'password'],
    ['imapHost', 'imap_host'],
    ['imapPort', 'imap_port'],
    ['imapTls', 'imap_tls'],
    ['imapRejectUnauthorized', 'allow_insecure_cert'],
    ['smtpHost', 'smtp_host'],
    ['smtpPort', 'smtp_port'],
    ['smtpSecure', 'smtp_secure'],
    ['smtpRejectUnauthorized', 'allow_insecure_cert'],
    ['smtpFrom', 'email'],
    ['mailbox', 'mailbox'],
    ['enabled', 'enabled'],
    ['requireSendConfirmation', 'send_confirmation'],
  ];
  const changedKeys = new Set<string>();
  fieldMappings.forEach(([field, key]) => {
    if (previous[field] !== next[field]) {
      changedKeys.add(key);
    }
  });
  return Array.from(changedKeys).join(',') || 'account';
};

const buildEmailSkillAnalyticsParams = (
  config: EmailSkillAccountsConfig,
  account: EmailSkillAccountConfig | null,
) => ({
  source: EMAIL_ANALYTICS_SOURCE,
  skillId: SKILL_ID,
  provider: account?.provider ?? '',
  accountCount: config.accounts.length,
  enabledAccountCount: config.accounts.filter(item => item.enabled).length,
  hasEmail: Boolean(account?.email?.trim()),
  hasPassword: Boolean(account?.password?.trim()),
  hasImapHost: Boolean(account?.imapHost?.trim()),
  hasSmtpHost: Boolean(account?.smtpHost?.trim()),
  imapTlsEnabled: account?.imapTls !== false,
  smtpSslEnabled: account?.smtpSecure === true,
  allowInsecureCert:
    account?.imapRejectUnauthorized === false || account?.smtpRejectUnauthorized === false,
  mailboxCustomized: Boolean(account?.mailbox && account.mailbox !== 'INBOX'),
});

const EmailSkillConfig: React.FC<EmailSkillConfigProps> = ({ onRegisterDirtyGuard }) => {
  const [config, setConfig] = useState<EmailSkillAccountsConfig>({
    version: 1,
    defaultAccountId: '',
    accounts: [],
  });
  const [editing, setEditing] = useState<EditingAccountState | null>(null);
  const [autoMatchedLabel, setAutoMatchedLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null);
  const [connectivityResult, setConnectivityResult] = useState<EmailConnectivityTestResult | null>(null);
  const [connectivityError, setConnectivityError] = useState<string | null>(null);
  const [pendingDeleteAccountId, setPendingDeleteAccountId] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const persistQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    isMountedRef.current = true;
    const loadConfig = async () => {
      try {
        console.debug('[EmailSkillConfig] loading email accounts config');
        const loaded = normalizeEmailAccountsConfig(await skillService.getEmailAccountsConfig(SKILL_ID));
        if (!isMountedRef.current) return;
        setConfig(loaded);
        setLoadError(null);
        console.debug('[EmailSkillConfig] loaded email accounts config', {
          accountCount: loaded.accounts.length,
          enabledAccountCount: loaded.accounts.filter(account => account.enabled).length,
          defaultAccountId: loaded.defaultAccountId,
        });
      } catch (error) {
        console.error('[EmailSkillConfig] failed to load email accounts config:', error);
        if (!isMountedRef.current) return;
        setLoadError(i18nService.t('emailConfigLoadError'));
      } finally {
        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    };
    void loadConfig();
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const persistConfig = useCallback(async (
    nextConfig: EmailSkillAccountsConfig,
    analyticsChangedKeys = '',
    analyticsAccountId?: string,
  ): Promise<boolean> => {
    const normalized = normalizeEmailAccountsConfig(nextConfig);
    if (isMountedRef.current) {
      setConfig(normalized);
    }
    console.debug('[EmailSkillConfig] persisting email accounts config', {
      accountCount: normalized.accounts.length,
      enabledAccountCount: normalized.accounts.filter(account => account.enabled).length,
      defaultAccountId: normalized.defaultAccountId,
      changedKeys: analyticsChangedKeys,
    });
    const persistTask = persistQueueRef.current
      .catch(() => undefined)
      .then(() => skillService.setEmailAccountsConfig(SKILL_ID, normalized));
    persistQueueRef.current = persistTask.then(() => undefined, () => undefined);
    const success = await persistTask;
    if (isMountedRef.current) {
      setPersistError(success ? null : i18nService.t('emailConfigError'));
    }
    if (success) {
      console.debug('[EmailSkillConfig] persisted email accounts config', {
        accountCount: normalized.accounts.length,
        enabledAccountCount: normalized.accounts.filter(account => account.enabled).length,
        defaultAccountId: normalized.defaultAccountId,
      });
    } else {
      console.warn('[EmailSkillConfig] failed to persist email accounts config', {
        accountCount: normalized.accounts.length,
        defaultAccountId: normalized.defaultAccountId,
      });
    }
    if (success && analyticsChangedKeys) {
      const analyticsAccount = (analyticsAccountId
        ? normalized.accounts.find(account => account.id === analyticsAccountId)
        : null)
        ?? normalized.accounts.find(account => account.id === normalized.defaultAccountId)
        ?? null;
      void reportYdAnalyzer({
        action: LogReporterAction.EmailSkillSettingsSaved,
        ...buildEmailSkillAnalyticsParams(normalized, analyticsAccount),
        changedKeys: analyticsChangedKeys,
      });
    }
    return success;
  }, []);

  const resetFormTransientState = () => {
    setShowPassword(false);
    setAutoMatchedLabel(null);
    setConnectivityResult(null);
    setConnectivityError(null);
    setPersistError(null);
  };

  const openCreateForm = () => {
    const id = nextEmailAccountId(config.accounts);
    const hasEnabledAccount = config.accounts.some(account => account.enabled);
    const draft = createDraftEmailAccount(id);
    const makeDefault = !hasEnabledAccount;
    resetFormTransientState();
    setShowAdvanced(false);
    setEditing({
      mode: EditMode.Create,
      draft,
      makeDefault,
      initialSnapshot: JSON.stringify({ draft, makeDefault }),
    });
  };

  const openEditForm = (account: EmailSkillAccountConfig) => {
    const draft = { ...account };
    const makeDefault = account.id === config.defaultAccountId;
    resetFormTransientState();
    setShowAdvanced(account.provider === EmailProviderId.Custom);
    setEditing({
      mode: EditMode.Edit,
      draft,
      makeDefault,
      previousEmail: account.email,
      initialSnapshot: JSON.stringify({ draft, makeDefault }),
    });
  };

  const closeForm = useCallback(() => {
    setEditing(null);
    resetFormTransientState();
  }, []);

  const updateDraft = useCallback((patch: Partial<EmailSkillAccountConfig>) => {
    setEditing(prev => (prev ? { ...prev, draft: { ...prev.draft, ...patch } } : prev));
  }, []);

  const handleEmailChange = (rawEmail: string) => {
    const detected = detectKnownEmailDomainPreset(rawEmail);
    setEditing(prev => {
      if (!prev) return prev;
      const nextDraft: EmailSkillAccountConfig = {
        ...prev.draft,
        email: rawEmail,
      };
      if (detected) {
        nextDraft.provider = detected.provider;
        nextDraft.imapHost = detected.imapHost;
        nextDraft.imapPort = detected.imapPort;
        nextDraft.imapTls = detected.imapTls;
        nextDraft.smtpHost = detected.smtpHost;
        nextDraft.smtpPort = detected.smtpPort;
        nextDraft.smtpSecure = detected.smtpSecure;
      }
      return { ...prev, draft: nextDraft };
    });

    if (detected) {
      const label = detected.labelKey ? i18nService.t(detected.labelKey) : detected.matchedLabel ?? '';
      setAutoMatchedLabel(label || null);
      if (detected.provider !== EmailProviderId.Custom) {
        setShowAdvanced(false);
      }
    } else {
      setAutoMatchedLabel(null);
    }
  };

  const handleEmailBlur = () => {
    if (!editing) return;
    const email = editing.draft.email.trim();
    if (!email) return;
    const detected = detectKnownEmailDomainPreset(email);
    if (detected) return;

    const domain = extractEmailDomain(email);
    if (
      isLikelyValidEmailDomain(domain)
      && !editing.draft.provider
      && !editing.draft.imapHost?.trim()
    ) {
      setEditing(prev => (prev
        ? { ...prev, draft: { ...prev.draft, provider: EmailProviderId.Custom } }
        : prev));
      setShowAdvanced(true);
    }
  };

  const handleProviderChange = (provider: string) => {
    setAutoMatchedLabel(null);
    if (provider === EmailProviderId.Custom) {
      setShowAdvanced(true);
    } else if (provider) {
      setShowAdvanced(false);
    }
    setEditing(prev => (prev
      ? { ...prev, draft: applyProviderPresetToDraft(prev.draft, provider) }
      : prev));
  };

  const handleSaveForm = useCallback(async (): Promise<boolean> => {
    if (!editing || saving) return false;
    if (!isEmailAccountConfigured(editing.draft)) return false;

    const preset = getEmailProviderPreset(editing.draft.provider);
    const fallbackName = preset && preset.id !== EmailProviderId.Custom
      ? i18nService.t(preset.labelKey)
      : undefined;
    const previousAccount = editing.mode === EditMode.Edit
      ? (config.accounts.find(account => account.id === editing.draft.id) ?? null)
      : null;

    const nextConfig = commitEmailAccountDraft(config, editing.draft, {
      isNew: editing.mode === EditMode.Create,
      makeDefault: editing.makeDefault,
      fallbackName,
      previousEmail: editing.previousEmail,
    });
    const savedAccount = nextConfig.accounts.find(account => account.id === editing.draft.id) ?? editing.draft;
    const changedKeys = getChangedAccountKeys(previousAccount, savedAccount);

    setSaving(true);
    const success = await persistConfig(nextConfig, changedKeys, savedAccount.id);
    if (!isMountedRef.current) return success;
    setSaving(false);
    if (success) {
      closeForm();
    }
    return success;
  }, [closeForm, config, editing, persistConfig, saving]);

  const isEditingDirty = editing !== null
    && JSON.stringify({ draft: editing.draft, makeDefault: editing.makeDefault }) !== editing.initialSnapshot;
  const canSaveEditingForm = editing !== null && isEmailAccountConfigured(editing.draft);

  useEffect(() => {
    if (!onRegisterDirtyGuard) return;
    if (isEditingDirty) {
      onRegisterDirtyGuard({
        isDirty: true,
        canSave: canSaveEditingForm,
        save: handleSaveForm,
        discard: closeForm,
      });
    } else {
      onRegisterDirtyGuard(null);
    }
    return () => {
      onRegisterDirtyGuard(null);
    };
  }, [canSaveEditingForm, closeForm, handleSaveForm, isEditingDirty, onRegisterDirtyGuard]);

  const handleToggleAccountInList = async (accountId: string) => {
    const nextConfig = toggleEmailAccountEnabled(config, accountId);
    if (!nextConfig) return;
    await persistConfig(nextConfig, 'enabled', accountId);
  };

  const handleConfirmDeleteAccount = async () => {
    if (!pendingDeleteAccountId) return;
    const accountId = pendingDeleteAccountId;
    setPendingDeleteAccountId(null);
    const nextConfig = removeEmailAccount(config, accountId);
    if (editing?.draft.id === accountId) {
      closeForm();
    }
    await persistConfig(nextConfig, 'account_deleted');
  };

  const handleConnectivityTest = async () => {
    if (!editing || !isEmailAccountConfigured(editing.draft)) return;
    const draft = editing.draft;
    setConnectivityError(null);
    setConnectivityResult(null);
    setTestingAccountId(draft.id);
    console.debug('[EmailSkillConfig] testing email account connectivity', {
      accountId: draft.id,
      hasEmail: Boolean(draft.email),
      hasPassword: Boolean(draft.password),
      hasImapHost: Boolean(draft.imapHost),
      hasSmtpHost: Boolean(draft.smtpHost),
    });
    try {
      const result = await skillService.testEmailAccountConnectivity(SKILL_ID, draft);
      if (!isMountedRef.current) return;
      if (result) {
        setConnectivityResult(result);
        const imapCheck = result.checks.find(check => check.code === 'imap_connection');
        const smtpCheck = result.checks.find(check => check.code === 'smtp_connection');
        void reportYdAnalyzer({
          action: LogReporterAction.EmailSkillConnectionTested,
          ...buildEmailSkillAnalyticsParams(config, draft),
          result: result.verdict,
          imapResult: imapCheck?.level ?? '',
          smtpResult: smtpCheck?.level ?? '',
        });
        console.debug('[EmailSkillConfig] email account connectivity test completed', {
          accountId: draft.id,
          verdict: result.verdict,
        });
      } else {
        setConnectivityError(i18nService.t('connectionFailed'));
        void reportYdAnalyzer({
          action: LogReporterAction.EmailSkillConnectionTested,
          ...buildEmailSkillAnalyticsParams(config, draft),
          result: 'fail',
          imapResult: '',
          smtpResult: '',
        });
        console.warn('[EmailSkillConfig] email account connectivity test returned no result', {
          accountId: draft.id,
        });
      }
    } catch (error) {
      console.error('[EmailSkillConfig] email account connectivity test failed:', error);
      if (!isMountedRef.current) return;
      setConnectivityError(i18nService.t('connectionFailed'));
      void reportYdAnalyzer({
        action: LogReporterAction.EmailSkillConnectionTested,
        ...buildEmailSkillAnalyticsParams(config, draft),
        result: 'fail',
        imapResult: '',
        smtpResult: '',
      });
    } finally {
      if (isMountedRef.current) {
        setTestingAccountId(null);
      }
    }
  };

  const buildAskAIPrompt = useCallback((result: EmailConnectivityTestResult | null): string => {
    const account = editing?.draft;
    const lines: string[] = [];
    lines.push('我在配置邮件的 IMAP/SMTP 连接时遇到了问题，请帮我排查并给出解决方案。');
    if (account) {
      lines.push(`邮箱账号：${getAccountDisplayName(account)}`);
      lines.push(`邮箱地址：${account.email}`);
      lines.push(`IMAP 服务器：${account.imapHost}:${account.imapPort}`);
      lines.push(`SMTP 服务器：${account.smtpHost}:${account.smtpPort}`);
    }
    lines.push('连接测试失败，错误信息如下：');
    if (result) {
      result.checks.forEach(check => {
        const label = check.code === 'imap_connection' ? 'IMAP' : 'SMTP';
        const status = check.level === 'pass' ? '成功' : '失败';
        lines.push(`- ${label} 连接${status}：${check.message}（耗时 ${check.durationMs}ms）`);
      });
    } else if (connectivityError) {
      lines.push(`- ${connectivityError}`);
    }
    return lines.join('\n');
  }, [connectivityError, editing?.draft]);

  const handleAskAI = (result: EmailConnectivityTestResult | null) => {
    window.dispatchEvent(new CustomEvent('app:ask-ai', { detail: buildAskAIPrompt(result) }));
  };

  const handleOpenProviderHelp = (url: string) => {
    window.electron.shell.openExternal(url).catch((error: unknown) => {
      console.error('[EmailSkillConfig] failed to open provider help URL:', error);
    });
  };

  const providerOptions = useMemo(
    () => [
      { value: '', label: i18nService.t('emailSelectProviderAuto') },
      ...EMAIL_PROVIDER_ORDER.map(providerId => ({
        value: providerId,
        label: i18nService.t(EMAIL_PROVIDER_PRESETS[providerId].labelKey),
      })),
    ],
    [],
  );

  const pendingDeleteAccount = config.accounts.find(account => account.id === pendingDeleteAccountId) ?? null;

  const inputClassName =
    'block h-9 w-full rounded-lg bg-background border border-border focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 text-foreground placeholder:text-secondary/60 px-3 text-sm transition-colors';
  const compactInputClassName =
    'block h-8 w-full rounded-lg bg-background border border-border focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30 text-foreground placeholder:text-secondary/60 px-2.5 text-xs transition-colors';
  const labelClassName = `block ${SETTINGS_META_TEXT} font-medium text-foreground mb-1`;
  const checkboxLabelClassName = 'inline-flex items-center gap-1.5 text-xs text-foreground cursor-pointer select-none';
  const checkboxClassName = 'h-3.5 w-3.5 rounded border-border accent-primary';

  const renderErrorBanner = () => {
    const message = loadError || persistError;
    if (!message) return null;
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
        {message}
      </div>
    );
  };

  if (loading) {
    return <div className="py-4 text-xs text-secondary">{i18nService.t('loading')}...</div>;
  }

  const renderAccountOverview = () => {
    if (config.accounts.length === 0) {
      return (
        <div className="space-y-4">
          {renderErrorBanner()}

          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface/50 px-6 py-12 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-raised text-foreground">
              <EnvelopeIcon className="h-5 w-5" />
            </span>
            <h4 className={`mt-3.5 ${SETTINGS_ITEM_TITLE_TEXT} font-semibold text-foreground`}>
              {i18nService.t('emailEmptyTitle')}
            </h4>
            <p className={`mt-1.5 max-w-md ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
              {i18nService.t('emailEmptyDescription')}
            </p>
            <button
              type="button"
              onClick={openCreateForm}
              className="mt-5 inline-flex h-8 items-center gap-1.5 rounded-lg bg-action px-4 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover active:scale-[0.98]"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {i18nService.t('emailAddButton')}
            </button>
            <p className={`mt-4 ${SETTINGS_META_TEXT} text-secondary/80`}>
              {i18nService.t('emailEmptyFootnote')}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-5">
        {renderErrorBanner()}

        <p className={`${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
          {i18nService.t('emailAccountsHint')}
        </p>

        <section className="space-y-2.5">
          <div className="flex items-center justify-between gap-3 px-0.5">
            <h4 className={`${SETTINGS_SECTION_TITLE_TEXT} font-semibold text-foreground`}>
              {i18nService.t('emailAddedAccountsTitle')}
            </h4>
            <button
              type="button"
              onClick={openCreateForm}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg bg-action px-3 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover active:scale-[0.98]"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {i18nService.t('emailAddButton')}
            </button>
          </div>

          <SettingsCard>
            {config.accounts.map(account => {
              const configured = isEmailAccountConfigured(account);
              const isDefault =
                config.accounts.length > 1
                && account.enabled
                && account.id === config.defaultAccountId;
              const displayName = getAccountDisplayName(account);
              const subtitle = account.email.trim() || i18nService.t('emailIncompleteSubtitle');

              return (
                <div
                  key={account.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openEditForm(account)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openEditForm(account);
                    }
                  }}
                  className="group flex items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-surface-raised/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 cursor-pointer"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-foreground">
                      <EnvelopeIcon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={`truncate ${SETTINGS_ITEM_TITLE_TEXT} font-medium text-foreground`}>
                          {displayName}
                        </span>
                        {isDefault && (
                          <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-secondary">
                            {i18nService.t('emailDefaultBadge')}
                          </span>
                        )}
                        {!configured && (
                          <span className="shrink-0 rounded-full bg-amber-400/15 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                            {i18nService.t('emailIncompleteBadge')}
                          </span>
                        )}
                      </div>
                      <div className={`mt-0.5 truncate ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
                        {subtitle}
                      </div>
                    </div>
                  </div>

                  <div
                    className="flex shrink-0 items-center gap-2"
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => event.stopPropagation()}
                  >
                    <span
                      title={!configured ? i18nService.t('emailIncompleteToggleHint') : undefined}
                      className="inline-flex items-center"
                    >
                      <SettingsSwitch
                        checked={account.enabled}
                        label={account.enabled ? i18nService.t('disable') : i18nService.t('enable')}
                        disabled={!configured && !account.enabled}
                        onClick={() => handleToggleAccountInList(account.id)}
                      />
                    </span>

                    <button
                      type="button"
                      onClick={() => setPendingDeleteAccountId(account.id)}
                      className={`${SETTINGS_ICON_BUTTON_CLASS} opacity-65 group-hover:opacity-100`}
                      aria-label={i18nService.t('delete')}
                      title={i18nService.t('delete')}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>

                    <ChevronRightIcon className="h-4 w-4 text-secondary opacity-45 transition-opacity group-hover:opacity-100" />
                  </div>
                </div>
              );
            })}
          </SettingsCard>
        </section>
      </div>
    );
  };

  const renderAccountForm = (current: EditingAccountState) => {
    const { draft, mode, makeDefault } = current;
    const isCreate = mode === EditMode.Create;
    const preset = getEmailProviderPreset(draft.provider);
    const configured = isEmailAccountConfigured(draft);
    const isTesting = testingAccountId === draft.id;
    const connectivityPassed = connectivityResult?.verdict === 'pass';
    const showDefaultToggle =
      config.accounts.length >= 2 || (isCreate && config.accounts.length >= 1);
    const helpLinkLabel = preset?.helpLinkKey
      ? i18nService.t(preset.helpLinkKey)
      : i18nService.t('emailProviderGuideLink');
    const passwordHint = preset?.hintKey
      ? i18nService.t(preset.hintKey)
      : i18nService.t('emailPasswordHelp');

    return (
      <div
        className="space-y-4"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.target as HTMLElement)?.tagName === 'INPUT') {
            event.preventDefault();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={closeForm}
              className="-ml-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary/25"
              aria-label={i18nService.t('back')}
            >
              <ArrowLeftIcon className="h-3.5 w-3.5 shrink-0" />
              <span>{i18nService.t('back')}</span>
            </button>
            <h3
              className={`min-w-0 truncate ${SETTINGS_SECTION_TITLE_TEXT} font-semibold text-foreground`}
              title={isCreate ? i18nService.t('emailAddButton') : getAccountDisplayName(draft)}
            >
              {isCreate
                ? i18nService.t('emailAddButton')
                : (draft.name.trim() || i18nService.t('emailEditAccountTitle'))}
            </h3>
          </div>

          {!isCreate && (
            <div className="flex shrink-0 items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-secondary">
                  {draft.enabled ? i18nService.t('enabled') : i18nService.t('disabled')}
                </span>
                <SettingsSwitch
                  checked={draft.enabled}
                  label={draft.enabled ? i18nService.t('disable') : i18nService.t('enable')}
                  disabled={!configured && !draft.enabled}
                  onClick={() => updateDraft({ enabled: !draft.enabled })}
                />
              </div>

              <button
                type="button"
                onClick={() => setPendingDeleteAccountId(draft.id)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10"
                title={i18nService.t('delete')}
              >
                <TrashIcon className="h-4 w-4" />
                {i18nService.t('delete')}
              </button>
            </div>
          )}
        </div>

        {renderErrorBanner()}

        <div className="rounded-xl border border-border bg-surface p-4 space-y-4">
          <div className="grid grid-cols-2 gap-3.5 max-md:grid-cols-1">
            <div>
              <label className={labelClassName}>
                {i18nService.t('emailAddress')}<span className="ml-0.5 text-red-500">*</span>
              </label>
              <input
                type="email"
                value={draft.email}
                onChange={event => handleEmailChange(event.target.value)}
                onBlur={handleEmailBlur}
                className={inputClassName}
                placeholder={i18nService.t('emailAddressPlaceholderExample')}
              />
              {autoMatchedLabel && (
                <p className={`mt-1 ${SETTINGS_META_TEXT} text-emerald-600 dark:text-emerald-400`}>
                  {i18nService.t('emailAutoMatchedProvider').replace('{provider}', autoMatchedLabel)}
                </p>
              )}
            </div>

            <div>
              <label className={labelClassName} htmlFor="email-provider-select">
                {i18nService.t('emailProvider')}
              </label>
              <ThemedSelect
                id="email-provider-select"
                value={draft.provider ?? ''}
                onChange={handleProviderChange}
                options={providerOptions}
                className="!h-9 !bg-background !px-3 !py-0 text-sm"
              />
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className={`${SETTINGS_META_TEXT} font-medium text-foreground`}>
                {i18nService.t('emailPassword')}<span className="ml-0.5 text-red-500">*</span>
              </label>
              {preset?.helpUrl && (
                <button
                  type="button"
                  onClick={() => handleOpenProviderHelp(preset.helpUrl!)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-secondary underline underline-offset-2 transition-colors hover:text-foreground"
                >
                  {helpLinkLabel}
                  <ArrowTopRightOnSquareIcon className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={draft.password ?? ''}
                onChange={event => updateDraft({ password: event.target.value })}
                className={`${inputClassName} pr-16`}
                placeholder={i18nService.t('emailPasswordPlaceholder')}
              />
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {draft.password && (
                  <button
                    type="button"
                    onClick={() => updateDraft({ password: '' })}
                    className="rounded p-0.5 text-secondary transition-colors hover:text-foreground"
                    aria-label={i18nService.t('clear')}
                  >
                    <XCircleIconSolid className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowPassword(prev => !prev)}
                  className="rounded p-0.5 text-secondary transition-colors hover:text-foreground"
                  aria-label={showPassword ? i18nService.t('hide') : i18nService.t('show')}
                >
                  {showPassword ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <p className={`mt-1 ${SETTINGS_META_TEXT} text-secondary`}>{passwordHint}</p>
          </div>

          <div>
            <label className={labelClassName}>
              {i18nService.t('emailAccountNameOptional')}
              <span className="ml-1 font-normal text-secondary">{i18nService.t('emailOptionalHint')}</span>
            </label>
            <input
              type="text"
              value={draft.name}
              onChange={event => updateDraft({ name: event.target.value })}
              className={inputClassName}
              placeholder={i18nService.t('emailAccountNamePlaceholder')}
            />
          </div>
        </div>

        <SettingsCard>
          <SettingsItem
            title={i18nService.t('emailRequireSendConfirmation')}
            description={i18nService.t('emailRequireSendConfirmationDesc')}
            control={(
              <SettingsSwitch
                checked={draft.requireSendConfirmation !== false}
                label={i18nService.t('emailRequireSendConfirmation')}
                onClick={() => updateDraft({ requireSendConfirmation: draft.requireSendConfirmation === false })}
              />
            )}
          />
          {showDefaultToggle && (
            <SettingsItem
              title={i18nService.t('emailSetDefault')}
              description={i18nService.t('emailSetDefaultDesc')}
              control={(
                <SettingsSwitch
                  checked={makeDefault}
                  label={i18nService.t('emailSetDefault')}
                  disabled={!isCreate && !draft.enabled}
                  onClick={() => setEditing(prev => (prev ? { ...prev, makeDefault: !prev.makeDefault } : prev))}
                />
              )}
            />
          )}
        </SettingsCard>

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(prev => !prev)}
            className="inline-flex items-center gap-1 px-0.5 text-xs font-medium text-secondary transition-colors hover:text-foreground"
          >
            <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
            {i18nService.t('emailAdvancedSettingsWithHint')}
          </button>

          {showAdvanced && (
            <div className="mt-2.5 rounded-xl border border-border bg-surface p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
                <div>
                  <label className={labelClassName}>{i18nService.t('emailImapHost')}</label>
                  <input
                    type="text"
                    value={draft.imapHost ?? ''}
                    onChange={event => updateDraft({ imapHost: event.target.value })}
                    className={compactInputClassName}
                    placeholder="imap.example.com"
                  />
                </div>
                <div>
                  <label className={labelClassName}>{i18nService.t('emailImapPort')}</label>
                  <input
                    type="number"
                    value={draft.imapPort ?? 993}
                    onChange={event => updateDraft({ imapPort: parseInt(event.target.value, 10) || 993 })}
                    className={compactInputClassName}
                  />
                </div>
                <div>
                  <label className={labelClassName}>{i18nService.t('emailSmtpHost')}</label>
                  <input
                    type="text"
                    value={draft.smtpHost ?? ''}
                    onChange={event => updateDraft({ smtpHost: event.target.value })}
                    className={compactInputClassName}
                    placeholder="smtp.example.com"
                  />
                </div>
                <div>
                  <label className={labelClassName}>{i18nService.t('emailSmtpPort')}</label>
                  <input
                    type="number"
                    value={draft.smtpPort ?? 587}
                    onChange={event => updateDraft({ smtpPort: parseInt(event.target.value, 10) || 587 })}
                    className={compactInputClassName}
                  />
                </div>
              </div>

              <div>
                <label className={labelClassName}>{i18nService.t('emailMailbox')}</label>
                <input
                  type="text"
                  value={draft.mailbox ?? 'INBOX'}
                  onChange={event => updateDraft({ mailbox: event.target.value })}
                  className={compactInputClassName}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-0.5">
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={draft.imapTls !== false}
                    onChange={event => updateDraft({ imapTls: event.target.checked })}
                    className={checkboxClassName}
                  />
                  IMAP TLS
                </label>
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={draft.smtpSecure === true}
                    onChange={event => updateDraft({ smtpSecure: event.target.checked })}
                    className={checkboxClassName}
                  />
                  SMTP SSL
                </label>
                <label
                  className={checkboxLabelClassName}
                  title={i18nService.t('emailAllowInsecureCertHint')}
                >
                  <input
                    type="checkbox"
                    checked={draft.imapRejectUnauthorized === false || draft.smtpRejectUnauthorized === false}
                    onChange={event => {
                      const rejectUnauthorized = !event.target.checked;
                      updateDraft({
                        imapRejectUnauthorized: rejectUnauthorized,
                        smtpRejectUnauthorized: rejectUnauthorized,
                      });
                    }}
                    className={checkboxClassName}
                  />
                  {i18nService.t('emailAllowInsecureCert')}
                </label>
              </div>
            </div>
          )}
        </div>

        {connectivityError && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <span>{connectivityError}</span>
            <button
              type="button"
              onClick={() => handleAskAI(null)}
              className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 transition-opacity hover:opacity-75"
            >
              <SparklesIcon className="h-3.5 w-3.5" />
              {i18nService.t('emailConnectivityAskAI')}
            </button>
          </div>
        )}

        {connectivityResult && (
          connectivityPassed ? (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              <div className="flex items-center gap-1.5 font-medium">
                <CheckCircleIcon className="h-4 w-4 shrink-0" />
                <span>{i18nService.t('emailConnectivityTestPassedSummary')}</span>
              </div>
              <span className={`${SETTINGS_META_TEXT} text-secondary`}>
                {new Date(connectivityResult.testedAt).toLocaleTimeString()}
              </span>
            </div>
          ) : (
            <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                  <XCircleIcon className="h-4 w-4 shrink-0" />
                  <span>{i18nService.t('connectionFailed')}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleAskAI(connectivityResult)}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
                >
                  <SparklesIcon className="h-3 w-3" />
                  {i18nService.t('emailConnectivityAskAI')}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
                {connectivityResult.checks.map(check => {
                  const checkPassed = check.level === 'pass';
                  const checkLabel = check.code === 'imap_connection'
                    ? i18nService.t('emailConnectivityImapLabel')
                    : i18nService.t('emailConnectivitySmtpLabel');
                  return (
                    <div key={check.code} className="rounded-lg border border-border-subtle bg-surface px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`flex items-center gap-1 text-xs font-medium ${
                          checkPassed
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}>
                          {checkPassed ? <CheckCircleIcon className="h-3.5 w-3.5" /> : <XCircleIcon className="h-3.5 w-3.5" />}
                          {checkLabel}
                        </span>
                        <span className={`${SETTINGS_META_TEXT} text-secondary`}>{`${check.durationMs}ms`}</span>
                      </div>
                      <div className="mt-1 break-words text-xs text-secondary">{check.message}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
          <button
            type="button"
            onClick={() => void handleConnectivityTest()}
            disabled={isTesting || !configured}
            className={SETTINGS_ACTION_BUTTON_CLASS}
          >
            <SignalIcon className="h-3.5 w-3.5" />
            {isTesting ? i18nService.t('imConnectivityTesting') : i18nService.t('imConnectivityTest')}
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={closeForm}
              disabled={saving}
              className={SETTINGS_ACTION_BUTTON_CLASS}
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleSaveForm()}
              disabled={!configured || saving}
              className="inline-flex h-8 shrink-0 items-center justify-center rounded-lg bg-action px-4 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100"
            >
              {saving
                ? i18nService.t('saving')
                : isCreate
                  ? i18nService.t('emailSaveAndEnable')
                  : i18nService.t('save')}
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      {editing ? renderAccountForm(editing) : renderAccountOverview()}

      {pendingDeleteAccount && (
        <Modal
          onClose={() => setPendingDeleteAccountId(null)}
          onEscape={() => setPendingDeleteAccountId(null)}
          overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          className="w-full max-w-sm rounded-xl border border-border bg-surface p-5 shadow-2xl"
        >
          <div className="text-sm font-semibold text-foreground">
            {i18nService.t('confirmDelete')}
          </div>
          <p className="mt-2 text-xs leading-5 text-secondary">
            {i18nService.t('emailDeleteConfirm').replace('{name}', getAccountDisplayName(pendingDeleteAccount))}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDeleteAccountId(null)}
              className="h-8 rounded-lg border border-border px-3 text-xs text-foreground transition-colors hover:bg-surface-raised"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmDeleteAccount()}
              className="h-8 rounded-lg bg-red-600 px-3 text-xs font-medium text-white transition-colors hover:bg-red-700"
            >
              {i18nService.t('delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default EmailSkillConfig;
