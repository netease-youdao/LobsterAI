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
import { type EmailSkillAccountConfig, type EmailSkillAccountsConfig, skillService } from '../../services/skill';
import Modal from '../common/Modal';

const SKILL_ID = 'imap-smtp-email';
const EMAIL_ANALYTICS_SOURCE = 'settings_email';

interface ProviderPreset {
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  hint?: string;
  helpUrl?: string;
}

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

const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  gmail: {
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpSecure: false,
    hint: 'emailHintGmail',
    helpUrl: 'https://support.google.com/accounts/answer/185833',
  },
  outlook: {
    label: 'Outlook',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: false,
    helpUrl: 'https://support.microsoft.com/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353',
  },
  '163': {
    label: '163.com',
    imapHost: 'imap.163.com',
    imapPort: 993,
    smtpHost: 'smtp.163.com',
    smtpPort: 465,
    smtpSecure: true,
    hint: 'emailHint163',
    helpUrl: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089',
  },
  '126': {
    label: '126.com',
    imapHost: 'imap.126.com',
    imapPort: 993,
    smtpHost: 'smtp.126.com',
    smtpPort: 465,
    smtpSecure: true,
    hint: 'emailHint163',
    helpUrl: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089',
  },
  qq: {
    label: 'QQ Mail',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 587,
    smtpSecure: false,
    hint: 'emailHintQQ',
    helpUrl: 'https://help.mail.qq.com/detail/106/985',
  },
  custom: {
    label: '',
    imapHost: '',
    imapPort: 993,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
  },
};

const createEmptyAccount = (index: number): EmailSkillAccountConfig => ({
  id: `account-${index}`,
  name: `${i18nService.t('emailAccount')} ${index}`,
  enabled: false,
  provider: '',
  email: '',
  password: '',
  imapHost: '',
  imapPort: 993,
  imapTls: true,
  imapRejectUnauthorized: true,
  smtpHost: '',
  smtpPort: 587,
  smtpSecure: false,
  smtpRejectUnauthorized: true,
  smtpFrom: '',
  mailbox: 'INBOX',
  requireSendConfirmation: true,
});

const normalizeConfig = (config: EmailSkillAccountsConfig): EmailSkillAccountsConfig => {
  const accounts = config.accounts.map((account, index) => ({
    ...createEmptyAccount(index + 1),
    ...account,
    id: account.id || `account-${index + 1}`,
    name: account.name || account.email?.split('@')[0] || `account-${index + 1}`,
  }));
  const defaultAccount = accounts.find(account => account.id === config.defaultAccountId && account.enabled)
    ?? accounts.find(account => account.enabled)
    ?? accounts[0];
  return {
    version: 1,
    defaultAccountId: defaultAccount?.id ?? '',
    accounts,
  };
};

const nextAccountId = (accounts: EmailSkillAccountConfig[]): string => {
  let index = accounts.length + 1;
  const used = new Set(accounts.map(account => account.id));
  while (used.has(`account-${index}`)) index += 1;
  return `account-${index}`;
};

const getAccountDisplayName = (account: EmailSkillAccountConfig): string => {
  if (account.id === 'default' && (account.name === 'Default' || account.name === 'default')) {
    return i18nService.t('emailDefaultAccountDisplayName');
  }
  return account.name || account.email || account.id;
};

const getAccountSubtitle = (account: EmailSkillAccountConfig): string => (
  account.email || (account.provider ? (PROVIDER_PRESETS[account.provider]?.label || account.provider) : '')
);

const getChangedAccountKeys = (patch: Partial<EmailSkillAccountConfig>): string => {
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
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      changedKeys.add(key);
    }
  });
  return Array.from(changedKeys).join(',');
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
  allowInsecureCert: account?.imapRejectUnauthorized === false || account?.smtpRejectUnauthorized === false,
  mailboxCustomized: Boolean(account?.mailbox && account.mailbox !== 'INBOX'),
});

