import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const configModulePath = path.resolve('SKILLs/imap-smtp-email/scripts/config.js');
const require = createRequire(import.meta.url);
const emailEnvKeys = [
  'EMAIL_ACCOUNTS_PATH',
  'EMAIL_ENV_PATH',
  'EMAIL_CONFIG_MODE',
  'EMAIL_REQUIRE_SEND_CONFIRMATION',
  'IMAP_HOST',
  'IMAP_PORT',
  'IMAP_USER',
  'IMAP_PASS',
  'IMAP_TLS',
  'IMAP_REJECT_UNAUTHORIZED',
  'IMAP_MAILBOX',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_SECURE',
  'SMTP_FROM',
  'SMTP_REJECT_UNAUTHORIZED',
];

async function loadConfigModule(tempDir, env = {}) {
  const previousEnv = Object.fromEntries(emailEnvKeys.map(key => [key, process.env[key]]));

  process.env.EMAIL_ACCOUNTS_PATH = path.join(tempDir, 'accounts.json');
  process.env.EMAIL_ENV_PATH = path.join(tempDir, '.env');
  emailEnvKeys.forEach(key => {
    if (key !== 'EMAIL_ACCOUNTS_PATH' && key !== 'EMAIL_ENV_PATH') {
      delete process.env[key];
    }
  });
  Object.assign(process.env, env);

  delete require.cache[configModulePath];
  const module = require(configModulePath);

  return {
    module,
    restore() {
      Object.entries(previousEnv).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
      delete require.cache[configModulePath];
    },
  };
}

function withTempDir(fn) {
  return async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-email-config-'));
    try {
      await fn(tempDir);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test('loads accounts.json and lists redacted account metadata', withTempDir(async tempDir => {
  fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    defaultAccountId: 'disabled-default',
    accounts: [
      {
        id: 'disabled-default',
        name: 'Disabled',
        enabled: false,
        email: 'disabled@example.com',
        password: 'secret-disabled',
        imapHost: 'imap.example.com',
        smtpHost: 'smtp.example.com',
      },
      {
        id: 'work',
        name: 'Work',
        enabled: true,
        email: 'work@example.com',
        password: 'secret-work',
        imapHost: 'imap.work.example.com',
        smtpHost: 'smtp.work.example.com',
        requireSendConfirmation: false,
      },
    ],
  }));

  const { module, restore } = await loadConfigModule(tempDir);
  try {
    const listed = module.listAccountsConfig();
    assert.equal(listed.success, true);
    assert.equal(listed.source, 'accounts');
    assert.equal(listed.defaultAccountId, 'work');
    assert.equal(listed.accounts.length, 2);
    assert.equal(listed.accounts[1].id, 'work');
    assert.equal(listed.accounts[1].email, 'wo***@example.com');
    assert.equal(listed.accounts[1].hasPassword, true);
    assert.equal(listed.accounts[1].password, undefined);
    assert.equal(listed.accounts[1].isDefault, true);
    assert.equal(listed.accounts[1].hasImapConfig, true);
    assert.equal(listed.accounts[1].hasSmtpConfig, true);
    assert.equal(listed.accounts[1].requireSendConfirmation, false);
  } finally {
    restore();
  }
}));

test('redacts email-like account names in public metadata', withTempDir(async tempDir => {
  const { module, restore } = await loadConfigModule(tempDir);
  try {
    const account = {
      id: 'qq',
      name: 'zhangsan@example.com',
      enabled: true,
      email: 'zhangsan@example.com',
      password: 'secret',
      imapHost: 'imap.qq.com',
      imapPort: 993,
      smtpHost: 'smtp.qq.com',
      smtpPort: 587,
    };

    const listed = module.redactAccount(account);
    assert.equal(listed.name, 'zh***@example.com');
    assert.equal(listed.email, 'zh***@example.com');
    assert.equal(listed.password, undefined);

    const result = module.withAccountResult(account, { success: true });
    assert.equal(result.accountName, 'zh***@example.com');
    assert.equal(result.email, 'zh***@example.com');
  } finally {
    restore();
  }
}));

test('falls back to first enabled account when configured default is disabled', withTempDir(async tempDir => {
  fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    defaultAccountId: 'disabled',
    accounts: [
      {
        id: 'disabled',
        enabled: false,
        email: 'disabled@example.com',
        password: 'secret',
        imapHost: 'imap.disabled.example.com',
        smtpHost: 'smtp.disabled.example.com',
      },
      {
        id: 'enabled',
        enabled: true,
        email: 'enabled@example.com',
        password: 'secret',
        imapHost: 'imap.enabled.example.com',
        smtpHost: 'smtp.enabled.example.com',
      },
    ],
  }));

  const { module, restore } = await loadConfigModule(tempDir);
  try {
    const { accounts } = module.getTargetAccounts({});
    assert.equal(accounts[0].id, 'enabled');
  } finally {
    restore();
  }
}));

