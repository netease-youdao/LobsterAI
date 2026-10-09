import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { OpenClawLoopbackRepairOutcome } from '../../shared/openclawEngine/constants';
import { LoopbackSelfTestOutcome } from './loopbackSelfTest';

const updater = vi.hoisted(() => ({
  execFileWithExitCode: vi.fn(),
  resolveWindowsPowerShellPath: vi.fn(),
}));

// The real module pulls in Electron; only these three exports are used.
vi.mock('./appUpdateInstaller', () => ({
  WINDOWS_UAC_DECLINED_EXIT_CODE: 1223,
  execFileWithExitCode: updater.execFileWithExitCode,
  resolveWindowsPowerShellPath: updater.resolveWindowsPowerShellPath,
}));

import {
  addWindowsLoopbackFirewallRule,
  buildLoopbackFirewallElevatedScript,
  buildLoopbackFirewallLaunchScript,
  buildLoopbackFirewallRuleArgs,
  formatLoopbackFirewallManualCommand,
  repairWindowsLoopbackFirewall,
  WINDOWS_LOOPBACK_FIREWALL_RULE_NAME,
} from './windowsLoopbackFirewall';

const programPath = String.raw`C:\Program Files\LobsterAI\LobsterAI.exe`;
const powerShellPath = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

afterEach(() => {
  vi.clearAllMocks();
});

describe('loopback firewall rule', () => {
  test('allows only inbound TCP between loopback addresses for one program', () => {
    expect(buildLoopbackFirewallRuleArgs(programPath)).toEqual([
      'advfirewall', 'firewall', 'add', 'rule',
      'name=LobsterAI loopback',
      'dir=in',
      'action=allow',
      `program=${programPath}`,
      'protocol=TCP',
      // No ::1: netsh rejects it as a rule address and fails the whole add.
      'localip=127.0.0.1',
      'remoteip=127.0.0.1',
      'profile=any',
    ]);
  });

  test('gives administrators a command they can paste', () => {
    expect(formatLoopbackFirewallManualCommand(programPath)).toBe(
      'netsh advfirewall firewall add rule name="LobsterAI loopback" dir=in action=allow '
      + `program="${programPath}" protocol=TCP localip=127.0.0.1 remoteip=127.0.0.1 profile=any`,
    );
  });

  test('matches the rule the installer writes', () => {
    const installer = fs.readFileSync(path.resolve(process.cwd(), 'scripts/nsis-installer.nsh'), 'utf8');

    expect(installer).toContain(String.raw`firewall add rule \"name=${WINDOWS_LOOPBACK_FIREWALL_RULE_NAME}\" dir=in action=allow $$program protocol=TCP localip=127.0.0.1 remoteip=127.0.0.1 profile=any`);
    expect(installer).toContain(String.raw`firewall delete rule \"name=${WINDOWS_LOOPBACK_FIREWALL_RULE_NAME}\" dir=in`);
  });
});

describe('buildLoopbackFirewallElevatedScript', () => {
  test('replaces the rule for this program and exits with the add result', () => {
    const script = buildLoopbackFirewallElevatedScript(programPath);
    const lines = script.split('\n');

    expect(lines[0]).toBe("$netsh = Join-Path $env:SystemRoot 'System32\\netsh.exe'");
    expect(lines[1]).toBe(
      `& $netsh 'advfirewall' 'firewall' 'delete' 'rule' 'name=LobsterAI loopback' 'dir=in' 'program=${programPath}' | Out-Null`,
    );
    expect(lines[2]).toContain("'localip=127.0.0.1' 'remoteip=127.0.0.1'");
    expect(lines[3]).toBe('exit $LASTEXITCODE');
  });

  test('keeps quotes in the program path literal', () => {
    // PowerShell ends a single-quoted string at a typographic quote too.
    const script = buildLoopbackFirewallElevatedScript('C:\\Users\\O\'Brien\\Lobster\u2019s\\LobsterAI.exe');

    expect(script).toContain('\'program=C:\\Users\\O\'\'Brien\\Lobster\u2019\u2019s\\LobsterAI.exe\'');
  });
});

