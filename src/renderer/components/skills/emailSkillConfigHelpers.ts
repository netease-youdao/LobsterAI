import type { EmailSkillAccountConfig, EmailSkillAccountsConfig } from '../../services/skill';

export const EmailProviderId = {
  Netease163: '163',
  Netease126: '126',
  QQ: 'qq',
  Gmail: 'gmail',
  Outlook: 'outlook',
  Custom: 'custom',
} as const;

export type EmailProviderId = typeof EmailProviderId[keyof typeof EmailProviderId];

export interface EmailProviderPreset {
  id: EmailProviderId;
  labelKey: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  hintKey?: string;
  helpUrl?: string;
  helpLinkKey?: string;
}

const NETEASE_HELP_URL =
  'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089';

export const EMAIL_PROVIDER_ORDER: readonly EmailProviderId[] = [
  EmailProviderId.Netease163,
  EmailProviderId.Netease126,
  EmailProviderId.QQ,
  EmailProviderId.Gmail,
  EmailProviderId.Outlook,
  EmailProviderId.Custom,
];

export const EMAIL_PROVIDER_PRESETS: Record<EmailProviderId, EmailProviderPreset> = {
  [EmailProviderId.Netease163]: {
    id: EmailProviderId.Netease163,
    labelKey: 'emailProviderLabel163',
    imapHost: 'imap.163.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.163.com',
    smtpPort: 465,
    smtpSecure: true,
    hintKey: 'emailHint163',
    helpUrl: NETEASE_HELP_URL,
    helpLinkKey: 'emailGetAuthCodeLink',
  },
  [EmailProviderId.Netease126]: {
    id: EmailProviderId.Netease126,
    labelKey: 'emailProviderLabel126',
    imapHost: 'imap.126.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.126.com',
    smtpPort: 465,
    smtpSecure: true,
    hintKey: 'emailHint163',
    helpUrl: NETEASE_HELP_URL,
    helpLinkKey: 'emailGetAuthCodeLink',
  },
  [EmailProviderId.QQ]: {
    id: EmailProviderId.QQ,
    labelKey: 'emailProviderLabelQQ',
    imapHost: 'imap.qq.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.qq.com',
    smtpPort: 587,
    smtpSecure: false,
    hintKey: 'emailHintQQ',
    helpUrl: 'https://help.mail.qq.com/detail/106/985',
    helpLinkKey: 'emailGetAuthCodeLink',
  },
  [EmailProviderId.Gmail]: {
    id: EmailProviderId.Gmail,
    labelKey: 'emailProviderLabelGmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpSecure: false,
    hintKey: 'emailHintGmail',
    helpUrl: 'https://support.google.com/accounts/answer/185833',
    helpLinkKey: 'emailGetAppPasswordLink',
  },
  [EmailProviderId.Outlook]: {
    id: EmailProviderId.Outlook,
    labelKey: 'emailProviderLabelOutlook',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: false,
    hintKey: 'emailHintOutlook',
    helpUrl:
      'https://support.microsoft.com/office/pop-imap-and-smtp-settings-8361e398-8af4-4e97-b147-6c6c4ac95353',
    helpLinkKey: 'emailProviderGuideShort',
  },
  [EmailProviderId.Custom]: {
    id: EmailProviderId.Custom,
    labelKey: 'emailCustomProvider',
    imapHost: '',
    imapPort: 993,
    imapTls: true,
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    hintKey: 'emailHintCustom',
  },
};

export interface DomainServerPreset {
  provider: EmailProviderId;
  labelKey?: string;
  matchedLabel?: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

const KNOWN_DOMAIN_TO_PROVIDER: Record<string, EmailProviderId> = {
  '163.com': EmailProviderId.Netease163,
  '126.com': EmailProviderId.Netease126,
  'qq.com': EmailProviderId.QQ,
  'foxmail.com': EmailProviderId.QQ,
  'gmail.com': EmailProviderId.Gmail,
  'googlemail.com': EmailProviderId.Gmail,
  'outlook.com': EmailProviderId.Outlook,
  'hotmail.com': EmailProviderId.Outlook,
  'live.com': EmailProviderId.Outlook,
  'msn.com': EmailProviderId.Outlook,
};

const NETEASE_VARIANT_DOMAINS = new Set<string>([
  'vip.163.com',
  'vip.126.com',
  '188.com',
  'vip.188.com',
  'yeah.net',
]);

export function isEmailProviderId(value?: string): value is EmailProviderId {
  return Boolean(value && value in EMAIL_PROVIDER_PRESETS);
}

export function getEmailProviderPreset(provider?: string): EmailProviderPreset | null {
  return isEmailProviderId(provider) ? EMAIL_PROVIDER_PRESETS[provider] : null;
}

export function extractEmailDomain(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return '';
  return trimmed.slice(atIndex + 1);
}

export function isLikelyValidEmailDomain(domain: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) && domain.split('.').pop()!.length >= 2;
}

/**
 * Detect known IMAP/SMTP server settings from an email address.
 * Returns null while the domain is unrecognized so typing does not prematurely switch to Custom.
 */
export function detectKnownEmailDomainPreset(email: string): DomainServerPreset | null {
  const domain = extractEmailDomain(email);
  if (!domain) return null;

  const provider = KNOWN_DOMAIN_TO_PROVIDER[domain];
  if (provider) {
    const preset = EMAIL_PROVIDER_PRESETS[provider];
    return {
      provider,
      labelKey: preset.labelKey,
      imapHost: preset.imapHost,
      imapPort: preset.imapPort,
      imapTls: preset.imapTls,
      smtpHost: preset.smtpHost,
      smtpPort: preset.smtpPort,
      smtpSecure: preset.smtpSecure,
    };
  }

  if (NETEASE_VARIANT_DOMAINS.has(domain)) {
    return {
      provider: EmailProviderId.Custom,
      matchedLabel: domain,
      imapHost: `imap.${domain}`,
      imapPort: 993,
      imapTls: true,
      smtpHost: `smtp.${domain}`,
      smtpPort: 465,
      smtpSecure: true,
    };
  }

  return null;
}

