import { test, expect } from 'vitest';
import { getRulesForFile, ALL_SECURITY_RULES } from './skillSecurityRules';

function getRuleIds(relativePath: string) {
  return getRulesForFile(relativePath).map((r: { id: string }) => r.id);
}

// ---------------------------------------------------------------------------
// ALL_SECURITY_RULES sanity
// ---------------------------------------------------------------------------

test('ALL_SECURITY_RULES is a non-empty array', () => {
  expect(Array.isArray(ALL_SECURITY_RULES)).toBeTruthy();
  expect(ALL_SECURITY_RULES.length > 0).toBeTruthy();
});

test('every rule has required string fields: id, dimension, description', () => {
  for (const rule of ALL_SECURITY_RULES) {
    expect(typeof rule.id).toBe('string');
    expect(rule.id.length > 0).toBeTruthy();
    expect(typeof rule.dimension).toBe('string');
    expect(typeof rule.description).toBe('string');
  }
});

test('every rule has a non-empty filePatterns array', () => {
  for (const rule of ALL_SECURITY_RULES) {
    expect(Array.isArray(rule.filePatterns)).toBeTruthy();
    expect(rule.filePatterns.length > 0).toBeTruthy();
  }
});

test('every rule has a non-empty patterns array of RegExp objects', () => {
  for (const rule of ALL_SECURITY_RULES) {
    expect(Array.isArray(rule.patterns)).toBeTruthy();
    expect(rule.patterns.length > 0).toBeTruthy();
    for (const p of rule.patterns) {
      expect(p instanceof RegExp).toBeTruthy();
    }
  }
});

test('every rule severity is one of: info, warning, danger, critical', () => {
  const valid = new Set(['info', 'warning', 'danger', 'critical']);
  for (const rule of ALL_SECURITY_RULES) {
    expect(valid.has(rule.severity)).toBeTruthy();
  }
});

test('all rule ids are unique', () => {
  const ids = ALL_SECURITY_RULES.map((r: { id: string }) => r.id);
  const unique = new Set(ids);
  expect(unique.size).toBe(ids.length);
});

// ---------------------------------------------------------------------------
// Unknown / unsupported extensions
// ---------------------------------------------------------------------------

test('getRulesForFile: unknown extension returns empty array', () => {
  expect(getRulesForFile('script.xyz')).toEqual([]);
});

test('getRulesForFile: .md extension returns empty array', () => {
  expect(getRulesForFile('README.md')).toEqual([]);
});

test('getRulesForFile: no extension returns empty array', () => {
  expect(getRulesForFile('Makefile')).toEqual([]);
});

// ---------------------------------------------------------------------------
// .sh files
// ---------------------------------------------------------------------------

test('getRulesForFile: .sh includes file_access.ssh_keys', () => {
  expect(getRuleIds('deploy.sh').includes('file_access.ssh_keys')).toBeTruthy();
});

test('getRulesForFile: .sh includes dangerous_cmd.rm_rf', () => {
  expect(getRuleIds('cleanup.sh').includes('dangerous_cmd.rm_rf')).toBeTruthy();
});

test('getRulesForFile: .sh includes dangerous_cmd.sudo', () => {
  expect(getRuleIds('setup.sh').includes('dangerous_cmd.sudo')).toBeTruthy();
});

test('getRulesForFile: .sh includes dangerous_cmd.disk_format', () => {
  expect(getRuleIds('format.sh').includes('dangerous_cmd.disk_format')).toBeTruthy();
});

test('getRulesForFile: .sh includes network.data_exfil_curl', () => {
  expect(getRuleIds('upload.sh').includes('network.data_exfil_curl')).toBeTruthy();
});

test('getRulesForFile: .sh includes process.reverse_shell', () => {
  expect(getRuleIds('connect.sh').includes('process.reverse_shell')).toBeTruthy();
});

test('getRulesForFile: .sh includes process.background_daemon', () => {
  expect(getRuleIds('daemon.sh').includes('process.background_daemon')).toBeTruthy();
});

test('getRulesForFile: .sh includes screen_input.screenshot', () => {
  expect(getRuleIds('capture.sh').includes('screen_input.screenshot')).toBeTruthy();
});