describe('addWindowsLoopbackFirewallRule', () => {
  test('raises one UAC prompt for the elevated script, passing inputs through the environment', async () => {
    updater.resolveWindowsPowerShellPath.mockReturnValue(powerShellPath);
    updater.execFileWithExitCode.mockResolvedValue({ code: 0, stderr: '' });

    await expect(addWindowsLoopbackFirewallRule(programPath)).resolves.toEqual({ code: 0, stderr: '' });

    const [file, args, timeoutMs, env] = updater.execFileWithExitCode.mock.calls[0];
    expect(file).toBe(powerShellPath);
    expect(args).toEqual(['-NoProfile', '-NonInteractive', '-Command', buildLoopbackFirewallLaunchScript()]);
    expect(timeoutMs).toBeGreaterThanOrEqual(120_000);
    expect(env.LOBSTERAI_FIREWALL_POWERSHELL_PATH).toBe(powerShellPath);
    expect(Buffer.from(env.LOBSTERAI_FIREWALL_ELEVATED_COMMAND, 'base64').toString('utf16le'))
      .toBe(buildLoopbackFirewallElevatedScript(programPath));
  });

  test('launches through ShellExecute and keeps a declined prompt distinct', () => {
    const script = buildLoopbackFirewallLaunchScript();

    expect(script).toContain('-Verb RunAs -WindowStyle Hidden -Wait -PassThru');
    expect(script).toContain("'-EncodedCommand',$env:LOBSTERAI_FIREWALL_ELEVATED_COMMAND");
    expect(script).toContain('-FilePath $env:LOBSTERAI_FIREWALL_POWERSHELL_PATH');
    expect(script).toContain('if ($native -eq 1223) { exit 1223 }');
    // A missing exit code must not read as success.
    expect(script).toContain('if ($null -eq $elevated -or $null -eq $elevated.ExitCode) { exit 1 }');
    expect(script).not.toContain(programPath);
  });

  test('fails without launching anything when no trusted PowerShell exists', async () => {
    updater.resolveWindowsPowerShellPath.mockReturnValue(null);

    await expect(addWindowsLoopbackFirewallRule(programPath)).resolves.toMatchObject({ code: 1 });
    expect(updater.execFileWithExitCode).not.toHaveBeenCalled();
  });
});

describe('repairWindowsLoopbackFirewall', () => {
  const passing = { blocked: false, attempts: 1, last: { outcome: LoopbackSelfTestOutcome.Ok, elapsedMs: 1 } };
  const dropped = {
    blocked: true,
    attempts: 2,
    last: { outcome: LoopbackSelfTestOutcome.Blocked, code: 'ETIMEDOUT', elapsedMs: 300 },
  };

  test('is a no-op outside Windows', async () => {
    const addRule = vi.fn();

    await expect(repairWindowsLoopbackFirewall({ programPath, platform: 'darwin', addRule }))
      .resolves.toEqual({ outcome: OpenClawLoopbackRepairOutcome.Unsupported });
    expect(addRule).not.toHaveBeenCalled();
  });

  test('reports repaired once the rule is in place and the self-test passes', async () => {
    const addRule = vi.fn(async () => ({ code: 0, stderr: '' }));
    const detectBlock = vi.fn(async () => passing);

    await expect(repairWindowsLoopbackFirewall({ programPath, platform: 'win32', addRule, detectBlock }))
      .resolves.toEqual({ outcome: OpenClawLoopbackRepairOutcome.Repaired });
    expect(addRule).toHaveBeenCalledWith(programPath);
  });

  test('reports a declined UAC prompt without re-testing', async () => {
    const detectBlock = vi.fn();

    await expect(repairWindowsLoopbackFirewall({
      programPath,
      platform: 'win32',
      addRule: async () => ({ code: 1223, stderr: 'The operation was canceled by the user.' }),
      detectBlock,
    })).resolves.toEqual({ outcome: OpenClawLoopbackRepairOutcome.Cancelled });
    expect(detectBlock).not.toHaveBeenCalled();
  });

  test('hands over the manual command when the rule could not be added', async () => {
    await expect(repairWindowsLoopbackFirewall({
      programPath,
      platform: 'win32',
      addRule: async () => ({ code: 1, stderr: ' The requested operation requires elevation. \n' }),
      detectBlock: async () => passing,
    })).resolves.toEqual({
      outcome: OpenClawLoopbackRepairOutcome.Failed,
      detail: 'exit 1: The requested operation requires elevation.',
      manualCommand: formatLoopbackFirewallManualCommand(programPath),
    });
  });

  test('says when something other than the rule keeps dropping loopback', async () => {
    await expect(repairWindowsLoopbackFirewall({
      programPath,
      platform: 'win32',
      addRule: async () => ({ code: 0, stderr: '' }),
      detectBlock: async () => dropped,
    })).resolves.toEqual({ outcome: OpenClawLoopbackRepairOutcome.StillBlocked, detail: 'ETIMEDOUT' });
  });
});
