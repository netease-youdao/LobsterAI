import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root, isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));

import { KitStoreKey } from '../../shared/kit/constants';
import { CoreSkillId, EMAIL_SKILL_CONFIG_DIR_NAME } from '../../shared/skills/constants';
import { SkinPackKitId } from '../../shared/skin/kit';
import type { SqliteStore } from '../sqliteStore';
import { RETIRED_BUNDLED_SKILL_IDS, RetiredBundledSkillId } from './retiredBundledSkills';
import { SkillManager } from './skillManager';

let manager: SkillManager;
let userRoot: string;
let bundledRoot: string;
let emailConfigDir: string;
let kvStore: Map<string, unknown>;
let saveState: ReturnType<typeof vi.fn>;

const writeSkill = (
  root: string,
  id: string,
  extraFrontmatter = '',
): string => {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = [
    `name: ${id}`,
    'description: test skill',
    ...(extraFrontmatter ? [extraFrontmatter.trim()] : []),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n# ${id}\n`);
  return dir;
};

const writeConfig = (root: string, defaults: Record<string, unknown>, version = 2): void => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'skills.config.json'), JSON.stringify({ version, description: 'Keep this', defaults }));
};

const readConfig = () => JSON.parse(fs.readFileSync(path.join(userRoot, 'skills.config.json'), 'utf8'));

beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-skill-bundled-sync-'));
  userRoot = path.join(fixture.root, 'SKILLs');
  bundledRoot = path.join(fixture.root, 'app', 'SKILLs');
  emailConfigDir = path.join(fixture.root, EMAIL_SKILL_CONFIG_DIR_NAME);
  kvStore = new Map<string, unknown>();
  saveState = vi.fn((key: string, value: unknown) => {
    kvStore.set(key, structuredClone(value));
  });
  const store = {
    get: (key: string) => structuredClone(kvStore.get(key)),
    set: saveState,
  } as unknown as SqliteStore;
  manager = new SkillManager(() => store);
  vi.spyOn(manager, 'getBundledSkillsRoot').mockReturnValue(bundledRoot);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (!path.resolve(fixture.root).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    throw new Error('Refusing to remove a non-fixture directory');
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('the shipped bundle contains only the 9 always-enabled core skills and no retired or migrated vertical skills', () => {
  const root = path.resolve(__dirname, '../../../SKILLs');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'skills.config.json'), 'utf8'));
  const expectedCoreIds = Object.values(CoreSkillId).sort();
  expect(Object.keys(config.defaults).sort()).toEqual(expectedCoreIds);

  for (const id of expectedCoreIds) {
    expect(config.defaults[id]).toMatchObject({ enabled: true, alwaysEnabled: true });
    expect(fs.existsSync(path.join(root, id, 'SKILL.md'))).toBe(true);
  }
  for (const id of RETIRED_BUNDLED_SKILL_IDS) {
    expect(config.defaults).not.toHaveProperty(id);
    expect(fs.existsSync(path.join(root, id, 'SKILL.md'))).toBe(false);
  }
  // Migrated vertical skills and skin-creator must no longer live in SKILLs/
  for (const movedId of ['article-writer', 'weather', 'remotion', 'skin-creator']) {
    expect(config.defaults).not.toHaveProperty(movedId);
    expect(fs.existsSync(path.join(root, movedId, 'SKILL.md'))).toBe(false);
  }
});

