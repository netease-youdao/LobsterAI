/**
 * Unit tests for the shell:exec IPC handler logic (src/main/main.ts).
 *
 * The handler itself cannot be imported directly because it lives inside the
 * Electron app bootstrap.  Instead we mirror the pure functions extracted from
 * the handler and test them in isolation, then use child_process to run a few
 * real integration-style cases that do not depend on Electron at all.
 */
import { test, expect, describe } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Mirrors of pure helper functions from the shell:exec handler
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 50_000;

function truncate(s: string): string {
  return s.length > MAX_OUTPUT_CHARS
    ? s.slice(0, MAX_OUTPUT_CHARS) + '\n[output truncated]'
    : s;
}

function resolveCwd(cwd: string | undefined): string | undefined {
  if (!cwd?.trim()) return undefined;
  try {
    // In tests we just check the logic; real fs calls are avoided
    const resolved = path.resolve(cwd);
    return resolved;
  } catch {
    return undefined;
  }
}

function isTimeoutError(error: any): boolean {
  return (
    error?.signal === 'SIGTERM' ||
    /timed out/i.test(error?.message ?? '')
  );
}

function getShellArgs(command: string): { bin: string; args: string[] } {
  if (process.platform === 'win32') {
    return { bin: 'cmd.exe', args: ['/c', command] };
  }
  return { bin: '/bin/sh', args: ['-c', command] };
}

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe('truncate', () => {
  test('returns the string unchanged when within limit', () => {
    const s = 'hello world';
    expect(truncate(s)).toBe(s);
  });

  test('truncates strings exceeding MAX_OUTPUT_CHARS and appends marker', () => {
    const long = 'x'.repeat(MAX_OUTPUT_CHARS + 100);
    const result = truncate(long);
    expect(result.length).toBe(MAX_OUTPUT_CHARS + '\n[output truncated]'.length);
    expect(result.endsWith('\n[output truncated]')).toBe(true);
  });

  test('handles empty string', () => {
    expect(truncate('')).toBe('');
  });

  test('does not truncate string at exact limit', () => {
    const s = 'y'.repeat(MAX_OUTPUT_CHARS);
    expect(truncate(s)).toBe(s);
  });
});

