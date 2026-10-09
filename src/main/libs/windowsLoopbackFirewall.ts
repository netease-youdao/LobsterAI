import { OpenClawLoopbackRepairOutcome } from '../../shared/openclawEngine/constants';
import {
  execFileWithExitCode,
  resolveWindowsPowerShellPath,
  WINDOWS_UAC_DECLINED_EXIT_CODE,
} from './appUpdateInstaller';
import { detectLoopbackBlock, type LoopbackBlockCheck } from './loopbackSelfTest';

/**
 * Inbound allow rule that lets this executable accept loopback connections;
 * loopbackSelfTest.ts explains why Windows Firewall drops them otherwise. The
 * installer (scripts/nsis-installer.nsh) writes the same rule. Both replace it
 * by name and program, so copies never pile up and other accounts' per-user
 * installs keep their own rule.
 */
export const WINDOWS_LOOPBACK_FIREWALL_RULE_NAME = 'LobsterAI loopback';
const LOOPBACK_ADDRESSES = '127.0.0.1,::1';

const POWERSHELL_PATH_ENV = 'LOBSTERAI_FIREWALL_POWERSHELL_PATH';
const ELEVATED_COMMAND_ENV = 'LOBSTERAI_FIREWALL_ELEVATED_COMMAND';
/** The secure-desktop consent prompt cancels itself after about 2 minutes. */
const ELEVATION_TIMEOUT_MS = 300_000;

/** netsh arguments that add the rule. */
export function buildLoopbackFirewallRuleArgs(programPath: string): string[] {
  return [
    'advfirewall', 'firewall', 'add', 'rule',
    `name=${WINDOWS_LOOPBACK_FIREWALL_RULE_NAME}`,
    'dir=in',
    'action=allow',
    `program=${programPath}`,
    'protocol=TCP',
    `localip=${LOOPBACK_ADDRESSES}`,
    `remoteip=${LOOPBACK_ADDRESSES}`,
    'profile=any',
  ];
}

/** The same command for an administrator prompt, for users the app cannot help. */
export function formatLoopbackFirewallManualCommand(programPath: string): string {
  const args = buildLoopbackFirewallRuleArgs(programPath)
    .map(arg => arg.replace(/^(name|program)=(.*)$/, '$1="$2"'));
  return ['netsh', ...args].join(' ');
}

// PowerShell also treats the typographic single quotes as quote characters.
const quotePowerShellLiteral = (value: string): string =>
  `'${value.replace(/['‘’‚‛]/g, quote => quote + quote)}'`;

/**
 * Runs elevated. Every netsh argument is a quoted literal because PowerShell
 * would otherwise split the comma lists into separate arguments.
 */
export function buildLoopbackFirewallElevatedScript(programPath: string): string {
  const quoteArgs = (args: string[]) => args.map(quotePowerShellLiteral).join(' ');
  const deleteArgs = [
    'advfirewall', 'firewall', 'delete', 'rule',
    `name=${WINDOWS_LOOPBACK_FIREWALL_RULE_NAME}`,
    'dir=in',
    `program=${programPath}`,
  ];
  return [
    "$netsh = Join-Path $env:SystemRoot 'System32\\netsh.exe'",
    // A missing rule makes delete exit 1; only the add decides the result.
    `& $netsh ${quoteArgs(deleteArgs)} | Out-Null`,
    `& $netsh ${quoteArgs(buildLoopbackFirewallRuleArgs(programPath))} | Out-Null`,
    'exit $LASTEXITCODE',
  ].join('\n');
}

/**
 * Runs unelevated. As in buildWindowsInstallerLaunchScript, Start-Process goes
 * through ShellExecute, the only way to raise the UAC prompt, and a declined
 * prompt surfaces as Win32 error 1223, whose message is localized but whose
 * native code is stable. Inputs travel through the environment.
 */