test('a fresh install loads bundled core skills read-only without copying them into userData/SKILLs', () => {
  writeSkill(bundledRoot, 'docx');
  writeSkill(bundledRoot, 'skill-creator', 'disable-model-invocation: true');
  writeSkill(bundledRoot, 'lobsterai-image-processing', 'user-invocable: false');
  for (const id of RETIRED_BUNDLED_SKILL_IDS) writeSkill(bundledRoot, id);
  writeConfig(bundledRoot, {
    docx: { enabled: true, order: 1, alwaysEnabled: true },
    'skill-creator': { enabled: true, order: 2, alwaysEnabled: true },
    'lobsterai-image-processing': { enabled: true, order: 3, alwaysEnabled: true },
  });

  manager.syncBundledSkillsToUserData();

  const skills = manager.listSkills();
  expect(skills.map((s) => s.id)).toEqual(['docx', 'skill-creator', 'lobsterai-image-processing']);
  expect(skills.every((s) => s.isBuiltIn && s.enabled && s.canDisable === false)).toBe(true);
  expect(skills.find((s) => s.id === 'docx')?.skillPath).toBe(path.join(bundledRoot, 'docx', 'SKILL.md'));
  expect(skills.find((s) => s.id === 'skill-creator')?.modelInvocable).toBe(false);
  expect(skills.find((s) => s.id === 'skill-creator')?.userInvocable).toBe(true);
  expect(skills.find((s) => s.id === 'lobsterai-image-processing')?.modelInvocable).toBe(true);
  expect(skills.find((s) => s.id === 'lobsterai-image-processing')?.userInvocable).toBe(false);

  // Bundled core skills are NOT copied into userRoot
  expect(fs.existsSync(path.join(userRoot, 'docx'))).toBe(false);
  for (const id of RETIRED_BUNDLED_SKILL_IDS) {
    expect(fs.existsSync(path.join(userRoot, id))).toBe(false);
    expect(manager.buildAutoRoutingPrompt()).not.toContain(id);
  }
  expect(saveState).not.toHaveBeenCalled();
});

test('a skill dropped from the bundle without retirement stays installed as a toggleable/deletable user skill', async () => {
  // An older app version bundled "article-writer" and copied it into user data.
  writeSkill(userRoot, 'article-writer');
  writeSkill(bundledRoot, 'docx');
  writeConfig(bundledRoot, { docx: { enabled: true, order: 1, alwaysEnabled: true } });
  writeConfig(userRoot, { 'article-writer': { enabled: true, order: 50 }, docx: { enabled: true, order: 1 } });
  kvStore.set('skills_state', { 'article-writer': { enabled: false } });

  // The copy must survive every launch, not only the first one after the upgrade.
  for (let launch = 0; launch < 2; launch += 1) {
    manager.syncBundledSkillsToUserData();
    manager.recoverInterruptedUpgrades();
  }

  expect(manager.listSkills().map((skill) => [skill.id, skill.isBuiltIn, skill.canDisable, skill.enabled])).toEqual([
    ['docx', true, false, true],
    ['article-writer', false, true, false],
  ]);
  expect(readConfig().defaults).toHaveProperty('article-writer');

  // Deleting restarts the directory watcher, whose handles would outlive the fixture.
  vi.spyOn(manager, 'startWatching').mockImplementation(() => {});
  await expect(manager.deleteSkill('docx')).rejects.toThrow('Built-in skills cannot be deleted');
  expect((await manager.deleteSkill('article-writer')).map((skill) => skill.id)).toEqual(['docx']);
  expect(fs.existsSync(path.join(userRoot, 'article-writer'))).toBe(false);
});

test('always-enabled core skills heal stale disabled state on startup and reject disable calls', () => {
  writeSkill(bundledRoot, 'docx');
  writeSkill(userRoot, 'docx'); // Stale copy from older version
  writeSkill(userRoot, 'custom-skill');
  writeConfig(bundledRoot, { docx: { enabled: true, order: 1, alwaysEnabled: true } });
  kvStore.set('skills_state', {
    docx: { enabled: false },
    'custom-skill': { enabled: true },
  });

  manager.syncBundledSkillsToUserData();

  // Stale user copy of core skill is cleaned up and stale disabled state is removed.
  expect(fs.existsSync(path.join(userRoot, 'docx'))).toBe(false);
  expect(manager.isSkillEnabled('docx')).toBe(true);
  expect(kvStore.get('skills_state')).toEqual({
    'custom-skill': { enabled: true },
  });

  // Direct disable throws
  expect(() => manager.setSkillEnabled('docx', false)).toThrow('Built-in skills cannot be disabled');

  // Batch disable skips always-enabled core skills while disabling user skills
  manager.setSkillsEnabledBatch(['docx', 'custom-skill'], false);
  expect(manager.isSkillEnabled('docx')).toBe(true);
  expect(manager.isSkillEnabled('custom-skill')).toBe(false);
});

