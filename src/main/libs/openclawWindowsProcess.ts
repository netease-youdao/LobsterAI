import { execFile } from 'node:child_process';
import path from 'node:path';

export const WindowsProcessStatus = { Running: 'running', Gone: 'gone', Unknown: 'unknown', Stopped: 'stopped' } as const;
export type WindowsProcessStatus = typeof WindowsProcessStatus[keyof typeof WindowsProcessStatus];
export interface WindowsProcessIdentity {
  status: WindowsProcessStatus;
  pid: number;
  startTime?: number;
  creationTime?: string;
  executablePath?: string;
  args?: string[];
  parentPid?: number;
  parentAlive?: boolean;
  reason?: string;
}
const ProcessAction = { Inspect: 'inspect', Stop: 'stop' } as const;
const QUERY_TIMEOUT_MS = 15_000;

// Fixed program; requests are JSON on stdin, never interpolated into shell code.
// Keep the opened handle through identity validation, termination and exit wait.
const WINDOWS_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LobsterProcess {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint rights, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  public static long Creation(IntPtr handle) {
    long creation, exit, kernel, user;
    if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) throw new System.ComponentModel.Win32Exception();
    return creation;
  }
  public static string Image(IntPtr handle) {
    var buffer = new StringBuilder(32768); int size = buffer.Capacity;
    if (!QueryFullProcessImageName(handle, 0, buffer, ref size)) throw new System.ComponentModel.Win32Exception();
    return buffer.ToString();
  }
  public static string[] Args(string command) {
    int count; var pointer = CommandLineToArgvW(command, out count);
    if (pointer == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      var args = new string[count];
      for (int i=0; i<count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i*IntPtr.Size));
      return args;
    } finally { LocalFree(pointer); }
  }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = @{ pid = [int]$request.pid; status = 'unknown' }
$handle = [IntPtr]::Zero
try {
  $rights = [uint32]0x101000
  if ($request.action -eq 'stop') { $rights = $rights -bor 1 }
  $handle = [LobsterProcess]::OpenProcess($rights, $false, [int]$request.pid)
  if ($handle -eq [IntPtr]::Zero) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 87) { $result.status = 'gone' }
    else { $result.reason = "OpenProcess failed: $errorCode" }
  } elseif ([LobsterProcess]::WaitForSingleObject($handle, 0) -eq 0) {
    $result.status = 'gone'
  } else {
    $creation = [LobsterProcess]::Creation($handle)
    $result.creationTime = $creation.ToString()
    $result.startTime = [long]([DateTimeOffset]([DateTime]::FromFileTimeUtc($creation))).ToUnixTimeMilliseconds()
    $result.executablePath = [LobsterProcess]::Image($handle)
    $result.status = 'running'
    if ($request.action -eq 'stop') {
      if ($request.creationTime -cne $result.creationTime -or $request.executablePath -ine $result.executablePath) {
        throw 'Process identity changed before termination.'
      }
      if (-not [LobsterProcess]::TerminateProcess($handle, 1)) { throw 'TerminateProcess failed.' }
      if ([LobsterProcess]::WaitForSingleObject($handle, 5000) -ne 0) { throw 'Process exit was not confirmed.' }
      $result.status = 'stopped'
    } else {
      try {
        $entry = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$request.pid) -ErrorAction Stop
        $cimStart = [long]([DateTimeOffset]($entry.CreationDate.ToUniversalTime())).ToUnixTimeMilliseconds()
        if ($cimStart -ne $result.startTime) { throw 'Process changed during command-line lookup.' }
        if ($entry.CommandLine) { $result.args = @([LobsterProcess]::Args($entry.CommandLine)) }
        $result.parentPid = [int]$entry.ParentProcessId
        $parentHandle = [LobsterProcess]::OpenProcess(0x101000, $false, $result.parentPid)
        if ($parentHandle -eq [IntPtr]::Zero) {
          if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 87) { $result.parentAlive = $false }
        } else {
          try {
            $result.parentAlive = ([LobsterProcess]::WaitForSingleObject($parentHandle, 0) -ne 0) -and ([LobsterProcess]::Creation($parentHandle) -le $creation)
          } finally { [void][LobsterProcess]::CloseHandle($parentHandle) }
        }
      } catch { $result.reason = 'Command line or parent identity unavailable.' }
      if ([LobsterProcess]::WaitForSingleObject($handle, 0) -eq 0) { $result.status = 'gone' }
    }
  }
} catch {
  $result.status = 'unknown'
  $result.reason = $_.Exception.Message
} finally {
  if ($handle -ne [IntPtr]::Zero) { [void][LobsterProcess]::CloseHandle($handle) }
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
`;

async function query(request: { pid: number; action: string; creationTime?: string; executablePath?: string }): Promise<WindowsProcessIdentity> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(request.pid) || request.pid <= 0) {
    return { pid: request.pid, status: WindowsProcessStatus.Unknown, reason: 'Unsupported process query.' };
  }
  const configuredRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const systemRoot = /^[a-z]:[\\/]/i.test(configuredRoot) ? configuredRoot : 'C:\\Windows';
  const command = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    const child = execFile(command, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCRIPT], {
      windowsHide: true, encoding: 'utf8', timeout: QUERY_TIMEOUT_MS, maxBuffer: 128 * 1024,
    }, (error, stdout) => {
      try {
        if (error) throw error;
        const value = JSON.parse(stdout.replace(/^\uFEFF/, '')) as WindowsProcessIdentity;
        if (value.pid !== request.pid || !Object.values(WindowsProcessStatus).includes(value.status)) throw new Error('Invalid process response.');
        resolve(value);
      } catch (failure) {
        resolve({ pid: request.pid, status: WindowsProcessStatus.Unknown,
          reason: `Process query failed: ${(failure as NodeJS.ErrnoException).code ?? 'invalid response'}` });
      }
    });
    child.stdin?.on('error', () => { /* execFile reports a failed/closed probe */ });
    child.stdin?.end(JSON.stringify(request));
  });
}

export async function inspectWindowsProcess(pid: number): Promise<WindowsProcessIdentity> {
  const first = await query({ pid, action: ProcessAction.Inspect });
  return first.status === WindowsProcessStatus.Unknown ? query({ pid, action: ProcessAction.Inspect }) : first;
}

export async function stopVerifiedWindowsProcess(identity: WindowsProcessIdentity): Promise<WindowsProcessIdentity> {
  if (identity.status !== WindowsProcessStatus.Running || !identity.creationTime || !identity.executablePath) {
    throw new Error('Cannot stop a process without a verified creation identity and executable.');
  }
  return query({ pid: identity.pid, action: ProcessAction.Stop,
    creationTime: identity.creationTime, executablePath: identity.executablePath });
}
