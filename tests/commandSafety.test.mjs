/**
 * Unit tests for commandSafety.ts
 *
 * Tests the three exported pure functions that classify shell commands
 * by their potential for destructive side-effects:
 *
 *   - isDeleteCommand:       returns true when the command contains a
 *                            recognised delete verb (rm, rmdir, unlink,
 *                            del, erase, remove-item, find -delete,
 *                            git clean, osascript … delete).
 *
 *   - isDangerousCommand:    superset of isDeleteCommand that also
 *                            matches git push, git reset --hard, kill,
 *                            chmod/chown.
 *
 *   - getCommandDangerLevel: returns { level, reason } where level is
 *                            'destructive' | 'caution' | 'safe'.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isDeleteCommand,
  isDangerousCommand,
  getCommandDangerLevel,
} = require('../dist-electron/main/libs/commandSafety.js');

// ── isDeleteCommand ──────────────────────────────────────────────────────────

test('isDeleteCommand: rm matches', () => {
  assert.equal(isDeleteCommand('rm file.txt'), true);
});

test('isDeleteCommand: rm with multiple flags matches', () => {
  assert.equal(isDeleteCommand('rm -i obsolete.log'), true);
});

test('isDeleteCommand: rmdir matches', () => {
  assert.equal(isDeleteCommand('rmdir /tmp/build'), true);
});

test('isDeleteCommand: unlink matches', () => {
  assert.equal(isDeleteCommand('unlink /var/run/app.pid'), true);
});

test('isDeleteCommand: del matches (Windows style)', () => {
  assert.equal(isDeleteCommand('del C:\\Users\\foo\\bar.txt'), true);
});

test('isDeleteCommand: erase matches', () => {
  assert.equal(isDeleteCommand('erase temp.dat'), true);
});

test('isDeleteCommand: remove-item matches (PowerShell)', () => {
  assert.equal(isDeleteCommand('Remove-Item -Path C:\\Logs\\*.log'), true);
});

test('isDeleteCommand: find -delete matches', () => {
  assert.equal(isDeleteCommand('find . -name "*.tmp" -delete'), true);
});

test('isDeleteCommand: git clean matches', () => {
  assert.equal(isDeleteCommand('git clean -fd'), true);
});

test('isDeleteCommand: git clean with extra flags matches', () => {
  assert.equal(isDeleteCommand('git clean -fdx'), true);
});

test('isDeleteCommand: ls does not match', () => {
  assert.equal(isDeleteCommand('ls -la /tmp'), false);
});

test('isDeleteCommand: git push does not match', () => {
  assert.equal(isDeleteCommand('git push origin main'), false);
});

test('isDeleteCommand: echo does not match', () => {
  assert.equal(isDeleteCommand('echo "hello world"'), false);
});

test('isDeleteCommand: npm install does not match', () => {
  assert.equal(isDeleteCommand('npm install react'), false);
});

test('isDeleteCommand: cat does not match', () => {
  assert.equal(isDeleteCommand('cat /etc/hosts'), false);
});

// ── isDangerousCommand ───────────────────────────────────────────────────────

test('isDangerousCommand: delete commands are dangerous', () => {
  assert.equal(isDangerousCommand('rm -rf /tmp/old'), true);
});

test('isDangerousCommand: git push origin main is dangerous', () => {
  assert.equal(isDangerousCommand('git push origin main'), true);
});

test('isDangerousCommand: git push with upstream flag is dangerous', () => {
  assert.equal(isDangerousCommand('git push -u origin feat/my-branch'), true);
});

test('isDangerousCommand: git reset --hard is dangerous', () => {
  assert.equal(isDangerousCommand('git reset --hard HEAD~1'), true);
});

test('isDangerousCommand: kill is dangerous', () => {
  assert.equal(isDangerousCommand('kill -9 12345'), true);
});

test('isDangerousCommand: killall is dangerous', () => {
  assert.equal(isDangerousCommand('killall node'), true);
});

test('isDangerousCommand: pkill is dangerous', () => {
  assert.equal(isDangerousCommand('pkill -f my-server'), true);
});

test('isDangerousCommand: chmod is dangerous', () => {
  assert.equal(isDangerousCommand('chmod 777 /usr/local/bin/app'), true);
});

test('isDangerousCommand: chown is dangerous', () => {
  assert.equal(isDangerousCommand('chown root:root /etc/shadow'), true);
});

test('isDangerousCommand: ls is safe', () => {
  assert.equal(isDangerousCommand('ls -la'), false);
});

test('isDangerousCommand: cat is safe', () => {
  assert.equal(isDangerousCommand('cat README.md'), false);
});

test('isDangerousCommand: npm install is safe', () => {
  assert.equal(isDangerousCommand('npm install'), false);
});

test('isDangerousCommand: git status is safe', () => {
  assert.equal(isDangerousCommand('git status'), false);
});

test('isDangerousCommand: git log is safe', () => {
  assert.equal(isDangerousCommand('git log --oneline -10'), false);
});

// ── getCommandDangerLevel ────────────────────────────────────────────────────

// ─── destructive ──────────────────────────────────────

test('getCommandDangerLevel: rm -rf → destructive / recursive-delete', () => {
  const result = getCommandDangerLevel('rm -rf /tmp/old');
  assert.equal(result.level, 'destructive');
  assert.equal(result.reason, 'recursive-delete');
});

test('getCommandDangerLevel: rm -r → destructive / recursive-delete', () => {
  const result = getCommandDangerLevel('rm -r build/');
  assert.equal(result.level, 'destructive');
  assert.equal(result.reason, 'recursive-delete');
});

test('getCommandDangerLevel: rm --recursive → destructive / recursive-delete', () => {
  const result = getCommandDangerLevel('rm --recursive dist/');
  assert.equal(result.level, 'destructive');
  assert.equal(result.reason, 'recursive-delete');
});

test('getCommandDangerLevel: git push --force → destructive / git-force-push', () => {
  const result = getCommandDangerLevel('git push --force origin main');
  assert.equal(result.level, 'destructive');
  assert.equal(result.reason, 'git-force-push');
});

test('getCommandDangerLevel: git push -f → destructive / git-force-push', () => {
  const result = getCommandDangerLevel('git push -f origin feat/fix');
  assert.equal(result.level, 'destructive');
  assert.equal(result.reason, 'git-force-push');
});

test('getCommandDangerLevel: git reset --hard → destructive / git-reset-hard', () => {
  const result = getCommandDangerLevel('git reset --hard HEAD~3');
  assert.equal(result.level, 'destructive');
  assert.equal(result.reason, 'git-reset-hard');
});

test('getCommandDangerLevel: dd command → destructive / disk-overwrite', () => {
  const result = getCommandDangerLevel('dd if=/dev/zero of=/dev/sda bs=512');
  assert.equal(result.level, 'destructive');
  assert.equal(result.reason, 'disk-overwrite');
});

test('getCommandDangerLevel: mkfs command → destructive / disk-format', () => {
  const result = getCommandDangerLevel('mkfs.ext4 /dev/sdb1');
  assert.equal(result.level, 'destructive');
  assert.equal(result.reason, 'disk-format');
});

// ─── caution ──────────────────────────────────────────

test('getCommandDangerLevel: plain rm → caution / file-delete', () => {
  const result = getCommandDangerLevel('rm old-file.txt');
  assert.equal(result.level, 'caution');
  assert.equal(result.reason, 'file-delete');
});

test('getCommandDangerLevel: find -delete → caution / file-delete', () => {
  const result = getCommandDangerLevel('find /tmp -name "*.log" -mtime +7 -delete');
  assert.equal(result.level, 'caution');
  assert.equal(result.reason, 'file-delete');
});

test('getCommandDangerLevel: git clean → caution / file-delete', () => {
  const result = getCommandDangerLevel('git clean -fd');
  assert.equal(result.level, 'caution');
  assert.equal(result.reason, 'file-delete');
});

test('getCommandDangerLevel: git push without force → caution / git-push', () => {
  const result = getCommandDangerLevel('git push origin main');
  assert.equal(result.level, 'caution');
  assert.equal(result.reason, 'git-push');
});

test('getCommandDangerLevel: kill → caution / process-kill', () => {
  const result = getCommandDangerLevel('kill -9 9876');
  assert.equal(result.level, 'caution');
  assert.equal(result.reason, 'process-kill');
});

test('getCommandDangerLevel: chmod → caution / permission-change', () => {
  const result = getCommandDangerLevel('chmod 755 deploy.sh');
  assert.equal(result.level, 'caution');
  assert.equal(result.reason, 'permission-change');
});

test('getCommandDangerLevel: chown → caution / permission-change', () => {
  const result = getCommandDangerLevel('chown www-data:www-data /var/www/app');
  assert.equal(result.level, 'caution');
  assert.equal(result.reason, 'permission-change');
});

// ─── safe ─────────────────────────────────────────────

test('getCommandDangerLevel: ls → safe', () => {
  const result = getCommandDangerLevel('ls -la /tmp');
  assert.equal(result.level, 'safe');
  assert.equal(result.reason, '');
});

test('getCommandDangerLevel: git status → safe', () => {
  const result = getCommandDangerLevel('git status');
  assert.equal(result.level, 'safe');
  assert.equal(result.reason, '');
});

test('getCommandDangerLevel: npm install → safe', () => {
  const result = getCommandDangerLevel('npm install lodash');
  assert.equal(result.level, 'safe');
  assert.equal(result.reason, '');
});

test('getCommandDangerLevel: echo → safe', () => {
  const result = getCommandDangerLevel('echo "deployment complete"');
  assert.equal(result.level, 'safe');
  assert.equal(result.reason, '');
});

test('getCommandDangerLevel: empty string → safe', () => {
  const result = getCommandDangerLevel('');
  assert.equal(result.level, 'safe');
  assert.equal(result.reason, '');
});