test('getRulesForFile: .sh includes screen_input.clipboard', () => {
  expect(getRuleIds('paste.sh').includes('screen_input.clipboard')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// .bash files
// ---------------------------------------------------------------------------

test('getRulesForFile: .bash includes file_access.ssh_keys', () => {
  expect(getRuleIds('run.bash').includes('file_access.ssh_keys')).toBeTruthy();
});

test('getRulesForFile: .bash includes dangerous_cmd.sudo', () => {
  expect(getRuleIds('run.bash').includes('dangerous_cmd.sudo')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// .ts files
// ---------------------------------------------------------------------------

test('getRulesForFile: .ts includes file_access.ssh_keys', () => {
  expect(getRuleIds('src/utils.ts').includes('file_access.ssh_keys')).toBeTruthy();
});

test('getRulesForFile: .ts includes file_access.aws_credentials', () => {
  expect(getRuleIds('src/aws.ts').includes('file_access.aws_credentials')).toBeTruthy();
});

test('getRulesForFile: .ts includes network.data_exfil_fetch', () => {
  expect(getRuleIds('src/net.ts').includes('network.data_exfil_fetch')).toBeTruthy();
});

test('getRulesForFile: .ts includes network.webhook_exfil', () => {
  expect(getRuleIds('src/notify.ts').includes('network.webhook_exfil')).toBeTruthy();
});

test('getRulesForFile: .ts includes process.reverse_shell', () => {
  expect(getRuleIds('src/shell.ts').includes('process.reverse_shell')).toBeTruthy();
});

test('getRulesForFile: .ts includes process.crypto_miner', () => {
  expect(getRuleIds('src/miner.ts').includes('process.crypto_miner')).toBeTruthy();
});

test('getRulesForFile: .ts includes screen_input.keylogger', () => {
  expect(getRuleIds('src/keyboard.ts').includes('screen_input.keylogger')).toBeTruthy();
});

test('getRulesForFile: .ts includes payment.payment_api', () => {
  expect(getRuleIds('src/payment.ts').includes('payment.payment_api')).toBeTruthy();
});

test('getRulesForFile: .ts includes payment.crypto_wallet', () => {
  expect(getRuleIds('src/wallet.ts').includes('payment.crypto_wallet')).toBeTruthy();
});

test('getRulesForFile: .ts does not include dangerous_cmd.sudo (sh only)', () => {
  expect(getRuleIds('src/admin.ts').includes('dangerous_cmd.sudo')).toBe(false);
});

test('getRulesForFile: .ts does not include dangerous_cmd.disk_format (sh only)', () => {
  expect(getRuleIds('src/disk.ts').includes('dangerous_cmd.disk_format')).toBe(false);
});

// ---------------------------------------------------------------------------
// .html files
// ---------------------------------------------------------------------------

test('getRulesForFile: .html includes web_content.inline_script', () => {
  expect(getRuleIds('index.html').includes('web_content.inline_script')).toBeTruthy();
});

test('getRulesForFile: .html includes web_content.external_resource', () => {
  expect(getRuleIds('page.html').includes('web_content.external_resource')).toBeTruthy();
});

test('getRulesForFile: .html does not include dangerous_cmd.rm_rf', () => {
  expect(getRuleIds('template.html').includes('dangerous_cmd.rm_rf')).toBe(false);
});

// ---------------------------------------------------------------------------
// .svg files
// ---------------------------------------------------------------------------

test('getRulesForFile: .svg includes web_content.svg_script', () => {
  expect(getRuleIds('icon.svg').includes('web_content.svg_script')).toBeTruthy();
});

test('getRulesForFile: .svg does not include dangerous_cmd rules', () => {
  const hasDangerous = getRuleIds('logo.svg').some((id: string) => id.startsWith('dangerous_cmd.'));
  expect(hasDangerous).toBe(false);
});

// ---------------------------------------------------------------------------
// .js files
// ---------------------------------------------------------------------------

test('getRulesForFile: .js includes file_access.ssh_keys', () => {
  expect(getRuleIds('lib/util.js').includes('file_access.ssh_keys')).toBeTruthy();
});

test('getRulesForFile: .js includes network.data_exfil_fetch', () => {
  expect(getRuleIds('lib/net.js').includes('network.data_exfil_fetch')).toBeTruthy();
});

test('getRulesForFile: .js includes process.crypto_miner', () => {
  expect(getRuleIds('lib/bg.js').includes('process.crypto_miner')).toBeTruthy();
});

test('getRulesForFile: .js includes network.dns_exfil', () => {
  expect(getRuleIds('lib/dns.js').includes('network.dns_exfil')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// .ps1 files
// ---------------------------------------------------------------------------

test('getRulesForFile: .ps1 includes dangerous_cmd.rm_rf', () => {
  expect(getRuleIds('script.ps1').includes('dangerous_cmd.rm_rf')).toBeTruthy();
});

test('getRulesForFile: .ps1 includes file_access.aws_credentials', () => {
  expect(getRuleIds('script.ps1').includes('file_access.aws_credentials')).toBeTruthy();
});

test('getRulesForFile: .ps1 includes screen_input.keylogger', () => {
  expect(getRuleIds('script.ps1').includes('screen_input.keylogger')).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Rule count comparisons
// ---------------------------------------------------------------------------

test('getRulesForFile: .sh has more rules than .html', () => {
  expect(getRulesForFile('run.sh').length > getRulesForFile('index.html').length).toBeTruthy();
});

test('getRulesForFile: .ts returns at least 5 distinct rules', () => {
  expect(getRulesForFile('src/code.ts').length >= 5).toBeTruthy();
});

test('getRulesForFile: .sh returns at least 8 distinct rules', () => {
  expect(getRulesForFile('run.sh').length >= 8).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Nested paths - extension matching should ignore directory name
// ---------------------------------------------------------------------------

test('getRulesForFile: nested .ts path still matches correctly', () => {
  const ids = getRuleIds('deep/nested/dir/helper.ts');
  expect(ids.includes('file_access.ssh_keys')).toBeTruthy();
  expect(ids.includes('payment.payment_api')).toBeTruthy();
});

test('getRulesForFile: nested .sh path still matches correctly', () => {
  expect(getRuleIds('scripts/deploy/run.sh').includes('dangerous_cmd.rm_rf')).toBeTruthy();
});