export function buildLoopbackFirewallLaunchScript(): string {
  return (
    `$ErrorActionPreference = 'Stop'; ` +
    `try { ` +
    `$elevated = Start-Process -FilePath $env:${POWERSHELL_PATH_ENV} ` +
    `-ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$env:${ELEVATED_COMMAND_ENV} ` +
    `-Verb RunAs -WindowStyle Hidden -Wait -PassThru; ` +
    `if ($null -eq $elevated -or $null -eq $elevated.ExitCode) { exit 1 }; ` +
    `exit $elevated.ExitCode ` +
    `} catch { ` +
    `$native = $_.Exception.NativeErrorCode; ` +
    `if ($null -eq $native -and $_.Exception.InnerException) { $native = $_.Exception.InnerException.NativeErrorCode }; ` +
    `[Console]::Error.WriteLine($_.Exception.Message); ` +
    `if ($native -eq ${WINDOWS_UAC_DECLINED_EXIT_CODE}) { exit ${WINDOWS_UAC_DECLINED_EXIT_CODE} }; ` +
    `exit 1 }`
  );
}

export interface LoopbackFirewallRuleResult {
  code: number;
  stderr: string;
}

/** Adds the rule from an elevated PowerShell; one UAC prompt. */
export async function addWindowsLoopbackFirewallRule(programPath: string): Promise<LoopbackFirewallRuleResult> {
  const powerShellPath = resolveWindowsPowerShellPath();
  if (!powerShellPath) {
    return { code: 1, stderr: 'Trusted Windows PowerShell executable was not found' };
  }
  return execFileWithExitCode(
    powerShellPath,
    ['-NoProfile', '-NonInteractive', '-Command', buildLoopbackFirewallLaunchScript()],
    ELEVATION_TIMEOUT_MS,
    {
      ...process.env,
      [POWERSHELL_PATH_ENV]: powerShellPath,
      [ELEVATED_COMMAND_ENV]: Buffer.from(buildLoopbackFirewallElevatedScript(programPath), 'utf16le').toString('base64'),
    },
  );
}

export interface LoopbackFirewallRepairResult {
  outcome: OpenClawLoopbackRepairOutcome;
  detail?: string;
  /** For an administrator to run when the app could not add the rule. */
  manualCommand?: string;
}

export interface RepairWindowsLoopbackFirewallOptions {
  /** The executable that listens on loopback; the gateway runs as the same one. */
  programPath: string;
  platform?: NodeJS.Platform;
  addRule?: (programPath: string) => Promise<LoopbackFirewallRuleResult>;
  detectBlock?: () => Promise<LoopbackBlockCheck>;
}

export async function repairWindowsLoopbackFirewall(
  options: RepairWindowsLoopbackFirewallOptions,
): Promise<LoopbackFirewallRepairResult> {
  if ((options.platform ?? process.platform) !== 'win32') {
    return { outcome: OpenClawLoopbackRepairOutcome.Unsupported };
  }
  const addRule = options.addRule ?? addWindowsLoopbackFirewallRule;
  const detectBlock = options.detectBlock ?? (() => detectLoopbackBlock());

  console.log(`[LoopbackFirewall] adding rule "${WINDOWS_LOOPBACK_FIREWALL_RULE_NAME}" for ${options.programPath}`);
  const added = await addRule(options.programPath);
  if (added.code === WINDOWS_UAC_DECLINED_EXIT_CODE) {
    console.warn('[LoopbackFirewall] rule not added: the UAC prompt was declined');
    return { outcome: OpenClawLoopbackRepairOutcome.Cancelled };
  }
  if (added.code !== 0) {
    const stderr = added.stderr.trim();
    const detail = `exit ${added.code}${stderr ? `: ${stderr}` : ''}`;
    console.error(`[LoopbackFirewall] rule not added (${detail})`);
    return {
      outcome: OpenClawLoopbackRepairOutcome.Failed,
      detail,
      manualCommand: formatLoopbackFirewallManualCommand(options.programPath),
    };
  }

  const check = await detectBlock();
  if (check.blocked) {
    console.warn(`[LoopbackFirewall] rule added, but loopback is still dropped (${check.last.code})`);
    return { outcome: OpenClawLoopbackRepairOutcome.StillBlocked, detail: check.last.code };
  }
  console.log('[LoopbackFirewall] rule added; loopback self-test passes');
  return { outcome: OpenClawLoopbackRepairOutcome.Repaired };
}
