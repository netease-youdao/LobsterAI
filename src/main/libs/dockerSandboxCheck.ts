import { spawnSync } from 'child_process';

const DOCKER_INFO_TIMEOUT_MS = 12_000;

export type DockerSandboxCheckCode =
  | 'ok'
  | 'cli_missing'
  | 'daemon_unavailable'
  | 'timeout'
  | 'error';

export type DockerSandboxCheckResult = {
  ok: boolean;
  code: DockerSandboxCheckCode;
  serverVersion?: string;
  errorDetail?: string;
};

/**
 * Probes whether Docker CLI exists and the daemon responds (required for OpenClaw sandbox).
 * Runs synchronously; intended for IPC handlers only (short-lived).
 */
export function checkDockerForSandbox(): DockerSandboxCheckResult {
  const result = spawnSync(
    'docker',
    ['info', '-f', '{{.ServerVersion}}'],
    {
      encoding: 'utf8',
      timeout: DOCKER_INFO_TIMEOUT_MS,
      windowsHide: true,
    },
  );

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { ok: false, code: 'cli_missing' };
    }
    return {
      ok: false,
      code: 'error',
      errorDetail: result.error.message,
    };
  }

  if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
    return { ok: false, code: 'timeout' };
  }

  const stderr = (result.stderr || '').trim();
  const stdout = (result.stdout || '').trim();

  if (result.status !== 0) {
    if (stderr.toLowerCase().includes('cannot connect') || stderr.toLowerCase().includes('docker daemon')) {
      return { ok: false, code: 'daemon_unavailable', errorDetail: stderr || undefined };
    }
    return {
      ok: false,
      code: 'daemon_unavailable',
      errorDetail: stderr || stdout || undefined,
    };
  }

  if (!stdout) {
    return { ok: false, code: 'daemon_unavailable' };
  }

  return { ok: true, code: 'ok', serverVersion: stdout };
}
