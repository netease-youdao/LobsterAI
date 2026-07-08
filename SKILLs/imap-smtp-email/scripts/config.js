const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const SKILL_DIR = path.resolve(__dirname, '..');
const ACCOUNTS_PATH = process.env.EMAIL_ACCOUNTS_PATH || path.join(SKILL_DIR, 'accounts.json');
const ENV_PATH = process.env.EMAIL_ENV_PATH || path.join(SKILL_DIR, '.env');

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() === 'true';
}

function parsePort(value, defaultValue) {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function slugifyAccountId(value, fallback = 'default') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/@.+$/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function redactEmail(value) {
  if (!value) return value;
  return String(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, email => {
    const [local, domain] = email.split('@');
    if (!domain) return '[redacted-email]';
    const prefix = local.slice(0, Math.min(2, local.length));
    return `${prefix}${local.length > 2 ? '***' : '*'}@${domain}`;
  });
}

function loadLegacyEnv() {
  const parsed = fs.existsSync(ENV_PATH) ? dotenv.parse(fs.readFileSync(ENV_PATH)) : {};
  return { ...parsed, ...process.env };
}

function hasLegacyEnv(env) {
  return Boolean(env.IMAP_USER || env.SMTP_USER || env.IMAP_HOST || env.SMTP_HOST);
}

function legacyEnvToAccount(env, id = 'default') {
  const email = env.IMAP_USER || env.SMTP_USER || env.SMTP_FROM || '';
  return {
    id,
    name: email ? email.split('@')[0] : 'Default',
    enabled: true,
    provider: '',
    email,
    password: env.IMAP_PASS || env.SMTP_PASS || '',
    imapHost: env.IMAP_HOST || '',
    imapPort: parsePort(env.IMAP_PORT, 993),
    imapTls: parseBoolean(env.IMAP_TLS, true),
    imapRejectUnauthorized: parseBoolean(env.IMAP_REJECT_UNAUTHORIZED, true),
    smtpHost: env.SMTP_HOST || '',
    smtpPort: parsePort(env.SMTP_PORT, 587),
    smtpSecure: parseBoolean(env.SMTP_SECURE, false),
    smtpRejectUnauthorized: parseBoolean(env.SMTP_REJECT_UNAUTHORIZED, true),
    smtpFrom: env.SMTP_FROM || env.SMTP_USER || email,
    mailbox: env.IMAP_MAILBOX || 'INBOX',
    requireSendConfirmation: parseBoolean(env.EMAIL_REQUIRE_SEND_CONFIRMATION, true),
  };
}

function normalizeAccount(raw, index) {
  const email = String(raw.email || raw.IMAP_USER || raw.SMTP_USER || '').trim();
  const id = slugifyAccountId(raw.id || email, `account-${index + 1}`);
  return {
    id,
    name: String(raw.name || (email ? email.split('@')[0] : id)).trim(),
    enabled: raw.enabled !== false,
    provider: String(raw.provider || '').trim(),
    email,
    password: String(raw.password || raw.IMAP_PASS || raw.SMTP_PASS || ''),
    imapHost: String(raw.imapHost || raw.IMAP_HOST || ''),
    imapPort: parsePort(raw.imapPort ?? raw.IMAP_PORT, 993),
    imapTls: parseBoolean(raw.imapTls ?? raw.IMAP_TLS, true),
    imapRejectUnauthorized: parseBoolean(
      raw.imapRejectUnauthorized ?? raw.IMAP_REJECT_UNAUTHORIZED,
      true,
    ),
    smtpHost: String(raw.smtpHost || raw.SMTP_HOST || ''),
    smtpPort: parsePort(raw.smtpPort ?? raw.SMTP_PORT, 587),
    smtpSecure: parseBoolean(raw.smtpSecure ?? raw.SMTP_SECURE, false),
    smtpRejectUnauthorized: parseBoolean(
      raw.smtpRejectUnauthorized ?? raw.SMTP_REJECT_UNAUTHORIZED,
      true,
    ),
    smtpFrom: String(raw.smtpFrom || raw.SMTP_FROM || raw.SMTP_USER || email),
    mailbox: String(raw.mailbox || raw.IMAP_MAILBOX || 'INBOX'),
    requireSendConfirmation: parseBoolean(raw.requireSendConfirmation, true),
  };
}

function normalizeAccounts(rawAccounts) {
  const usedIds = new Set();
  return rawAccounts.map((account, index) => {
    const normalized = normalizeAccount(account, index);
    const baseId = normalized.id;
    let nextId = baseId;
    let suffix = 2;
    while (usedIds.has(nextId)) {
      nextId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(nextId);
    return { ...normalized, id: nextId };
  });
}

function loadAccountsConfig() {
  if (process.env.EMAIL_CONFIG_MODE === 'env') {
    const env = loadLegacyEnv();
    return {
      version: 1,
      defaultAccountId: 'default',
      accounts: hasLegacyEnv(env) ? [legacyEnvToAccount(env)] : [],
      source: 'env',
    };
  }

  if (fs.existsSync(ACCOUNTS_PATH)) {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
    const accounts = Array.isArray(parsed.accounts)
      ? normalizeAccounts(parsed.accounts)
      : [];
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      defaultAccountId: String(parsed.defaultAccountId || accounts[0]?.id || ''),
      accounts,
      source: 'accounts',
    };
  }

  const env = loadLegacyEnv();
  return {
    version: 1,
    defaultAccountId: 'default',
    accounts: hasLegacyEnv(env) ? [legacyEnvToAccount(env)] : [],
    source: 'legacy-env',
  };
}

function listEnabledAccounts(config) {
  return config.accounts.filter(account => account.enabled);
}

function resolveAccount(config, accountId) {
  const enabledAccounts = listEnabledAccounts(config);
  if (enabledAccounts.length === 0) {
    throw new Error('No enabled email accounts configured');
  }

  const defaultAccount = config.accounts.find(item => item.id === config.defaultAccountId);
  const targetId = accountId || (defaultAccount?.enabled ? defaultAccount.id : enabledAccounts[0].id);
  const account = config.accounts.find(item => item.id === targetId);
  if (!account) {
    throw new Error(
      `Email account "${targetId}" not found. Available accounts: ${config.accounts.map(item => item.id).join(', ') || '(none)'}`,
    );
  }
  if (!account.enabled) {
    throw new Error(`Email account "${targetId}" is disabled`);
  }
  return account;
}

function getTargetAccounts(options) {
  const config = loadAccountsConfig();
  if (options['all-accounts']) {
    const accounts = listEnabledAccounts(config);
    if (accounts.length === 0) {
      throw new Error('No enabled email accounts configured');
    }
    return { config, accounts, allAccounts: true };
  }
  return { config, accounts: [resolveAccount(config, options.account)], allAccounts: false };
}

function createImapConfig(account) {
  const config = {
    user: account.email,
    password: account.password,
    host: account.imapHost || '127.0.0.1',
    port: account.imapPort || 1143,
    tls: account.imapTls === true,
    tlsOptions: {
      rejectUnauthorized: account.imapRejectUnauthorized !== false,
    },
    connTimeout: 10000,
    authTimeout: 10000,
  };

  if (!config.user || !config.password) {
    throw new Error(`Missing IMAP credentials for account "${account.id}"`);
  }

  return config;
}

function createSmtpConfig(account) {
  const config = {
    host: account.smtpHost,
    port: account.smtpPort || 587,
    secure: account.smtpSecure === true,
    auth: {
      user: account.email,
      pass: account.password,
    },
    tls: {
      rejectUnauthorized: account.smtpRejectUnauthorized !== false,
    },
  };

  if (!config.host || !config.auth.user || !config.auth.pass) {
    throw new Error(`Missing SMTP configuration for account "${account.id}"`);
  }

  return config;
}

function redactAccount(account) {
  return {
    id: account.id,
    name: redactEmail(account.name),
    enabled: account.enabled,
    email: redactEmail(account.email),
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    hasPassword: Boolean(account.password),
  };
}

function listAccountsConfig() {
  const config = loadAccountsConfig();
  const enabledAccounts = listEnabledAccounts(config);
  const defaultAccount = config.accounts.find(item => item.id === config.defaultAccountId);
  const effectiveDefault = defaultAccount?.enabled ? defaultAccount : enabledAccounts[0];
  return {
    success: true,
    source: config.source,
    defaultAccountId: effectiveDefault?.id || '',
    accounts: config.accounts.map(account => ({
      ...redactAccount(account),
      isDefault: account.id === effectiveDefault?.id,
      hasImapConfig: Boolean(account.email && account.password && account.imapHost),
      hasSmtpConfig: Boolean(account.email && account.password && account.smtpHost),
      mailbox: account.mailbox,
      requireSendConfirmation: account.requireSendConfirmation !== false,
    })),
  };
}

function withAccountResult(account, result) {
  return {
    accountId: account.id,
    accountName: redactEmail(account.name),
    email: redactEmail(account.email),
    ...result,
  };
}

module.exports = {
  ACCOUNTS_PATH,
  ENV_PATH,
  createImapConfig,
  createSmtpConfig,
  getTargetAccounts,
  legacyEnvToAccount,
  listAccountsConfig,
  loadAccountsConfig,
  normalizeAccount,
  normalizeAccounts,
  redactAccount,
  redactEmail,
  resolveAccount,
  slugifyAccountId,
  withAccountResult,
};