export function createDraftEmailAccount(id: string): EmailSkillAccountConfig {
  return {
    id,
    name: '',
    enabled: true,
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
  };
}

export function nextEmailAccountId(accounts: readonly EmailSkillAccountConfig[]): string {
  let index = accounts.length + 1;
  const used = new Set(accounts.map(account => account.id));
  while (used.has(`account-${index}`)) {
    index += 1;
  }
  return `account-${index}`;
}

export function isEmailAccountConfigured(account: EmailSkillAccountConfig | null | undefined): boolean {
  if (!account) return false;
  return Boolean(
    account.email?.trim()
      && account.password?.trim()
      && account.imapHost?.trim()
      && account.smtpHost?.trim(),
  );
}

export function normalizeEmailAccountsConfig(config: EmailSkillAccountsConfig): EmailSkillAccountsConfig {
  const accounts = config.accounts.map((account, index) => {
    const id = account.id || `account-${index + 1}`;
    const base = createDraftEmailAccount(id);
    const merged: EmailSkillAccountConfig = {
      ...base,
      ...account,
      id,
      enabled: account.enabled ?? false,
      name: account.name || account.email?.split('@')[0] || id,
    };
    return merged;
  });
  const defaultAccount = accounts.find(account => account.id === config.defaultAccountId && account.enabled)
    ?? accounts.find(account => account.enabled)
    ?? accounts[0];
  return {
    version: 1,
    defaultAccountId: defaultAccount?.id ?? '',
    accounts,
  };
}

export function applyProviderPresetToDraft(
  draft: EmailSkillAccountConfig,
  provider: string,
): EmailSkillAccountConfig {
  const preset = getEmailProviderPreset(provider);
  if (!preset || provider === EmailProviderId.Custom) {
    return {
      ...draft,
      provider,
    };
  }
  return {
    ...draft,
    provider,
    imapHost: preset.imapHost,
    imapPort: preset.imapPort,
    imapTls: preset.imapTls,
    smtpHost: preset.smtpHost,
    smtpPort: preset.smtpPort,
    smtpSecure: preset.smtpSecure,
  };
}

export function commitEmailAccountDraft(
  config: EmailSkillAccountsConfig,
  draft: EmailSkillAccountConfig,
  options: {
    isNew: boolean;
    makeDefault: boolean;
    fallbackName?: string;
    previousEmail?: string;
  },
): EmailSkillAccountsConfig {
  const email = draft.email.trim();
  const trimmedName = draft.name.trim();
  const resolvedName = trimmedName
    || options.fallbackName?.trim()
    || email.split('@')[0]
    || draft.id;

  const existingSmtpFrom = draft.smtpFrom?.trim() ?? '';
  const shouldSyncSmtpFrom = options.isNew
    || !existingSmtpFrom
    || (options.previousEmail !== undefined && existingSmtpFrom === options.previousEmail.trim());

  const savedAccount: EmailSkillAccountConfig = {
    ...draft,
    name: resolvedName,
    email,
    imapHost: draft.imapHost?.trim() ?? '',
    smtpHost: draft.smtpHost?.trim() ?? '',
    smtpFrom: shouldSyncSmtpFrom ? email : existingSmtpFrom,
    mailbox: draft.mailbox?.trim() || 'INBOX',
    enabled: options.isNew ? true : draft.enabled,
  };

  const accounts = options.isNew
    ? [...config.accounts, savedAccount]
    : config.accounts.map(account => (account.id === savedAccount.id ? savedAccount : account));

  let defaultAccountId = config.defaultAccountId;
  if (options.makeDefault && savedAccount.enabled) {
    defaultAccountId = savedAccount.id;
  } else if (!options.makeDefault && defaultAccountId === savedAccount.id) {
    const otherEnabled = accounts.find(account => account.id !== savedAccount.id && account.enabled);
    if (otherEnabled) {
      defaultAccountId = otherEnabled.id;
    }
  }

  return normalizeEmailAccountsConfig({
    ...config,
    defaultAccountId,
    accounts,
  });
}

export function toggleEmailAccountEnabled(
  config: EmailSkillAccountsConfig,
  accountId: string,
): EmailSkillAccountsConfig | null {
  const target = config.accounts.find(account => account.id === accountId);
  if (!target) return null;

  const nextEnabled = !target.enabled;
  if (nextEnabled && !isEmailAccountConfigured(target)) {
    return null;
  }

  const accounts = config.accounts.map(account =>
    account.id === accountId ? { ...account, enabled: nextEnabled } : account,
  );

  return normalizeEmailAccountsConfig({
    ...config,
    accounts,
  });
}

export function removeEmailAccount(
  config: EmailSkillAccountsConfig,
  accountId: string,
): EmailSkillAccountsConfig {
  const accounts = config.accounts.filter(account => account.id !== accountId);
  const defaultAccountId = config.defaultAccountId === accountId
    ? (accounts.find(account => account.enabled)?.id ?? accounts[0]?.id ?? '')
    : config.defaultAccountId;
  return normalizeEmailAccountsConfig({
    ...config,
    defaultAccountId,
    accounts,
  });
}