test('upgrades remove retired copies, defaults and state while preserving other skills and preferences', () => {
  const retiredDefaults = Object.fromEntries([...RETIRED_BUNDLED_SKILL_IDS].map((id) => [id, { enabled: true, order: 222 }]));
  for (const id of RETIRED_BUNDLED_SKILL_IDS) writeSkill(userRoot, id);
  writeSkill(userRoot, 'custom-skill');
  writeSkill(bundledRoot, 'docx');
  writeConfig(bundledRoot, { docx: { enabled: true, order: 210, alwaysEnabled: true } });
  writeConfig(userRoot, { ...retiredDefaults, 'custom-skill': { order: 1 } });
  kvStore.set('skills_state', { ...retiredDefaults, 'custom-skill': { enabled: true } });

  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();

  expect(manager.listSkills().map((skill) => skill.id)).toEqual(['custom-skill', 'docx']);
  expect(kvStore.get('skills_state')).toEqual({ 'custom-skill': { enabled: true } });
  expect(readConfig()).toEqual({
    version: 2,
    description: 'Keep this',
    defaults: { 'custom-skill': { order: 1 } },
  });
  for (const id of RETIRED_BUNDLED_SKILL_IDS) expect(fs.existsSync(path.join(userRoot, id))).toBe(false);
});

test('cleanup runs with a missing bundle and prevents interrupted upgrades from restoring retired skills', () => {
  for (const id of RETIRED_BUNDLED_SKILL_IDS) writeSkill(userRoot, `${id}.upgrading`);
  writeSkill(userRoot, RetiredBundledSkillId.FilmsSearch);
  writeSkill(userRoot, 'custom-skill.upgrading');
  kvStore.set('skills_state', [
    { id: RetiredBundledSkillId.FilmsSearch, enabled: true },
    { id: RetiredBundledSkillId.MusicSearch, enabled: false },
    { id: 'custom-skill', enabled: false },
  ]);

  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();

  expect(manager.listSkills().map((skill) => skill.id)).toEqual(['custom-skill']);
  expect(kvStore.get('skills_state')).toEqual({ 'custom-skill': { enabled: false } });
  for (const id of RETIRED_BUNDLED_SKILL_IDS) {
    expect(fs.existsSync(path.join(userRoot, id))).toBe(false);
    expect(fs.existsSync(path.join(userRoot, `${id}.upgrading`))).toBe(false);
  }
  expect(fs.existsSync(path.join(userRoot, 'custom-skill', 'SKILL.md'))).toBe(true);
});

test('a malformed user config does not block directory and state cleanup or reading bundled skills', () => {
  for (const id of RETIRED_BUNDLED_SKILL_IDS) writeSkill(userRoot, id);
  const configPath = path.join(userRoot, 'skills.config.json');
  fs.writeFileSync(configPath, '{broken');
  kvStore.set('skills_state', { [RetiredBundledSkillId.MusicSearch]: { enabled: false } });
  writeSkill(bundledRoot, 'docx');
  writeConfig(bundledRoot, { docx: { enabled: true, order: 1, alwaysEnabled: true } });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  manager.syncBundledSkillsToUserData();

  expect(error).toHaveBeenCalled();
  expect(fs.readFileSync(configPath, 'utf8')).toBe('{broken');
  expect(kvStore.get('skills_state')).toEqual({});
  expect(manager.listSkills().map((s) => s.id)).toEqual(['docx']);
  for (const id of RETIRED_BUNDLED_SKILL_IDS) expect(fs.existsSync(path.join(userRoot, id))).toBe(false);
});

