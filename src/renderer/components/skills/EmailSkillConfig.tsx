import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronUpIcon,
  SignalIcon,
  CheckCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';

const SKILL_ID = 'imap-smtp-email';

interface ProviderPreset {
  label: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: string;
  hint?: string;
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
    imapPort: '993',
    smtpHost: 'smtp.gmail.com',
    smtpPort: '587',
    smtpSecure: 'false',
    hint: 'emailHintGmail',
  },
  outlook: {
    label: 'Outlook',
    imapHost: 'outlook.office365.com',
    imapPort: '993',
    smtpHost: 'smtp.office365.com',
    smtpPort: '587',
    smtpSecure: 'false',
  },
  '163': {
    label: '163.com',
    imapHost: 'imap.163.com',
    imapPort: '993',
    smtpHost: 'smtp.163.com',
    smtpPort: '465',
    smtpSecure: 'true',
    hint: 'emailHint163',
  },
  '126': {
    label: '126.com',
    imapHost: 'imap.126.com',
    imapPort: '993',
    smtpHost: 'smtp.126.com',
    smtpPort: '465',
    smtpSecure: 'true',
    hint: 'emailHint163',
  },
  qq: {
    label: 'QQ Mail',
    imapHost: 'imap.qq.com',
    imapPort: '993',
    smtpHost: 'smtp.qq.com',
    smtpPort: '587',
    smtpSecure: 'false',
    hint: 'emailHintQQ',
  },
  custom: {
    label: '',
    imapHost: '',
    imapPort: '993',
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: 'false',
  },
};

const detectProvider = (config: Record<string, string>): string => {
  const imapHost = (config.IMAP_HOST || '').toLowerCase();
  if (imapHost.includes('gmail')) return 'gmail';
  if (imapHost.includes('outlook') || imapHost.includes('office365')) return 'outlook';
  if (imapHost === 'imap.163.com') return '163';
  if (imapHost === 'imap.126.com') return '126';
  if (imapHost.includes('qq.com')) return 'qq';
  if (imapHost) return 'custom';
  return '';
};

interface EmailSkillConfigProps {
  onClose?: () => void;
}