const EmailSkillConfig: React.FC = () => {
  const [config, setConfig] = useState<EmailSkillAccountsConfig>({
    version: 1,
    defaultAccountId: '',
    accounts: [],
  });
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null);
  const [connectivityResults, setConnectivityResults] = useState<Record<string, EmailConnectivityTestResult>>({});
  const [connectivityError, setConnectivityError] = useState<string | null>(null);
  const [pendingDeleteAccountId, setPendingDeleteAccountId] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const persistQueueRef = useRef(Promise.resolve());
  const persistPendingCountRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    const loadConfig = async () => {
      try {
        console.debug('[EmailSkillConfig] loading email accounts config');
        const loaded = normalizeConfig(await skillService.getEmailAccountsConfig(SKILL_ID));
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

  const activeAccount = useMemo(
    () => config.accounts.find(account => account.id === activeAccountId) ?? null,
    [activeAccountId, config.accounts],
  );

  const persistConfig = useCallback(async (
    nextConfig: EmailSkillAccountsConfig,
    analyticsChangedKeys = '',
  ) => {
    const normalized = normalizeConfig(nextConfig);
    if (isMountedRef.current) {
      setConfig(normalized);
    }
    persistPendingCountRef.current += 1;
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
    persistPendingCountRef.current = Math.max(0, persistPendingCountRef.current - 1);
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
      const analyticsAccount = normalized.accounts.find(account => account.id === activeAccountId)
        ?? normalized.accounts.find(account => account.id === normalized.defaultAccountId)
        ?? null;
      void reportYdAnalyzer({
        action: LogReporterAction.EmailSkillSettingsSaved,
        ...buildEmailSkillAnalyticsParams(normalized, analyticsAccount),
        changedKeys: analyticsChangedKeys,
      });
    }
    return success;
  }, [activeAccountId]);

  const updateActiveAccount = useCallback((patch: Partial<EmailSkillAccountConfig>) => {
    if (!activeAccount) return;
    setConfig(prev => ({
      ...prev,
      accounts: prev.accounts.map(account =>
        account.id === activeAccount.id ? { ...account, ...patch } : account,
      ),
    }));
  }, [activeAccount]);

  const persistAccountPatch = useCallback(async (
    accountId: string,
    patch: Partial<EmailSkillAccountConfig> = {},
  ) => {
    if (!config.accounts.some(account => account.id === accountId)) return;
    const nextAccounts = config.accounts.map(account =>
      account.id === accountId ? { ...account, ...patch } : account,
    );
    await persistConfig({ ...config, accounts: nextAccounts }, getChangedAccountKeys(patch) || 'account');
  }, [config, persistConfig]);

  const persistActiveAccount = useCallback(async (patch: Partial<EmailSkillAccountConfig> = {}) => {
    if (!activeAccount) return;
    await persistAccountPatch(activeAccount.id, patch);
  }, [activeAccount, persistAccountPatch]);

  const openAccountDetail = (account: EmailSkillAccountConfig) => {
    setActiveAccountId(account.id);
    setShowPassword(false);
    setShowAdvanced(account.provider === 'custom');
    setConnectivityError(null);
  };

  const backToOverview = () => {
    setActiveAccountId(null);
    setConnectivityError(null);
  };

  const handleAddAccount = async () => {
    const id = nextAccountId(config.accounts);
    const account = { ...createEmptyAccount(config.accounts.length + 1), id };
    const nextConfig = normalizeConfig({
      ...config,
      defaultAccountId: config.defaultAccountId || id,
      accounts: [...config.accounts, account],
    });
    openAccountDetail(account);
    await persistConfig(nextConfig, 'account_added');
  };

  const handleRequestDeleteAccount = (accountId: string) => {
    setPendingDeleteAccountId(accountId);
  };

  const handleConfirmDeleteAccount = async () => {
    if (!pendingDeleteAccountId) return;
    const accountId = pendingDeleteAccountId;
    setPendingDeleteAccountId(null);
    const accounts = config.accounts.filter(account => account.id !== accountId);
    const defaultAccountId = config.defaultAccountId === accountId
      ? (accounts.find(account => account.enabled)?.id ?? accounts[0]?.id ?? '')
      : config.defaultAccountId;
    const nextConfig = normalizeConfig({ ...config, accounts, defaultAccountId });
    if (activeAccountId === accountId) {
      backToOverview();
    }
    await persistConfig(nextConfig, 'account_deleted');
  };

  const handleProviderChange = (provider: string) => {
    const preset = PROVIDER_PRESETS[provider];
    if (provider === 'custom') {
      setShowAdvanced(true);
    }
    updateActiveAccount({
      provider,
      ...(preset && provider !== 'custom'
        ? {
            imapHost: preset.imapHost,
            imapPort: preset.imapPort,
            imapTls: true,
            smtpHost: preset.smtpHost,
            smtpPort: preset.smtpPort,
            smtpSecure: preset.smtpSecure,
          }
        : {}),
    });
  };

  const handleEmailBlur = async () => {
    if (!activeAccount) return;
    const email = activeAccount.email.trim();
    await persistActiveAccount({
      email,
      smtpFrom: activeAccount.smtpFrom || email,
      name: activeAccount.name || email.split('@')[0] || activeAccount.id,
    });
  };

  const canTest = Boolean(
    activeAccount?.email
      && activeAccount.password
      && activeAccount.imapHost
      && activeAccount.smtpHost,
  );

  const handleConnectivityTest = async () => {
    if (!activeAccount) return;
    setConnectivityError(null);
    setTestingAccountId(activeAccount.id);
    console.debug('[EmailSkillConfig] testing email account connectivity', {
      accountId: activeAccount.id,
      hasEmail: Boolean(activeAccount.email),
      hasPassword: Boolean(activeAccount.password),
      hasImapHost: Boolean(activeAccount.imapHost),
      hasSmtpHost: Boolean(activeAccount.smtpHost),
    });
    try {
      const result = await skillService.testEmailAccountConnectivity(SKILL_ID, activeAccount);
      if (!isMountedRef.current) return;
      if (result) {
        setConnectivityResults(prev => ({ ...prev, [activeAccount.id]: result }));
        const imapCheck = result.checks.find(check => check.code === 'imap_connection');
        const smtpCheck = result.checks.find(check => check.code === 'smtp_connection');
        void reportYdAnalyzer({
          action: LogReporterAction.EmailSkillConnectionTested,
          ...buildEmailSkillAnalyticsParams(config, activeAccount),
          result: result.verdict,
          imapResult: imapCheck?.level ?? '',
          smtpResult: smtpCheck?.level ?? '',
        });
        console.debug('[EmailSkillConfig] email account connectivity test completed', {
          accountId: activeAccount.id,
          verdict: result.verdict,
        });
      } else {
        setConnectivityError(i18nService.t('connectionFailed'));
        void reportYdAnalyzer({
          action: LogReporterAction.EmailSkillConnectionTested,
          ...buildEmailSkillAnalyticsParams(config, activeAccount),
          result: 'fail',
          imapResult: '',
          smtpResult: '',
        });
        console.warn('[EmailSkillConfig] email account connectivity test returned no result', {
          accountId: activeAccount.id,
        });
      }
    } catch (error) {
      console.error('[EmailSkillConfig] email account connectivity test failed:', error);
      if (!isMountedRef.current) return;
      setConnectivityError(i18nService.t('connectionFailed'));
      void reportYdAnalyzer({
        action: LogReporterAction.EmailSkillConnectionTested,
        ...buildEmailSkillAnalyticsParams(config, activeAccount),
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
    const account = activeAccount;
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
  }, [activeAccount, connectivityError]);

  const handleAskAI = (result: EmailConnectivityTestResult | null) => {
    window.dispatchEvent(new CustomEvent('app:ask-ai', { detail: buildAskAIPrompt(result) }));
  };

  const handleOpenProviderHelp = (url: string) => {
    window.electron.shell.openExternal(url).catch((error: unknown) => {
      console.error('[EmailSkillConfig] failed to open provider help URL:', error);
    });
  };

  const inputClassName =
    'block w-full rounded-lg bg-surface border border-border-subtle focus:border-primary focus:ring-1 focus:ring-primary/30 text-foreground px-3 py-2 text-sm transition-colors';
  const labelClassName = 'block text-xs font-medium text-secondary mb-1';
  const checkboxLabelClassName = 'flex items-center gap-2 py-1 text-sm text-foreground cursor-pointer select-none';
  const checkboxClassName = 'h-4 w-4 rounded border-border text-primary focus:ring-primary/30';

  const renderEnableToggle = (account: EmailSkillAccountConfig) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void persistAccountPatch(account.id, { enabled: !account.enabled });
      }}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
        account.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'
      }`}
      aria-label={account.enabled ? i18nService.t('disable') : i18nService.t('enable')}
      title={account.enabled ? i18nService.t('disable') : i18nService.t('enable')}
    >
      <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
        account.enabled ? 'translate-x-4' : 'translate-x-0'
      }`} />
    </button>
  );

  if (loading) {
    return <div className="p-4 text-xs text-secondary">{i18nService.t('loading')}...</div>;
  }

  const activeResult = activeAccount ? connectivityResults[activeAccount.id] : null;
  const connectivityPassed = activeResult?.verdict === 'pass';
  const currentPreset = activeAccount?.provider ? PROVIDER_PRESETS[activeAccount.provider] : null;
  const providerHint = currentPreset?.hint;
  const providerHelpUrl = currentPreset?.helpUrl;
  const pendingDeleteAccount = config.accounts.find(account => account.id === pendingDeleteAccountId) ?? null;

  const renderErrorBanner = () => {
    const message = loadError || persistError;
    if (!message) return null;
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
        {message}
      </div>
    );
  };

  const renderAccountOverview = () => (
    <div className="space-y-4">
      {renderErrorBanner()}

      {config.accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-10 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <EnvelopeIcon className="h-6 w-6 text-primary" />
          </span>
          <p className="mt-3 text-sm text-foreground">{i18nService.t('emailNoAccounts')}</p>
          <button
            type="button"
            onClick={() => void handleAddAccount()}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover active:scale-[0.98]"
          >
            <PlusIcon className="h-4 w-4" />
            {i18nService.t('emailAddAccount')}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {config.accounts.map(account => {
            const subtitle = getAccountSubtitle(account);
            return (
              <div
                key={account.id}
                role="button"
                tabIndex={0}
                onClick={() => openAccountDetail(account)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openAccountDetail(account);
                  }
                }}
                className="group relative flex min-h-[86px] flex-col rounded-lg border border-border-subtle bg-surface p-3 text-left transition-colors hover:border-primary/40 hover:bg-surface-raised focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div className="flex items-start gap-2.5">
                  <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <EnvelopeIcon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium leading-5 text-foreground">
                      {getAccountDisplayName(account)}
                    </div>
                    {subtitle && (
                      <div className="mt-0.5 truncate text-xs text-secondary">{subtitle}</div>
                    )}
                    <div className={`mt-0.5 flex items-center gap-1 text-xs ${
                      account.enabled ? 'text-green-600 dark:text-green-400' : 'text-secondary'
                    }`}>
                      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                        account.enabled ? 'bg-green-500' : 'bg-gray-400'
                      }`} />
                      <span className="truncate">
                        {account.enabled ? i18nService.t('enabled') : i18nService.t('disabled')}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1 pl-1">
                    {renderEnableToggle(account)}
                    <button
                      type="button"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleRequestDeleteAccount(account.id);
                      }}
                      className="rounded-md p-1 text-secondary opacity-70 transition-colors hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100"
                      aria-label={i18nService.t('delete')}
                      title={i18nService.t('delete')}
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => void handleAddAccount()}
            className="flex min-h-[86px] flex-col items-center justify-center rounded-lg border border-dashed border-border-subtle bg-surface text-secondary transition-colors hover:border-primary/50 hover:bg-surface-raised hover:text-primary"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-raised">
              <PlusIcon className="h-4 w-4" />
            </span>
            <span className="mt-2 text-sm font-medium">
              {i18nService.t('emailAddAccount')}
            </span>
          </button>
        </div>
      )}
    </div>
  );

  const renderAccountDetail = (account: EmailSkillAccountConfig) => {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-border-subtle pb-3">
          <button
            type="button"
            onClick={backToOverview}
            className="-ml-1 inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary/25"
            aria-label={i18nService.t('back')}
          >
            <ArrowLeftIcon className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{i18nService.t('back')}</span>
          </button>
          <h3
            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            title={getAccountDisplayName(account)}
          >
            {getAccountDisplayName(account)}
          </h3>

          <div className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
            account.enabled
              ? 'bg-green-500/15 text-green-600 dark:text-green-400'
              : 'bg-gray-500/15 text-gray-500 dark:text-gray-400'
          }`}>
            {account.enabled ? i18nService.t('enabled') : i18nService.t('disabled')}
          </div>

          {renderEnableToggle(account)}

          <button
            type="button"
            onClick={() => handleRequestDeleteAccount(account.id)}
            className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-red-500 transition-colors hover:bg-red-500/10"
            title={i18nService.t('delete')}
          >
            <TrashIcon className="h-4 w-4" />
            {i18nService.t('delete')}
          </button>
        </div>

        {renderErrorBanner()}

        <div className="grid grid-cols-2 gap-x-4 gap-y-3 max-md:grid-cols-1">
          <div>
            <label className={labelClassName}>{i18nService.t('emailAccountName')}</label>
            <input
              type="text"
              value={account.name}
              onChange={e => updateActiveAccount({ name: e.target.value })}
              onBlur={() => void persistActiveAccount()}
              className={inputClassName}
            />
          </div>
          <div>
            <label className={labelClassName}>{i18nService.t('emailProvider')}</label>
            <select
              value={account.provider ?? ''}
              onChange={e => handleProviderChange(e.target.value)}
              onBlur={() => void persistActiveAccount()}
              className={inputClassName}
            >
              <option value="">{i18nService.t('emailSelectProvider')}</option>
              {Object.entries(PROVIDER_PRESETS).map(([key, preset]) => (
                <option key={key} value={key}>
                  {key === 'custom' ? i18nService.t('emailCustomProvider') : preset.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClassName}>
              {i18nService.t('emailAddress')}<span className="text-red-500 ml-0.5">*</span>
            </label>
            <input
              type="email"
              value={account.email}
              onChange={e => updateActiveAccount({ email: e.target.value })}
              onBlur={() => void handleEmailBlur()}
              className={inputClassName}
              placeholder={i18nService.t('emailAddressPlaceholder')}
            />
          </div>
          <div>
            <label className={labelClassName}>
              {i18nService.t('emailPassword')}<span className="text-red-500 ml-0.5">*</span>
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={account.password ?? ''}
                onChange={e => updateActiveAccount({ password: e.target.value })}
                onBlur={() => void persistActiveAccount()}
                className={`${inputClassName} pr-16`}
                placeholder={i18nService.t('emailPasswordPlaceholder')}
              />
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {account.password && (
                  <button
                    type="button"
                    onClick={() => {
                      updateActiveAccount({ password: '' });
                      void persistActiveAccount({ password: '' });
                    }}
                    className="rounded p-0.5 text-secondary transition-colors hover:text-primary"
                  >
                    <XCircleIconSolid className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="rounded p-0.5 text-secondary transition-colors hover:text-primary"
                >
                  {showPassword ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <p className="mt-1 text-xs leading-4 text-secondary">{i18nService.t('emailPasswordHelp')}</p>
          </div>
        </div>

        {(providerHint || providerHelpUrl) && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 dark:border-blue-800 dark:bg-blue-900/20">
            {providerHint && (
              <p className="text-xs leading-5 text-secondary">{i18nService.t(providerHint)}</p>
            )}
            {providerHelpUrl && (
              <button
                type="button"
                onClick={() => handleOpenProviderHelp(providerHelpUrl)}
                className={`inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline ${providerHint ? 'mt-1' : ''}`}
              >
                {i18nService.t('emailProviderGuideLink')}
                <ArrowTopRightOnSquareIcon className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="inline-flex items-center gap-1 text-xs font-medium text-secondary transition-colors hover:text-primary"
          >
            <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
            {i18nService.t('emailAdvancedSettings')}
          </button>

          {showAdvanced && (
            <div className="mt-3 space-y-3 border-l-2 border-border-subtle pl-3">
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 max-md:grid-cols-1">
                <div>
                  <label className={labelClassName}>{i18nService.t('emailImapHost')}</label>
                  <input
                    type="text"
                    value={account.imapHost ?? ''}
                    onChange={e => updateActiveAccount({ imapHost: e.target.value })}
                    onBlur={() => void persistActiveAccount()}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className={labelClassName}>{i18nService.t('emailImapPort')}</label>
                  <input
                    type="number"
                    value={account.imapPort ?? 993}
                    onChange={e => updateActiveAccount({ imapPort: parseInt(e.target.value, 10) || 993 })}
                    onBlur={() => void persistActiveAccount()}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className={labelClassName}>{i18nService.t('emailSmtpHost')}</label>
                  <input
                    type="text"
                    value={account.smtpHost ?? ''}
                    onChange={e => updateActiveAccount({ smtpHost: e.target.value })}
                    onBlur={() => void persistActiveAccount()}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className={labelClassName}>{i18nService.t('emailSmtpPort')}</label>
                  <input
                    type="number"
                    value={account.smtpPort ?? 587}
                    onChange={e => updateActiveAccount({ smtpPort: parseInt(e.target.value, 10) || 587 })}
                    onBlur={() => void persistActiveAccount()}
                    className={inputClassName}
                  />
                </div>
              </div>

              <div>
                <label className={labelClassName}>{i18nService.t('emailMailbox')}</label>
                <input
                  type="text"
                  value={account.mailbox ?? 'INBOX'}
                  onChange={e => updateActiveAccount({ mailbox: e.target.value })}
                  onBlur={() => void persistActiveAccount()}
                  className={inputClassName}
                />
              </div>

              <div className="grid grid-cols-2 gap-x-4 max-md:grid-cols-1">
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={account.imapTls !== false}
                    onChange={e => {
                      const imapTls = e.target.checked;
                      updateActiveAccount({ imapTls });
                      void persistActiveAccount({ imapTls });
                    }}
                    className={checkboxClassName}
                  />
                  IMAP TLS
                </label>
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={account.smtpSecure === true}
                    onChange={e => {
                      const smtpSecure = e.target.checked;
                      updateActiveAccount({ smtpSecure });
                      void persistActiveAccount({ smtpSecure });
                    }}
                    className={checkboxClassName}
                  />
                  SMTP SSL
                </label>
                <label className={checkboxLabelClassName} title={i18nService.t('emailAllowInsecureCertHint')}>
                  <input
                    type="checkbox"
                    checked={account.imapRejectUnauthorized === false || account.smtpRejectUnauthorized === false}
                    onChange={e => {
                      const rejectUnauthorized = !e.target.checked;
                      updateActiveAccount({
                        imapRejectUnauthorized: rejectUnauthorized,
                        smtpRejectUnauthorized: rejectUnauthorized,
                      });
                      void persistActiveAccount({
                        imapRejectUnauthorized: rejectUnauthorized,
                        smtpRejectUnauthorized: rejectUnauthorized,
                      });
                    }}
                    className={checkboxClassName}
                  />
                  {i18nService.t('emailAllowInsecureCert')}
                </label>
                <label className={checkboxLabelClassName}>
                  <input
                    type="checkbox"
                    checked={account.requireSendConfirmation !== false}
                    onChange={e => {
                      const requireSendConfirmation = e.target.checked;
                      updateActiveAccount({ requireSendConfirmation });
                      void persistActiveAccount({ requireSendConfirmation });
                    }}
                    className={checkboxClassName}
                  />
                  {i18nService.t('emailRequireSendConfirmation')}
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-border-subtle pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleConnectivityTest()}
              disabled={testingAccountId === account.id || !canTest}
              className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]"
            >
              <SignalIcon className="mr-1.5 h-3.5 w-3.5" />
              {testingAccountId === account.id ? i18nService.t('imConnectivityTesting') : i18nService.t('imConnectivityTest')}
            </button>
            {activeResult && (
              <div className={`flex items-center gap-1 text-xs ${connectivityPassed ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                {connectivityPassed ? <CheckCircleIcon className="h-4 w-4" /> : <XCircleIcon className="h-4 w-4" />}
                <span>{connectivityPassed ? i18nService.t('connectionSuccess') : i18nService.t('connectionFailed')}</span>
                <span className="text-[11px] text-secondary">{new Date(activeResult.testedAt).toLocaleString()}</span>
              </div>
            )}
          </div>

          {connectivityError && (
            <div className="space-y-2">
              <div className="text-xs text-red-600 dark:text-red-400">{connectivityError}</div>
              <button
                type="button"
                onClick={() => handleAskAI(null)}
                className="inline-flex items-center gap-1 rounded-lg border border-claude-accent/50 px-2.5 py-1 text-xs font-medium text-claude-accent transition-colors hover:bg-claude-accent/10 active:scale-[0.98]"
              >
                <SparklesIcon className="h-3 w-3" />
                {i18nService.t('emailConnectivityAskAI')}
              </button>
            </div>
          )}

          {activeResult && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
                {activeResult.checks.map(check => {
                  const checkPassed = check.level === 'pass';
                  const checkLabel = check.code === 'imap_connection' ? 'IMAP' : 'SMTP';
                  return (
                    <div key={check.code} className="rounded-lg border border-border-subtle bg-surface px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className={`flex items-center gap-1 text-xs font-medium ${checkPassed ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {checkPassed ? <CheckCircleIcon className="h-3.5 w-3.5" /> : <XCircleIcon className="h-3.5 w-3.5" />}
                          <span>{checkLabel}</span>
                        </div>
                        <span className="text-[11px] text-secondary">{`${check.durationMs}ms`}</span>
                      </div>
                      <div className="mt-1 break-words text-xs text-secondary">{check.message}</div>
                    </div>
                  );
                })}
              </div>
              {!connectivityPassed && (
                <button
                  type="button"
                  onClick={() => handleAskAI(activeResult)}
                  className="inline-flex items-center gap-1 rounded-lg border border-claude-accent/50 px-2.5 py-1 text-xs font-medium text-claude-accent transition-colors hover:bg-claude-accent/10 active:scale-[0.98]"
                >
                  <SparklesIcon className="h-3 w-3" />
                  {i18nService.t('emailConnectivityAskAI')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      {activeAccount ? renderAccountDetail(activeAccount) : renderAccountOverview()}

      {pendingDeleteAccount && (
        <Modal
          onClose={() => setPendingDeleteAccountId(null)}
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