test('a locked retired backup is not restored and cleanup retries on the next startup', () => {
  const backup = path.join(userRoot, `${RetiredBundledSkillId.FilmsSearch}.upgrading`);
  writeSkill(userRoot, path.basename(backup));
  writeSkill(userRoot, RetiredBundledSkillId.MusicSearch);
  const remove = fs.rmSync.bind(fs);
  const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (target === backup) throw Object.assign(new Error('File is busy'), { code: 'EBUSY' });
    remove(target, options);
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();

  expect(error).toHaveBeenCalled();
  expect(fs.existsSync(path.join(userRoot, RetiredBundledSkillId.FilmsSearch))).toBe(false);
  expect(fs.existsSync(path.join(userRoot, RetiredBundledSkillId.MusicSearch))).toBe(false);
  expect(fs.existsSync(backup)).toBe(true);

  rmSpy.mockRestore();
  manager.syncBundledSkillsToUserData();
  manager.recoverInterruptedUpgrades();
  expect(fs.existsSync(backup)).toBe(false);
});

test('migrates legacy imap-smtp-email accounts.json and .env to userData/email-skill before cleaning stale copy', () => {
  const userDir = writeSkill(userRoot, 'imap-smtp-email');
  const savedAccounts = JSON.stringify({
    version: 1,
    defaultAccountId: 'work',
    accounts: [
      {
        id: 'work',
        name: 'Work Mail',
        enabled: true,
        provider: '163',
        email: 'alice@163.com',
        password: 'auth-code-123',
        imapHost: 'imap.163.com',
        imapPort: 993,
        imapTls: true,
        imapRejectUnauthorized: true,
        smtpHost: 'smtp.163.com',
        smtpPort: 465,
        smtpSecure: true,
        smtpRejectUnauthorized: true,
        smtpFrom: 'alice@163.com',
        mailbox: 'INBOX',
        requireSendConfirmation: true,
      },
    ],
  }, null, 2) + '\n';
  fs.writeFileSync(path.join(userDir, 'accounts.json'), savedAccounts, 'utf8');
  fs.writeFileSync(path.join(userDir, '.env'), 'IMAP_USER=legacy@163.com\nIMAP_PASS=legacy-pass\n', 'utf8');
  writeSkill(bundledRoot, 'imap-smtp-email');
  writeConfig(bundledRoot, { 'imap-smtp-email': { enabled: true, order: 211, alwaysEnabled: true } });

  manager.syncBundledSkillsToUserData();

  // Credentials migrated cleanly to <userData>/email-skill/
  expect(fs.readFileSync(path.join(emailConfigDir, 'accounts.json'), 'utf8')).toBe(savedAccounts);
  expect(fs.readFileSync(path.join(emailConfigDir, '.env'), 'utf8')).toBe(
    'IMAP_USER=legacy@163.com\nIMAP_PASS=legacy-pass\n',
  );
  // Stale user copy of core skill was cleaned up only AFTER verified migration
  expect(fs.existsSync(userDir)).toBe(false);
  expect(manager.hasEnabledEmailAccount()).toBe(true);
});

test('aborts stale imap-smtp-email directory cleanup if credential migration fails', () => {
  const userDir = writeSkill(userRoot, 'imap-smtp-email');
  fs.writeFileSync(path.join(userDir, 'accounts.json'), '{"version":1,"accounts":[]}', 'utf8');
  writeSkill(bundledRoot, 'imap-smtp-email');
  writeConfig(bundledRoot, { 'imap-smtp-email': { enabled: true, order: 211, alwaysEnabled: true } });

  // Block creating email-skill directory by placing a regular file at that path
  fs.writeFileSync(emailConfigDir, 'blocking-file', 'utf8');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  manager.syncBundledSkillsToUserData();

  expect(warn).toHaveBeenCalled();
  // Legacy user directory and accounts.json MUST remain untouched on migration failure
  expect(fs.existsSync(path.join(userDir, 'accounts.json'))).toBe(true);
});

