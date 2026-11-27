import { describe, expect, test } from 'vitest';

import {
  analyzeCommandDanger,
  CommandDangerLevel,
  CommandDangerReason,
  isDangerousCommand,
  isDeleteCommand,
} from './commandDanger';

describe('analyzeCommandDanger', () => {
  test('ignores benign owner-only credential permission tightening (chmod 600 / os.chmod 0o600)', () => {
    const splitCredsScript = [
      'cd "/Users/alice/Documents/Obsidian Vault/.tmp/github-app-setup" && python3 - <<\'PY\'',
      'import json, os',
      'new = json.load(open(\'credentials.json\'))',
      'keep = {k: new.get(k) for k in (\'id\', \'slug\', \'name\', \'client_id\')}',
      'open(\'app1.json\', \'w\').write(json.dumps(keep, indent=2))',
      'os.chmod(\'app1.json\', 0o600)',
      'PY',
    ].join('\n');

    expect(analyzeCommandDanger(splitCredsScript)).toEqual({
      level: CommandDangerLevel.Safe,
      reason: '',
      matchedSnippet: '',
      matchedLineNumber: 0,
      isEmbeddedInScript: false,
    });
    expect(isDangerousCommand(splitCredsScript)).toBe(false);

    expect(analyzeCommandDanger('chmod 600 credentials.json').level).toBe(CommandDangerLevel.Safe);
    expect(analyzeCommandDanger('chmod 0600 ~/.config/app/token.json').level).toBe(CommandDangerLevel.Safe);
    expect(analyzeCommandDanger('node -e "fs.chmodSync(\'cred.json\', 0o600)"').level).toBe(CommandDangerLevel.Safe);
  });

  test('still flags risky chmod/chown in shell and embedded scripts with exact line and snippet', () => {
    const scriptWithExecChmod = [
      'cd "/Users/alice/project" && python3 - <<\'PY\'',
      'import json, os',
      'data = json.load(open(\'config.json\'))',
      'open(\'deploy.sh\', \'w\').write(\'#!/bin/sh\\necho hi\\n\')',
      'os.chmod(\'deploy.sh\', 0o755)',
      'PY',
    ].join('\n');

    expect(analyzeCommandDanger(scriptWithExecChmod)).toEqual({
      level: CommandDangerLevel.Caution,
      reason: CommandDangerReason.PermissionChange,
      matchedSnippet: "os.chmod('deploy.sh', 0o755)",
      matchedLineNumber: 5,
      isEmbeddedInScript: true,
    });

    for (const riskyChmod of [
      'chmod 755 deploy.sh',
      'chmod 777 /usr/local/bin/app',
      'chmod +x run.sh',
      'chmod 000 locked.txt',
      'chmod -R 600 ./secrets',
      'chmod 600 ./secrets/',
      'chmod 600 /etc/shadow',
      'chown www-data:www-data /var/www/app',
      'node -e "fs.chmodSync(\'run.sh\', 0o755)"',
    ]) {
      const result = analyzeCommandDanger(riskyChmod);
      expect(result.level, riskyChmod).toBe(CommandDangerLevel.Caution);
      expect(result.reason, riskyChmod).toBe(CommandDangerReason.PermissionChange);
    }
  });

  test('eliminates false positives in strings, comments, date formats, commit messages, and data heredocs', () => {
    const safeCommands = [
      'echo "Do not run rm -rf or dd or chmod 777 or kill -9"',
      'git commit -m "fix: handle chmod, kill, dd, and git push safely"',
      'python3 -c \'fmt = "YYYY-MM-DD"; print(fmt)\'',
      'python3 - <<\'PY\'\ndd = {"k": 1}\n# os.chmod("x", 0o777)\nprint("run rm -rf /tmp/demo")\nPY',
      'cat <<\'EOF\' > README.md\nRun `chmod 755 deploy.sh` and `git push --force`\nEOF',
      '# rm -rf /tmp/old\nls -la',
      'rg "chmod|chown|mkfs" src/',
    ];

    for (const cmd of safeCommands) {
      expect(analyzeCommandDanger(cmd).level, cmd).toBe(CommandDangerLevel.Safe);
      expect(isDangerousCommand(cmd), cmd).toBe(false);
    }
  });

  test('distinguishes single-purpose commands from compound/embedded scripts and prevents cross-segment flag bleed', () => {
    // Leading cd + output pipe tail is still a single git-push intent
    expect(
      analyzeCommandDanger('cd /Users/alice/repo && git push origin main 2>&1 | tail -5'),
    ).toEqual({
      level: CommandDangerLevel.Caution,
      reason: CommandDangerReason.GitPush,
      matchedSnippet: 'git push origin main 2>&1',
      matchedLineNumber: 1,
      isEmbeddedInScript: false,
    });

    // `-f` in a subsequent command must NOT turn `git push` into `git-force-push`
    const chainedPushAndLs = analyzeCommandDanger('git push origin main && ls -f');
    expect(chainedPushAndLs.level).toBe(CommandDangerLevel.Caution);
    expect(chainedPushAndLs.reason).toBe(CommandDangerReason.GitPush);
    expect(chainedPushAndLs.isEmbeddedInScript).toBe(true);
  });

  test('classifies sudo as privilege-escalation while keeping higher-severity inner commands destructive', () => {
    expect(analyzeCommandDanger('sudo apt-get install jq')).toEqual({
      level: CommandDangerLevel.Caution,
      reason: CommandDangerReason.PrivilegeEscalation,
      matchedSnippet: 'sudo apt-get install jq',
      matchedLineNumber: 1,
      isEmbeddedInScript: false,
    });
    expect(isDangerousCommand('sudo apt-get install jq')).toBe(true);

    const sudoRm = analyzeCommandDanger('sudo rm -rf /tmp/demo');
    expect(sudoRm.level).toBe(CommandDangerLevel.Destructive);
    expect(sudoRm.reason).toBe(CommandDangerReason.RecursiveDelete);
  });

  test('detects destructive operations inside shell substitutions, Python subprocess/rmtree, and Node fs', () => {
    expect(analyzeCommandDanger('dd if=/dev/zero of=/dev/sda bs=512').reason).toBe(
      CommandDangerReason.DiskOverwrite,
    );
    expect(analyzeCommandDanger('mkfs.ext4 /dev/sdb1').reason).toBe(
      CommandDangerReason.DiskFormat,
    );
    expect(analyzeCommandDanger('echo "$(rm -rf /tmp/demo)"')).toMatchObject({
      level: CommandDangerLevel.Destructive,
      reason: CommandDangerReason.RecursiveDelete,
      isEmbeddedInScript: true,
    });
    expect(
      analyzeCommandDanger('python3 -c "import subprocess; subprocess.run([\'rm\', \'-rf\', \'/tmp/demo\'])"'),
    ).toMatchObject({
      level: CommandDangerLevel.Destructive,
      reason: CommandDangerReason.RecursiveDelete,
      isEmbeddedInScript: true,
    });
    expect(
      analyzeCommandDanger('python3 -c "import shutil; shutil.rmtree(\'/tmp/demo\')"'),
    ).toMatchObject({
      level: CommandDangerLevel.Destructive,
      reason: CommandDangerReason.RecursiveDelete,
      isEmbeddedInScript: true,
    });
    expect(
      analyzeCommandDanger('node -e "fs.rmSync(\'/tmp/demo\', { recursive: true })"'),
    ).toMatchObject({
      level: CommandDangerLevel.Destructive,
      reason: CommandDangerReason.RecursiveDelete,
      isEmbeddedInScript: true,
    });
  });

  test('isDeleteCommand still returns true when combined with a higher-priority danger', () => {
    expect(isDeleteCommand('git push --force origin main && rm temp.txt')).toBe(true);
    expect(analyzeCommandDanger('git push --force origin main && rm temp.txt').reason).toBe(
      CommandDangerReason.GitForcePush,
    );
  });
});
