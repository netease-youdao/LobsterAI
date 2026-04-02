import { test, expect, describe } from 'vitest';
import {
  isDeleteCommand,
  isDangerousCommand,
  getCommandDangerLevel,
} from './commandSafety';

// ---------------------------------------------------------------------------
// isDeleteCommand
// ---------------------------------------------------------------------------

describe('isDeleteCommand', () => {
  test('detects rm', () => {
    expect(isDeleteCommand('rm file.txt')).toBe(true);
    expect(isDeleteCommand('rm -rf /tmp/foo')).toBe(true);
  });

  test('detects rmdir', () => {
    expect(isDeleteCommand('rmdir mydir')).toBe(true);
  });

  test('detects unlink', () => {
    expect(isDeleteCommand('unlink /var/run/app.pid')).toBe(true);
  });

  test('detects del (Windows)', () => {
    expect(isDeleteCommand('del C:\\temp\\file.txt')).toBe(true);
  });

  test('detects erase', () => {
    expect(isDeleteCommand('erase old.log')).toBe(true);
  });

  test('detects remove-item (PowerShell)', () => {
    expect(isDeleteCommand('Remove-Item C:\\foo')).toBe(true);
    expect(isDeleteCommand('remove-item foo')).toBe(true);
  });

  test('detects trash', () => {
    expect(isDeleteCommand('trash dist/')).toBe(true);
  });

  test('detects find -delete', () => {
    expect(isDeleteCommand('find . -name "*.log" -delete')).toBe(true);
    expect(isDeleteCommand('find /tmp -mtime +7 -delete')).toBe(true);
  });

  test('detects git clean', () => {
    expect(isDeleteCommand('git clean -fd')).toBe(true);
    expect(isDeleteCommand('git clean -fdx')).toBe(true);
  });

  test('detects osascript ... delete', () => {
    expect(isDeleteCommand('osascript -e \'tell app "Finder" to delete item\'')).toBe(true);
  });

  test('returns false for safe commands', () => {
    expect(isDeleteCommand('ls -la')).toBe(false);
    expect(isDeleteCommand('echo hello')).toBe(false);
    expect(isDeleteCommand('git status')).toBe(false);
    expect(isDeleteCommand('npm install')).toBe(false);
    expect(isDeleteCommand('git log --oneline')).toBe(false);
  });

  test('returns false for word containing rm but not as standalone', () => {
    // 'rm' must be a word boundary — 'firmware' should NOT match
    expect(isDeleteCommand('cat firmware.bin')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDangerousCommand
// ---------------------------------------------------------------------------

describe('isDangerousCommand', () => {
  test('is dangerous for delete commands', () => {
    expect(isDangerousCommand('rm -rf dist')).toBe(true);
    expect(isDangerousCommand('git clean -fd')).toBe(true);
  });

  test('is dangerous for git push', () => {
    expect(isDangerousCommand('git push origin main')).toBe(true);
    expect(isDangerousCommand('git push')).toBe(true);
  });

  test('is dangerous for git push --force', () => {
    expect(isDangerousCommand('git push origin main --force')).toBe(true);
    expect(isDangerousCommand('git push -f')).toBe(true);
  });

  test('is dangerous for git reset --hard', () => {
    expect(isDangerousCommand('git reset --hard HEAD~1')).toBe(true);
  });

  test('is dangerous for kill/killall/pkill', () => {
    expect(isDangerousCommand('kill 1234')).toBe(true);
    expect(isDangerousCommand('killall node')).toBe(true);
    expect(isDangerousCommand('pkill -f myapp')).toBe(true);
  });

  test('is dangerous for chmod/chown', () => {
    expect(isDangerousCommand('chmod 777 script.sh')).toBe(true);
    expect(isDangerousCommand('chown root:root file')).toBe(true);
  });

  test('returns false for safe commands', () => {
    expect(isDangerousCommand('npm run build')).toBe(false);
    expect(isDangerousCommand('git status')).toBe(false);
    expect(isDangerousCommand('ls -la')).toBe(false);
    expect(isDangerousCommand('echo hello')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCommandDangerLevel
// ---------------------------------------------------------------------------

describe('getCommandDangerLevel', () => {
  // --- destructive ---
  test('rm -rf is destructive', () => {
    const r = getCommandDangerLevel('rm -rf /tmp/build');
    expect(r.level).toBe('destructive');
    expect(r.reason).toBe('recursive-delete');
  });

  test('rm --recursive is destructive', () => {
    const r = getCommandDangerLevel('rm --recursive dist');
    expect(r.level).toBe('destructive');
    expect(r.reason).toBe('recursive-delete');
  });

  test('rm -fr is destructive (flag order reversed)', () => {
    const r = getCommandDangerLevel('rm -fr /var/log/old');
    expect(r.level).toBe('destructive');
    expect(r.reason).toBe('recursive-delete');
  });

  test('git push --force is destructive', () => {
    const r = getCommandDangerLevel('git push origin main --force');
    expect(r.level).toBe('destructive');
    expect(r.reason).toBe('git-force-push');
  });

  test('git push -f is destructive', () => {
    const r = getCommandDangerLevel('git push -f');
    expect(r.level).toBe('destructive');
    expect(r.reason).toBe('git-force-push');
  });

  test('git reset --hard is destructive', () => {
    const r = getCommandDangerLevel('git reset --hard HEAD');
    expect(r.level).toBe('destructive');
    expect(r.reason).toBe('git-reset-hard');
  });

  test('dd is destructive', () => {
    const r = getCommandDangerLevel('dd if=/dev/zero of=/dev/sda');
    expect(r.level).toBe('destructive');
    expect(r.reason).toBe('disk-overwrite');
  });

  test('mkfs is destructive', () => {
    const r = getCommandDangerLevel('mkfs.ext4 /dev/sdb1');
    expect(r.level).toBe('destructive');
    expect(r.reason).toBe('disk-format');
  });

  // --- caution ---
  test('rm (non-recursive) is caution', () => {
    const r = getCommandDangerLevel('rm file.txt');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('file-delete');
  });

  test('git clean is caution', () => {
    const r = getCommandDangerLevel('git clean -fd');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('file-delete');
  });

  test('find -delete is caution', () => {
    const r = getCommandDangerLevel('find . -name "*.tmp" -delete');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('file-delete');
  });

  test('git push (no force) is caution', () => {
    const r = getCommandDangerLevel('git push origin main');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('git-push');
  });

  test('kill is caution', () => {
    const r = getCommandDangerLevel('kill -9 1234');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('process-kill');
  });

  test('killall is caution', () => {
    const r = getCommandDangerLevel('killall node');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('process-kill');
  });

  test('pkill is caution', () => {
    const r = getCommandDangerLevel('pkill -f myapp');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('process-kill');
  });

  test('chmod is caution', () => {
    const r = getCommandDangerLevel('chmod +x deploy.sh');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('permission-change');
  });

  test('chown is caution', () => {
    const r = getCommandDangerLevel('chown www-data:www-data /var/www');
    expect(r.level).toBe('caution');
    expect(r.reason).toBe('permission-change');
  });

  // --- safe ---
  test('npm install is safe', () => {
    const r = getCommandDangerLevel('npm install');
    expect(r.level).toBe('safe');
    expect(r.reason).toBe('');
  });

  test('git status is safe', () => {
    const r = getCommandDangerLevel('git status');
    expect(r.level).toBe('safe');
    expect(r.reason).toBe('');
  });

  test('ls is safe', () => {
    const r = getCommandDangerLevel('ls -la');
    expect(r.level).toBe('safe');
    expect(r.reason).toBe('');
  });

  test('echo is safe', () => {
    const r = getCommandDangerLevel('echo "hello world"');
    expect(r.level).toBe('safe');
    expect(r.reason).toBe('');
  });

  test('git log is safe', () => {
    const r = getCommandDangerLevel('git log --oneline -10');
    expect(r.level).toBe('safe');
    expect(r.reason).toBe('');
  });
});