test('SkillManager persists and reads email accounts.json under userData/email-skill and falls back to legacy .env', () => {
  writeSkill(bundledRoot, 'imap-smtp-email');
  writeConfig(bundledRoot, { 'imap-smtp-email': { enabled: true, order: 211, alwaysEnabled: true } });
  fs.mkdirSync(emailConfigDir, { recursive: true });

  // Initially no enabled email account
  expect(manager.hasEnabledEmailAccount()).toBe(false);

  // Legacy .env fallback when accounts.json does not exist yet
  fs.writeFileSync(
    path.join(emailConfigDir, '.env'),
    [
      'IMAP_HOST=imap.163.com',
      'IMAP_PORT=993',
      'IMAP_USER=legacy@163.com',
      'IMAP_PASS=legacy-secret',
      'SMTP_HOST=smtp.163.com',
      'SMTP_PORT=465',
      'SMTP_SECURE=true',
    ].join('\n') + '\n',
    'utf8',
  );
  expect(manager.hasEnabledEmailAccount()).toBe(true);

  const migrated = manager.getEmailAccountsConfig('imap-smtp-email');
  expect(migrated.success).toBe(true);
  expect(migrated.config?.defaultAccountId).toBe('default');
  expect(migrated.config?.accounts).toHaveLength(1);
  expect(migrated.config?.accounts[0]).toMatchObject({
    id: 'default',
    enabled: true,
    email: 'legacy@163.com',
    password: 'legacy-secret',
    imapHost: 'imap.163.com',
    imapPort: 993,
    smtpHost: 'smtp.163.com',
    smtpPort: 465,
    smtpSecure: true,
  });

  // Saving multi-account config writes accounts.json under <userData>/email-skill and reloads cleanly
  const saveResult = manager.setEmailAccountsConfig('imap-smtp-email', {
    version: 1,
    defaultAccountId: 'personal',
    accounts: [
      {
        id: 'work',
        name: 'Work',
        enabled: false,
        provider: 'gmail',
        email: 'work@gmail.com',
        password: 'pw-1',
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        smtpHost: 'smtp.gmail.com',
        smtpPort: 587,
      },
      {
        id: 'personal',
        name: 'Personal',
        enabled: true,
        provider: '163',
        email: 'alice@163.com',
        password: 'pw-2',
        imapHost: 'imap.163.com',
        imapPort: 993,
        smtpHost: 'smtp.163.com',
        smtpPort: 465,
        smtpSecure: true,
      },
    ],
  });
  expect(saveResult).toEqual({ success: true });
  expect(fs.existsSync(path.join(emailConfigDir, 'accounts.json'))).toBe(true);
  expect(manager.hasEnabledEmailAccount()).toBe(true);

  const reloaded = manager.getEmailAccountsConfig('imap-smtp-email');
  expect(reloaded.success).toBe(true);
  expect(reloaded.config?.defaultAccountId).toBe('personal');
  expect(reloaded.config?.accounts.map((a) => ({ id: a.id, email: a.email, enabled: a.enabled }))).toEqual([
    { id: 'work', email: 'work@gmail.com', enabled: false },
    { id: 'personal', email: 'alice@163.com', enabled: true },
  ]);
});

test('importing a skill with a reserved core built-in ID auto-suffixes without shadowing built-in', async () => {
  writeSkill(bundledRoot, 'docx');
  writeConfig(bundledRoot, { docx: { enabled: true, order: 1, alwaysEnabled: true } });
  const localSource = writeSkill(path.join(fixture.root, 'external'), 'docx');
  vi.spyOn(manager, 'startWatching').mockImplementation(() => {});

  const result = await manager.downloadSkill(localSource, undefined, { skipSecurityScan: true });
  expect(result.success).toBe(true);
  expect(manager.listSkills().map((s) => [s.id, s.isBuiltIn])).toEqual([
    ['docx', true],
    ['docx-1', false],
  ]);
});

test('hides skin-creator from listSkills unless ai-skin-designer Kit is installed', () => {
  writeSkill(bundledRoot, 'docx');
  writeConfig(bundledRoot, { docx: { enabled: true, order: 1, alwaysEnabled: true } });
  writeSkill(userRoot, 'skin-creator');

  expect(manager.listSkills().map((s) => s.id)).toEqual(['docx']);

  kvStore.set(KitStoreKey.Installed, {
    [SkinPackKitId.BuiltIn]: { id: SkinPackKitId.BuiltIn, installedAt: Date.now() },
  });
  expect(manager.listSkills().map((s) => s.id)).toEqual(['docx', 'skin-creator']);
});