const EmailSkillConfig: React.FC<EmailSkillConfigProps> = ({ onClose }) => {
  const [provider, setProvider] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState('false');
  const [imapTls, setImapTls] = useState('true');
  const [mailbox, setMailbox] = useState('INBOX');
  const [loading, setLoading] = useState(true);
  const [isPersisting, setIsPersisting] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [connectivityResult, setConnectivityResult] = useState<EmailConnectivityTestResult | null>(null);
  const [connectivityError, setConnectivityError] = useState<string | null>(null);

  const isMountedRef = useRef(true);
  const persistInFlightRef = useRef(false);
  const persistQueuedRef = useRef(false);
  const latestConfigRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const loadConfig = async () => {
      const config = await skillService.getSkillConfig(SKILL_ID);
      if (config.IMAP_USER) setEmail(config.IMAP_USER);
      if (config.IMAP_PASS) setPassword(config.IMAP_PASS);
      if (config.IMAP_HOST) setImapHost(config.IMAP_HOST);
      if (config.IMAP_PORT) setImapPort(config.IMAP_PORT);
      if (config.SMTP_HOST) setSmtpHost(config.SMTP_HOST);
      if (config.SMTP_PORT) setSmtpPort(config.SMTP_PORT);
      if (config.SMTP_SECURE) setSmtpSecure(config.SMTP_SECURE);
      if (config.IMAP_TLS) setImapTls(config.IMAP_TLS);
      if (config.IMAP_MAILBOX) setMailbox(config.IMAP_MAILBOX);

      const detected = detectProvider(config);
      if (detected) setProvider(detected);

      setLoading(false);
    };
    loadConfig();
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const buildConfig = useCallback((): Record<string, string> => ({
    IMAP_HOST: imapHost,
    IMAP_PORT: imapPort,
    IMAP_USER: email,
    IMAP_PASS: password,
    IMAP_TLS: imapTls,
    IMAP_REJECT_UNAUTHORIZED: 'true',
    IMAP_MAILBOX: mailbox,
    SMTP_HOST: smtpHost,
    SMTP_PORT: smtpPort,
    SMTP_SECURE: smtpSecure,
    SMTP_USER: email,
    SMTP_PASS: password,
    SMTP_FROM: email,
    SMTP_REJECT_UNAUTHORIZED: 'true',
  }), [
    email,
    imapHost,
    imapPort,
    imapTls,
    mailbox,
    password,
    smtpHost,
    smtpPort,
    smtpSecure,
  ]);

  useEffect(() => {
    latestConfigRef.current = buildConfig();
  }, [buildConfig]);

  const flushPersistQueue = useCallback(async () => {
    if (persistInFlightRef.current) {
      return;
    }
    persistInFlightRef.current = true;
    if (isMountedRef.current) {
      setIsPersisting(true);
    }

    while (persistQueuedRef.current) {
      persistQueuedRef.current = false;
      const success = await skillService.setSkillConfig(SKILL_ID, latestConfigRef.current);
      if (!isMountedRef.current) {
        continue;
      }
      if (success) {
        setPersistError(null);
      } else {
        setPersistError(i18nService.t('emailConfigError'));
      }
    }

    persistInFlightRef.current = false;
    if (isMountedRef.current) {
      setIsPersisting(false);
    }
  }, []);

  const queuePersist = useCallback(() => {
    latestConfigRef.current = buildConfig();
    persistQueuedRef.current = true;
    void flushPersistQueue();
  }, [buildConfig, flushPersistQueue]);

  const handleProviderChange = (newProvider: string) => {
    setProvider(newProvider);
    if (newProvider && newProvider !== 'custom') {
      const preset = PROVIDER_PRESETS[newProvider];
      if (preset) {
        setImapHost(preset.imapHost);
        setImapPort(preset.imapPort);
        setSmtpHost(preset.smtpHost);
        setSmtpPort(preset.smtpPort);
        setSmtpSecure(preset.smtpSecure);
        setImapTls('true');
      }
      return;
    }

    if (newProvider === 'custom') {
      const customPreset = PROVIDER_PRESETS.custom;
      setImapHost(customPreset.imapHost);
      setImapPort(customPreset.imapPort);
      setSmtpHost(customPreset.smtpHost);
      setSmtpPort(customPreset.smtpPort);
      setSmtpSecure(customPreset.smtpSecure);
      setImapTls('true');
    }
  };

  const handleConnectivityTest = async () => {
    setConnectivityError(null);
    setConnectivityResult(null);
    setIsTesting(true);
    const result = await skillService.testEmailConnectivity(SKILL_ID, buildConfig());
    if (result) {
      setConnectivityResult(result);
    } else {
      setConnectivityError(i18nService.t('connectionFailed'));
    }
    setIsTesting(false);
  };

  const currentPreset = provider ? PROVIDER_PRESETS[provider] : null;
  const hintKey = currentPreset?.hint;
  const canTest = Boolean(email && password && imapHost && smtpHost);
  const connectivityPassed = connectivityResult?.verdict === 'pass';

  const inputClassName = 'block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs';
  const labelClassName = 'block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1';

  if (loading) {
    return (
      <div className="p-4 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('loading')}...
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/30 bg-claude-surface/30">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('emailConfig')}
        </h4>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent transition-colors"
          >
            {i18nService.t('collapse')}
          </button>
        )}
      </div>
      {(isPersisting || persistError) && (
        <div className={`text-xs ${persistError ? 'text-red-600 dark:text-red-400' : 'text-claude-textSecondary dark:text-claude-darkTextSecondary'}`}>
          {persistError || `${i18nService.t('saving')}...`}
        </div>
      )}

      {/* Provider Selection */}
      <div>
        <label className={labelClassName}>{i18nService.t('emailProvider')}</label>
        <select
          value={provider}
          onChange={(e) => handleProviderChange(e.target.value)}
          onBlur={queuePersist}
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

      {/* Hint */}
      {hintKey && (
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-3 py-2">
          {i18nService.t(hintKey)}
        </div>
      )}

      {/* Email */}
      <div>
        <label className={labelClassName}>{i18nService.t('emailAddress')}</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={queuePersist}
          className={inputClassName}
          placeholder="your@email.com"
        />
      </div>

      {/* Password */}
      <div>
        <label className={labelClassName}>{i18nService.t('emailPassword')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={queuePersist}
          className={inputClassName}
          placeholder={i18nService.t('emailPasswordPlaceholder')}
        />
      </div>

      {/* Advanced Settings Toggle */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="flex items-center gap-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent transition-colors"
      >
        {showAdvanced ? (
          <ChevronUpIcon className="h-3.5 w-3.5" />
        ) : (
          <ChevronDownIcon className="h-3.5 w-3.5" />
        )}
        {i18nService.t('emailAdvancedSettings')}
      </button>

      {/* Advanced Settings */}
      {showAdvanced && (
        <div className="space-y-3 pl-2 border-l-2 border-claude-border dark:border-claude-darkBorder">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClassName}>IMAP Host</label>
              <input
                type="text"
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                onBlur={queuePersist}
                className={inputClassName}
                placeholder="imap.example.com"
              />
            </div>
            <div>
              <label className={labelClassName}>IMAP Port</label>
              <input
                type="text"
                value={imapPort}
                onChange={(e) => setImapPort(e.target.value)}
                onBlur={queuePersist}
                className={inputClassName}
                placeholder="993"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClassName}>SMTP Host</label>
              <input
                type="text"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                onBlur={queuePersist}
                className={inputClassName}
                placeholder="smtp.example.com"
              />
            </div>
            <div>
              <label className={labelClassName}>SMTP Port</label>
              <input
                type="text"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                onBlur={queuePersist}
                className={inputClassName}
                placeholder="587"
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs dark:text-claude-darkText text-claude-text">
              <input
                type="checkbox"
                checked={imapTls === 'true'}
                onChange={(e) => setImapTls(e.target.checked ? 'true' : 'false')}
                onBlur={queuePersist}
                className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent rounded"
              />
              IMAP TLS
            </label>
            <label className="flex items-center gap-2 text-xs dark:text-claude-darkText text-claude-text">
              <input
                type="checkbox"
                checked={smtpSecure === 'true'}
                onChange={(e) => setSmtpSecure(e.target.checked ? 'true' : 'false')}
                onBlur={queuePersist}
                className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent rounded"
              />
              SMTP SSL
            </label>
          </div>

          <div>
            <label className={labelClassName}>{i18nService.t('emailMailbox')}</label>
            <input
              type="text"
              value={mailbox}
              onChange={(e) => setMailbox(e.target.value)}
              onBlur={queuePersist}
              className={inputClassName}
              placeholder="INBOX"
            />
          </div>
        </div>
      )}

      {/* Connectivity Test */}
      <div className="space-y-3 pt-1">
        <button
          type="button"
          onClick={handleConnectivityTest}
          disabled={isTesting || !canTest}
          className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
        >
          <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
          {isTesting ? i18nService.t('imConnectivityTesting') : i18nService.t('imConnectivityTest')}
        </button>

        {connectivityError && (
          <div className="text-xs text-red-600 dark:text-red-400">
            {connectivityError}
          </div>
        )}

        {connectivityResult && (
          <div className="space-y-2">
            <div className={`flex items-center gap-1 text-xs ${connectivityPassed ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {connectivityPassed ? (
                <CheckCircleIcon className="h-4 w-4" />
              ) : (
                <XCircleIcon className="h-4 w-4" />
              )}
              <span>
                {connectivityPassed ? i18nService.t('connectionSuccess') : i18nService.t('connectionFailed')}
              </span>
              <span className="text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {new Date(connectivityResult.testedAt).toLocaleString()}
              </span>
            </div>
            <div className="space-y-1.5">
              {connectivityResult.checks.map((check) => {
                const checkPassed = check.level === 'pass';
                const checkLabel = check.code === 'imap_connection' ? 'IMAP' : 'SMTP';
                return (
                  <div
                    key={check.code}
                    className="rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 px-2.5 py-2 dark:bg-claude-darkSurface/25 bg-white/70"
                  >
                    <div className={`flex items-center gap-1 text-xs font-medium ${checkPassed ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {checkPassed ? (
                        <CheckCircleIcon className="h-3.5 w-3.5" />
                      ) : (
                        <XCircleIcon className="h-3.5 w-3.5" />
                      )}
                      <span>{checkLabel}</span>
                    </div>
                    <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {check.message}
                    </div>
                    <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {`${check.durationMs}ms`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default EmailSkillConfig;
