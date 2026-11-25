import { describe, expect, test } from 'vitest';

import type { EmailSkillAccountConfig, EmailSkillAccountsConfig } from '../../services/skill';
import {
  applyProviderPresetToDraft,
  commitEmailAccountDraft,
  createDraftEmailAccount,
  detectKnownEmailDomainPreset,
  EmailProviderId,
  isEmailAccountConfigured,
  isLikelyValidEmailDomain,
  nextEmailAccountId,
  normalizeEmailAccountsConfig,
  removeEmailAccount,
  toggleEmailAccountEnabled,
} from './emailSkillConfigHelpers';

const makeAccount = (overrides: Partial<EmailSkillAccountConfig> = {}): EmailSkillAccountConfig => ({
  ...createDraftEmailAccount('account-1'),
  name: 'Work Mail',
  email: 'alice@163.com',
  password: 'auth-code',
  provider: EmailProviderId.Netease163,
  imapHost: 'imap.163.com',
  imapPort: 993,
  imapTls: true,
  smtpHost: 'smtp.163.com',
  smtpPort: 465,
  smtpSecure: true,
  smtpFrom: 'alice@163.com',
  enabled: true,
  ...overrides,
});

describe('emailSkillConfigHelpers', () => {
  test('detectKnownEmailDomainPreset matches standard and variant providers', () => {
    const netease = detectKnownEmailDomainPreset('Alice@163.com');
    expect(netease?.provider).toBe(EmailProviderId.Netease163);
    expect(netease?.imapHost).toBe('imap.163.com');
    expect(netease?.smtpPort).toBe(465);
    expect(netease?.smtpSecure).toBe(true);

    const foxmail = detectKnownEmailDomainPreset('bob@foxmail.com');
    expect(foxmail?.provider).toBe(EmailProviderId.QQ);
    expect(foxmail?.imapHost).toBe('imap.qq.com');

    const hotmail = detectKnownEmailDomainPreset('carol@hotmail.com');
    expect(hotmail?.provider).toBe(EmailProviderId.Outlook);
    expect(hotmail?.imapHost).toBe('outlook.office365.com');

    const vip163 = detectKnownEmailDomainPreset('dave@vip.163.com');
    expect(vip163?.provider).toBe(EmailProviderId.Custom);
    expect(vip163?.imapHost).toBe('imap.vip.163.com');
    expect(vip163?.smtpHost).toBe('smtp.vip.163.com');
    expect(vip163?.smtpPort).toBe(465);

    expect(detectKnownEmailDomainPreset('typing@163.co')).toBeNull();
    expect(detectKnownEmailDomainPreset('corp@acme-inc.com')).toBeNull();
  });

  test('isLikelyValidEmailDomain validates complete domains only', () => {
    expect(isLikelyValidEmailDomain('acme.com')).toBe(true);
    expect(isLikelyValidEmailDomain('mail.acme.co.jp')).toBe(true);
    expect(isLikelyValidEmailDomain('acme.c')).toBe(false);
    expect(isLikelyValidEmailDomain('localhost')).toBe(false);
  });

  test('isEmailAccountConfigured requires email, password, imapHost, and smtpHost', () => {
    expect(isEmailAccountConfigured(makeAccount())).toBe(true);
    expect(isEmailAccountConfigured(makeAccount({ email: '  ' }))).toBe(false);
    expect(isEmailAccountConfigured(makeAccount({ password: '' }))).toBe(false);
    expect(isEmailAccountConfigured(makeAccount({ imapHost: '' }))).toBe(false);
    expect(isEmailAccountConfigured(makeAccount({ smtpHost: '' }))).toBe(false);
  });

  test('commitEmailAccountDraft adds and enables a new account without leaving empty drafts', () => {
    const emptyConfig: EmailSkillAccountsConfig = {
      version: 1,
      defaultAccountId: '',
      accounts: [],
    };
    const draft = applyProviderPresetToDraft(createDraftEmailAccount('account-1'), EmailProviderId.Gmail);
    draft.email = '  user@gmail.com ';
    draft.password = 'app-password';

    const next = commitEmailAccountDraft(emptyConfig, draft, {
      isNew: true,
      makeDefault: true,
      fallbackName: 'Gmail',
    });

    expect(next.accounts).toHaveLength(1);
    expect(next.defaultAccountId).toBe('account-1');
    expect(next.accounts[0]).toMatchObject({
      id: 'account-1',
      name: 'Gmail',
      email: 'user@gmail.com',
      smtpFrom: 'user@gmail.com',
      enabled: true,
      imapHost: 'imap.gmail.com',
      smtpHost: 'smtp.gmail.com',
    });
  });

  test('commitEmailAccountDraft switches default account and preserves custom smtpFrom', () => {
    const first = makeAccount({ id: 'account-1', email: 'first@163.com', smtpFrom: 'first@163.com' });
    const second = makeAccount({ id: 'account-2', email: 'second@gmail.com', smtpFrom: 'alias@company.com' });
    const config: EmailSkillAccountsConfig = {
      version: 1,
      defaultAccountId: 'account-1',
      accounts: [first, second],
    };

    const updatedSecond: EmailSkillAccountConfig = {
      ...second,
      email: 'renamed@gmail.com',
    };
    const next = commitEmailAccountDraft(config, updatedSecond, {
      isNew: false,
      makeDefault: true,
      previousEmail: second.email,
    });

    expect(next.defaultAccountId).toBe('account-2');
    expect(next.accounts[1].smtpFrom).toBe('alias@company.com');
  });

  test('toggleEmailAccountEnabled refuses enabling incomplete accounts and reassigns default when disabling', () => {
    const complete = makeAccount({ id: 'account-1', enabled: true });
    const completeTwo = makeAccount({ id: 'account-2', enabled: true, email: 'two@163.com' });
    const incomplete = createDraftEmailAccount('account-3');
    incomplete.enabled = false;

    const config: EmailSkillAccountsConfig = {
      version: 1,
      defaultAccountId: 'account-1',
      accounts: [complete, completeTwo, incomplete],
    };

    expect(toggleEmailAccountEnabled(config, 'account-3')).toBeNull();

    const afterDisable = toggleEmailAccountEnabled(config, 'account-1');
    expect(afterDisable).not.toBeNull();
    expect(afterDisable?.accounts[0].enabled).toBe(false);
    expect(afterDisable?.defaultAccountId).toBe('account-2');
  });

  test('removeEmailAccount deletes account and updates defaultAccountId', () => {
    const config = normalizeEmailAccountsConfig({
      version: 1,
      defaultAccountId: 'account-1',
      accounts: [
        makeAccount({ id: 'account-1', enabled: true }),
        makeAccount({ id: 'account-2', enabled: true, email: 'two@163.com' }),
      ],
    });

    const next = removeEmailAccount(config, 'account-1');
    expect(next.accounts.map(a => a.id)).toEqual(['account-2']);
    expect(next.defaultAccountId).toBe('account-2');
    expect(nextEmailAccountId(next.accounts)).toBe('account-3');
  });
});
