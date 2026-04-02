/**
 * Unit tests for src/main/libs/skillSecurity/skillSecurityRules.ts
 *
 * Covers:
 *   - ALL_SECURITY_RULES sanity checks (non-empty, well-formed, unique IDs)
 *   - getRulesForFile: returns correct rules per file extension
 *     - Unknown / unsupported extensions → zero rules
 *     - .sh / .bash → file_access, dangerous_command, network, process, screen_input
 *     - .ts → file_access, network, process, screen_input, payment
 *     - .html → web_content
 *     - .svg → web_content.svg_script
 *     - .js → broad rule set
 *     - .ps1 → dangerous_command, file_access, screen_input
 *   - Cross-extension negative assertions
 *   - Nested path matching
 *
 * Run: node --test tests/skillSecurityRules.test.mjs
 * Coverage: node --experimental-test-coverage --test tests/skillSecurityRules.test.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getRulesForFile, ALL_SECURITY_RULES } = require('../dist-electron/main/libs/skillSecurity/skillSecurityRules.js');

function getRuleIds(relativePath) {
  return getRulesForFile(relativePath).map((r) => r.id);
}

// ---------------------------------------------------------------------------
// ALL_SECURITY_RULES sanity
// ---------------------------------------------------------------------------

test('ALL_SECURITY_RULES is a non-empty array', () => {
  assert.ok(Array.isArray(ALL_SECURITY_RULES));
  assert.ok(ALL_SECURITY_RULES.length > 0);
});

test('every rule has required string fields: id, dimension, description', () => {
  for (const rule of ALL_SECURITY_RULES) {
    assert.equal(typeof rule.id, 'string');
    assert.ok(rule.id.length > 0);
    assert.equal(typeof rule.dimension, 'string');
    assert.equal(typeof rule.description, 'string');
  }
});

test('every rule has a non-empty filePatterns array', () => {
  for (const rule of ALL_SECURITY_RULES) {
    assert.ok(Array.isArray(rule.filePatterns));
    assert.ok(rule.filePatterns.length > 0);
  }
});

test('every rule has a non-empty patterns array of RegExp objects', () => {
  for (const rule of ALL_SECURITY_RULES) {
    assert.ok(Array.isArray(rule.patterns));
    assert.ok(rule.patterns.length > 0);
    for (const p of rule.patterns) {
      assert.ok(p instanceof RegExp);
    }
  }
});

test('every rule severity is one of: info, warning, danger, critical', () => {
  const valid = new Set(['info', 'warning', 'danger', 'critical']);
  for (const rule of ALL_SECURITY_RULES) {
    assert.ok(valid.has(rule.severity), `Unexpected severity "${rule.severity}" on rule ${rule.id}`);
  }
});

test('all rule ids are unique', () => {
  const ids = ALL_SECURITY_RULES.map((r) => r.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length);
});

// ---------------------------------------------------------------------------
// Unknown / unsupported extensions
// ---------------------------------------------------------------------------

test('getRulesForFile: unknown extension returns empty array', () => {
  assert.deepEqual(getRulesForFile('script.xyz'), []);
});

test('getRulesForFile: .md extension returns empty array', () => {
  assert.deepEqual(getRulesForFile('README.md'), []);
});

test('getRulesForFile: no extension returns empty array', () => {
  assert.deepEqual(getRulesForFile('Makefile'), []);
});

// ---------------------------------------------------------------------------
// .sh files
// ---------------------------------------------------------------------------

test('getRulesForFile: .sh includes file_access.ssh_keys', () => {
  assert.ok(getRuleIds('deploy.sh').includes('file_access.ssh_keys'));
});

test('getRulesForFile: .sh includes dangerous_cmd.rm_rf', () => {
  assert.ok(getRuleIds('cleanup.sh').includes('dangerous_cmd.rm_rf'));
});

test('getRulesForFile: .sh includes dangerous_cmd.sudo', () => {
  assert.ok(getRuleIds('setup.sh').includes('dangerous_cmd.sudo'));
});

test('getRulesForFile: .sh includes dangerous_cmd.disk_format', () => {
  assert.ok(getRuleIds('format.sh').includes('dangerous_cmd.disk_format'));
});

test('getRulesForFile: .sh includes network.data_exfil_curl', () => {
  assert.ok(getRuleIds('upload.sh').includes('network.data_exfil_curl'));
});

test('getRulesForFile: .sh includes process.reverse_shell', () => {
  assert.ok(getRuleIds('connect.sh').includes('process.reverse_shell'));
});

test('getRulesForFile: .sh includes process.background_daemon', () => {
  assert.ok(getRuleIds('daemon.sh').includes('process.background_daemon'));
});

test('getRulesForFile: .sh includes screen_input.screenshot', () => {
  assert.ok(getRuleIds('capture.sh').includes('screen_input.screenshot'));
});

test('getRulesForFile: .sh includes screen_input.clipboard', () => {
  assert.ok(getRuleIds('paste.sh').includes('screen_input.clipboard'));
});

// ---------------------------------------------------------------------------
// .bash files
// ---------------------------------------------------------------------------

test('getRulesForFile: .bash includes file_access.ssh_keys', () => {
  assert.ok(getRuleIds('run.bash').includes('file_access.ssh_keys'));
});

test('getRulesForFile: .bash includes dangerous_cmd.sudo', () => {
  assert.ok(getRuleIds('run.bash').includes('dangerous_cmd.sudo'));
});

// ---------------------------------------------------------------------------
// .ts files
// ---------------------------------------------------------------------------

test('getRulesForFile: .ts includes file_access.ssh_keys', () => {
  assert.ok(getRuleIds('src/utils.ts').includes('file_access.ssh_keys'));
});

test('getRulesForFile: .ts includes file_access.aws_credentials', () => {
  assert.ok(getRuleIds('src/aws.ts').includes('file_access.aws_credentials'));
});

test('getRulesForFile: .ts includes network.data_exfil_fetch', () => {
  assert.ok(getRuleIds('src/net.ts').includes('network.data_exfil_fetch'));
});

test('getRulesForFile: .ts includes network.webhook_exfil', () => {
  assert.ok(getRuleIds('src/notify.ts').includes('network.webhook_exfil'));
});

test('getRulesForFile: .ts includes process.reverse_shell', () => {
  assert.ok(getRuleIds('src/shell.ts').includes('process.reverse_shell'));
});

test('getRulesForFile: .ts includes process.crypto_miner', () => {
  assert.ok(getRuleIds('src/miner.ts').includes('process.crypto_miner'));
});

test('getRulesForFile: .ts includes screen_input.keylogger', () => {
  assert.ok(getRuleIds('src/keyboard.ts').includes('screen_input.keylogger'));
});

test('getRulesForFile: .ts includes payment.payment_api', () => {
  assert.ok(getRuleIds('src/payment.ts').includes('payment.payment_api'));
});

test('getRulesForFile: .ts includes payment.crypto_wallet', () => {
  assert.ok(getRuleIds('src/wallet.ts').includes('payment.crypto_wallet'));
});

test('getRulesForFile: .ts does not include dangerous_cmd.sudo (sh only)', () => {
  assert.ok(!getRuleIds('src/admin.ts').includes('dangerous_cmd.sudo'));
});

test('getRulesForFile: .ts does not include dangerous_cmd.disk_format (sh only)', () => {
  assert.ok(!getRuleIds('src/disk.ts').includes('dangerous_cmd.disk_format'));
});

// ---------------------------------------------------------------------------
// .html files
// ---------------------------------------------------------------------------

test('getRulesForFile: .html includes web_content.inline_script', () => {
  assert.ok(getRuleIds('index.html').includes('web_content.inline_script'));
});

test('getRulesForFile: .html includes web_content.external_resource', () => {
  assert.ok(getRuleIds('page.html').includes('web_content.external_resource'));
});

test('getRulesForFile: .html does not include dangerous_cmd.rm_rf', () => {
  assert.ok(!getRuleIds('template.html').includes('dangerous_cmd.rm_rf'));
});

// ---------------------------------------------------------------------------
// .svg files
// ---------------------------------------------------------------------------

test('getRulesForFile: .svg includes web_content.svg_script', () => {
  assert.ok(getRuleIds('icon.svg').includes('web_content.svg_script'));
});

test('getRulesForFile: .svg does not include dangerous_cmd rules', () => {
  const hasDangerous = getRuleIds('logo.svg').some((id) => id.startsWith('dangerous_cmd.'));
  assert.equal(hasDangerous, false);
});

// ---------------------------------------------------------------------------
// .js files
// ---------------------------------------------------------------------------

test('getRulesForFile: .js includes file_access.ssh_keys', () => {
  assert.ok(getRuleIds('lib/util.js').includes('file_access.ssh_keys'));
});

test('getRulesForFile: .js includes network.data_exfil_fetch', () => {
  assert.ok(getRuleIds('lib/net.js').includes('network.data_exfil_fetch'));
});

test('getRulesForFile: .js includes process.crypto_miner', () => {
  assert.ok(getRuleIds('lib/bg.js').includes('process.crypto_miner'));
});

test('getRulesForFile: .js includes network.dns_exfil', () => {
  assert.ok(getRuleIds('lib/dns.js').includes('network.dns_exfil'));
});

// ---------------------------------------------------------------------------
// .ps1 files
// ---------------------------------------------------------------------------

test('getRulesForFile: .ps1 includes dangerous_cmd.rm_rf', () => {
  assert.ok(getRuleIds('script.ps1').includes('dangerous_cmd.rm_rf'));
});

test('getRulesForFile: .ps1 includes file_access.aws_credentials', () => {
  assert.ok(getRuleIds('script.ps1').includes('file_access.aws_credentials'));
});

test('getRulesForFile: .ps1 includes screen_input.keylogger', () => {
  assert.ok(getRuleIds('script.ps1').includes('screen_input.keylogger'));
});

// ---------------------------------------------------------------------------
// Rule count comparisons
// ---------------------------------------------------------------------------

test('getRulesForFile: .sh has more rules than .html', () => {
  assert.ok(getRulesForFile('run.sh').length > getRulesForFile('index.html').length);
});

test('getRulesForFile: .ts returns at least 5 distinct rules', () => {
  assert.ok(getRulesForFile('src/code.ts').length >= 5);
});

test('getRulesForFile: .sh returns at least 8 distinct rules', () => {
  assert.ok(getRulesForFile('run.sh').length >= 8);
});

// ---------------------------------------------------------------------------
// Nested paths — extension matching should ignore directory name
// ---------------------------------------------------------------------------

test('getRulesForFile: nested .ts path still matches correctly', () => {
  const ids = getRuleIds('deep/nested/dir/helper.ts');
  assert.ok(ids.includes('file_access.ssh_keys'));
  assert.ok(ids.includes('payment.payment_api'));
});

test('getRulesForFile: nested .sh path still matches correctly', () => {
  assert.ok(getRuleIds('scripts/deploy/run.sh').includes('dangerous_cmd.rm_rf'));
});