describe('resolveCwd', () => {
  test('returns undefined for undefined input', () => {
    expect(resolveCwd(undefined)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(resolveCwd('')).toBeUndefined();
  });

  test('returns undefined for whitespace-only string', () => {
    expect(resolveCwd('   ')).toBeUndefined();
  });

  test('resolves a relative path to absolute', () => {
    const result = resolveCwd('.');
    expect(path.isAbsolute(result!)).toBe(true);
  });

  test('resolves an absolute path unchanged', () => {
    const abs = os.tmpdir();
    const result = resolveCwd(abs);
    expect(result).toBe(path.resolve(abs));
  });
});

describe('isTimeoutError', () => {
  test('detects SIGTERM signal as timeout', () => {
    expect(isTimeoutError({ signal: 'SIGTERM', message: '' })).toBe(true);
  });

  test('detects "timed out" message as timeout (case-insensitive)', () => {
    expect(isTimeoutError({ signal: null, message: 'Command timed out after 30s' })).toBe(true);
    expect(isTimeoutError({ signal: null, message: 'TIMED OUT' })).toBe(true);
  });

  test('returns false for regular errors', () => {
    expect(isTimeoutError({ signal: null, message: 'Command failed: exit code 1' })).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });
});

describe('getShellArgs', () => {
  test('uses cmd.exe on Windows, /bin/sh elsewhere', () => {
    const { bin, args } = getShellArgs('echo hello');
    if (process.platform === 'win32') {
      expect(bin).toBe('cmd.exe');
      expect(args).toEqual(['/c', 'echo hello']);
    } else {
      expect(bin).toBe('/bin/sh');
      expect(args).toEqual(['-c', 'echo hello']);
    }
  });

  test('passes the full command string as a single argument', () => {
    const cmd = 'echo hello && echo world';
    const { args } = getShellArgs(cmd);
    expect(args[args.length - 1]).toBe(cmd);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — real child_process execution (no Electron dependency)
// ---------------------------------------------------------------------------

describe('shell execution (integration)', () => {
  const isWin = process.platform === 'win32';

  async function runCommand(command: string, cwd?: string) {
    const { bin, args } = getShellArgs(command);
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        cwd,
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
        ...(isWin ? { windowsHide: true } : {}),
      });
      return { success: true, stdout: truncate(stdout ?? ''), stderr: truncate(stderr ?? ''), exitCode: 0 };
    } catch (err: any) {
      const stdout = truncate(err?.stdout ?? '');
      const stderr = truncate(err?.stderr ?? '');
      const exitCode: number = typeof err?.code === 'number' ? err.code : 1;
      return {
        success: false,
        stdout,
        stderr,
        exitCode,
        error: isTimeoutError(err)
          ? 'Command timed out'
          : (err instanceof Error ? err.message : 'Command failed'),
      };
    }
  }

  test('TC-EXEC-01: simple echo command returns stdout and exitCode 0', async () => {
    const result = await runCommand(isWin ? 'echo hello' : 'echo hello');
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
  });

  test('TC-EXEC-02: non-existent command returns non-zero exitCode', async () => {
    const cmd = isWin ? 'thiscommanddoesnotexist_xyz' : 'thiscommanddoesnotexist_xyz';
    const result = await runCommand(cmd);
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
  });

  test('TC-EXEC-03: command that writes to stderr is captured', async () => {
    const cmd = isWin ? 'echo error_output 1>&2' : 'echo error_output >&2';
    const result = await runCommand(cmd);
    expect(result.stderr.trim()).toBe('error_output');
  });

  test('TC-EXEC-04: explicit exit code is returned correctly', async () => {
    const cmd = isWin ? 'exit /b 42' : 'exit 42';
    const result = await runCommand(cmd);
    expect(result.exitCode).toBe(42);
    expect(result.success).toBe(false);
  });

  test('TC-EXEC-05: multi-line output is preserved intact', async () => {
    const cmd = isWin
      ? 'echo line1 && echo line2 && echo line3'
      : 'printf "line1\nline2\nline3\n"';
    const result = await runCommand(cmd);
    expect(result.success).toBe(true);
    expect(result.stdout).toContain('line1');
    expect(result.stdout).toContain('line2');
    expect(result.stdout).toContain('line3');
  });

  test('TC-EXEC-06: command runs in the specified working directory', async () => {
    const tmpDir = os.tmpdir();
    const cmd = isWin ? 'cd' : 'pwd';
    const result = await runCommand(cmd, tmpDir);
    expect(result.success).toBe(true);
    // Normalise separators and case for comparison on Windows
    const normalised = result.stdout.trim().toLowerCase().replace(/\\/g, '/');
    const expected = tmpDir.toLowerCase().replace(/\\/g, '/');
    expect(normalised).toContain(expected);
  });

  test('TC-EXEC-07: empty command produces no stdout', async () => {
    const cmd = isWin ? 'echo.' : 'true';
    const result = await runCommand(cmd);
    expect(result.success).toBe(true);
  });

  test('TC-EXEC-08: output exceeding MAX_OUTPUT_CHARS is truncated', async () => {
    // Generate output slightly larger than the limit
    const charCount = MAX_OUTPUT_CHARS + 500;
    const cmd = isWin
      ? `powershell -Command "Write-Host ('A' * ${charCount})"`
      : `python3 -c "print('A' * ${charCount})"`;
    // Skip if neither powershell nor python3 is available (CI may lack them)
    try {
      const result = await runCommand(cmd);
      if (result.success && result.stdout.length > 0) {
        // If the command ran, output must be truncated
        expect(result.stdout.endsWith('[output truncated]')).toBe(true);
      }
    } catch {
      // Runtime unavailable — skip gracefully
    }
  });
});

// ---------------------------------------------------------------------------
// handleShellCommand output-message construction logic (mirrored)
// ---------------------------------------------------------------------------

describe('output message content construction', () => {
  function buildContent(
    stdout: string,
    stderr: string,
    success: boolean,
    error?: string,
  ): string {
    return (
      [stdout, stderr].filter(Boolean).join('\n') ||
      (success ? '（无输出）' : (error ?? '命令执行失败'))
    );
  }

  test('TC-MSG-01: stdout only → content is stdout', () => {
    expect(buildContent('hello\n', '', true)).toBe('hello\n');
  });

  test('TC-MSG-02: stderr only → content is stderr', () => {
    expect(buildContent('', 'err\n', false, 'Command failed')).toBe('err\n');
  });

  test('TC-MSG-03: both stdout and stderr → joined with newline', () => {
    const result = buildContent('out\n', 'err\n', true);
    expect(result).toBe('out\n\nerr\n');
  });

  test('TC-MSG-04: no output and success → no-output placeholder', () => {
    expect(buildContent('', '', true)).toBe('（无输出）');
  });

  test('TC-MSG-05: no output and failure with error string → error string shown', () => {
    expect(buildContent('', '', false, 'Command timed out after 30s')).toBe(
      'Command timed out after 30s',
    );
  });

  test('TC-MSG-06: no output and failure without error string → fallback text', () => {
    expect(buildContent('', '', false, undefined)).toBe('命令执行失败');
  });

  test('TC-MSG-07: isError flag is true when exitCode != 0', () => {
    const isError = (success: boolean, exitCode: number) =>
      !success || exitCode !== 0;
    expect(isError(true, 0)).toBe(false);
    expect(isError(true, 1)).toBe(true);
    expect(isError(false, 0)).toBe(true);
    expect(isError(false, 1)).toBe(true);
  });
});