test('deduplicates repeated account ids while preserving account order', withTempDir(async tempDir => {
  fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    defaultAccountId: 'work',
    accounts: [
      {
        id: 'work',
        enabled: true,
        email: 'first@example.com',
        password: 'secret',
        imapHost: 'imap.first.example.com',
        smtpHost: 'smtp.first.example.com',
      },
      {
        id: 'work',
        enabled: true,
        email: 'second@example.com',
        password: 'secret',
        imapHost: 'imap.second.example.com',
        smtpHost: 'smtp.second.example.com',
      },
    ],
  }));

  const { module, restore } = await loadConfigModule(tempDir);
  try {
    const listed = module.listAccountsConfig();
    assert.deepEqual(listed.accounts.map(account => account.id), ['work', 'work-2']);
    assert.equal(listed.accounts[0].email, 'fi***@example.com');
    assert.equal(listed.accounts[1].email, 'se***@example.com');
    const config = module.loadAccountsConfig();
    assert.equal(config.accounts[0].email, 'first@example.com');
    assert.equal(config.accounts[1].email, 'second@example.com');
  } finally {
    restore();
  }
}));

test('preserves explicit disabled-account errors', withTempDir(async tempDir => {
  fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    defaultAccountId: 'enabled',
    accounts: [
      {
        id: 'disabled',
        enabled: false,
        email: 'disabled@example.com',
        password: 'secret',
        imapHost: 'imap.disabled.example.com',
        smtpHost: 'smtp.disabled.example.com',
      },
      {
        id: 'enabled',
        enabled: true,
        email: 'enabled@example.com',
        password: 'secret',
        imapHost: 'imap.enabled.example.com',
        smtpHost: 'smtp.enabled.example.com',
      },
    ],
  }));

  const { module, restore } = await loadConfigModule(tempDir);
  try {
    assert.throws(
      () => module.getTargetAccounts({ account: 'disabled' }),
      /Email account "disabled" is disabled/,
    );
  } finally {
    restore();
  }
}));

test('resolves configured recipient accounts by id without exposing full address in listings', withTempDir(async tempDir => {
  fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    defaultAccountId: 'sender',
    accounts: [
      {
        id: 'sender',
        enabled: true,
        email: 'sender@example.com',
        password: 'secret',
        imapHost: 'imap.sender.example.com',
        smtpHost: 'smtp.sender.example.com',
      },
      {
        id: 'recipient',
        enabled: true,
        email: 'recipient@example.com',
        password: 'secret',
        imapHost: 'imap.recipient.example.com',
        smtpHost: 'smtp.recipient.example.com',
      },
    ],
  }));

  const { module, restore } = await loadConfigModule(tempDir);
  try {
    const listed = module.listAccountsConfig();
    assert.equal(listed.accounts[1].email, 're***@example.com');

    const config = module.loadAccountsConfig();
    const recipient = module.resolveAccount(config, 'recipient');
    assert.equal(recipient.email, 'recipient@example.com');
  } finally {
    restore();
  }
}));

test('smtp CLI rejects redacted recipient addresses before sending', withTempDir(async tempDir => {
  fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    defaultAccountId: 'sender',
    accounts: [
      {
        id: 'sender',
        enabled: true,
        email: 'sender@example.com',
        password: 'secret',
        imapHost: 'imap.sender.example.com',
        smtpHost: 'smtp.sender.example.com',
      },
    ],
  }));

  const result = spawnSync(
    process.execPath,
    [
      'SKILLs/imap-smtp-email/scripts/smtp.js',
      'send',
      '--to',
      're***@example.com',
      '--subject',
      'test',
      '--body',
      'test',
      '--confirmed',
    ],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        EMAIL_ACCOUNTS_PATH: path.join(tempDir, 'accounts.json'),
        EMAIL_ENV_PATH: path.join(tempDir, '.env'),
      },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refusing to send to a redacted email address/);
}));

test('loads legacy .env when accounts.json is absent', withTempDir(async tempDir => {
  fs.writeFileSync(path.join(tempDir, '.env'), [
    'IMAP_HOST=imap.legacy.example.com',
    'IMAP_PORT=993',
    'IMAP_USER=legacy@example.com',
    'IMAP_PASS=legacy-secret',
    'SMTP_HOST=smtp.legacy.example.com',
    'SMTP_PORT=465',
    'SMTP_SECURE=true',
    'SMTP_FROM=Legacy Sender <legacy@example.com>',
    'EMAIL_REQUIRE_SEND_CONFIRMATION=false',
  ].join('\n'));

  const { module, restore } = await loadConfigModule(tempDir);
  try {
    const config = module.loadAccountsConfig();
    assert.equal(config.source, 'legacy-env');
    assert.equal(config.accounts.length, 1);
    assert.equal(config.accounts[0].id, 'default');
    assert.equal(config.accounts[0].email, 'legacy@example.com');
    assert.equal(config.accounts[0].smtpSecure, true);
    assert.equal(config.accounts[0].requireSendConfirmation, false);
  } finally {
    restore();
  }
}));

test('EMAIL_CONFIG_MODE=env overrides accounts.json for connectivity probes', withTempDir(async tempDir => {
  fs.writeFileSync(path.join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    defaultAccountId: 'json-account',
    accounts: [
      {
        id: 'json-account',
        email: 'json@example.com',
        password: 'json-secret',
        imapHost: 'imap.json.example.com',
        smtpHost: 'smtp.json.example.com',
      },
    ],
  }));

  const { module, restore } = await loadConfigModule(tempDir, {
    EMAIL_CONFIG_MODE: 'env',
    IMAP_USER: 'env@example.com',
    IMAP_HOST: 'imap.env.example.com',
    SMTP_HOST: 'smtp.env.example.com',
  });
  try {
    const config = module.loadAccountsConfig();
    assert.equal(config.source, 'env');
    assert.equal(config.accounts[0].email, 'env@example.com');
    assert.equal(config.accounts[0].imapHost, 'imap.env.example.com');
  } finally {
    restore();
  }
}));
