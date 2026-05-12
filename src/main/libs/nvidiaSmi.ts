import { execFile } from 'child_process';
import { promisify } from 'util';

import type { NvidiaGpuInfo, NvidiaSmiSnapshot } from '../../shared/hardware';

const execFileAsync = promisify(execFile);
const NVIDIA_SMI_TIMEOUT_MS = 2500;
const NVIDIA_SMI_MAX_BUFFER = 128 * 1024;

const NVIDIA_SMI_QUERY_ARGS = [
  '--query-gpu=index,name,memory.total,memory.free',
  '--format=csv,noheader,nounits',
];

type ExecFileRunner = (
  file: string,
  args: string[],
  options: {
    encoding: 'utf8';
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
  },
) => Promise<{ stdout: string; stderr: string }>;

export async function getNvidiaSmiSnapshot(
  runner: ExecFileRunner = execFileAsync as ExecFileRunner,
): Promise<NvidiaSmiSnapshot> {
  const checkedAt = new Date().toISOString();
  try {
    const { stdout } = await runner('nvidia-smi', NVIDIA_SMI_QUERY_ARGS, {
      encoding: 'utf8',
      maxBuffer: NVIDIA_SMI_MAX_BUFFER,
      timeout: NVIDIA_SMI_TIMEOUT_MS,
      windowsHide: true,
    });
    const gpus = parseNvidiaSmiCsv(stdout);
    if (gpus.length === 0) {
      return unavailableSnapshot(checkedAt, 'nvidia-smi returned no GPU rows');
    }
    return {
      source: 'nvidia-smi',
      available: true,
      checkedAt,
      gpus,
    };
  } catch (error) {
    return unavailableSnapshot(checkedAt, normalizeNvidiaSmiError(error));
  }
}

export function parseNvidiaSmiCsv(output: string): NvidiaGpuInfo[] {
  return output
    .split(/\r?\n/)
    .map((line) => parseNvidiaSmiLine(line))
    .filter((gpu): gpu is NvidiaGpuInfo => Boolean(gpu));
}

function parseNvidiaSmiLine(line: string): NvidiaGpuInfo | null {
  const parts = line.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 4) return null;

  const index = Number(parts[0]);
  const memoryFreeMiB = parseMemoryMiB(parts[parts.length - 1]);
  const memoryTotalMiB = parseMemoryMiB(parts[parts.length - 2]);
  const name = parts.slice(1, -2).join(', ').trim();

  if (!Number.isInteger(index) || index < 0 || memoryTotalMiB === null) {
    return null;
  }

  return {
    index,
    name: name || `GPU ${index}`,
    memoryTotalMiB,
    ...(memoryFreeMiB !== null ? { memoryFreeMiB } : {}),
  };
}

function parseMemoryMiB(value: string): number | null {
  const normalized = value.replace(/\s*MiB$/i, '').trim();
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

function unavailableSnapshot(checkedAt: string, error: string): NvidiaSmiSnapshot {
  return {
    source: 'nvidia-smi',
    available: false,
    checkedAt,
    gpus: [],
    error,
  };
}

function normalizeNvidiaSmiError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const maybeNodeError = error as {
      code?: string;
      killed?: boolean;
      message?: string;
      signal?: string;
    };
    if (maybeNodeError.code === 'ENOENT') return 'nvidia-smi not found';
    if (maybeNodeError.killed || maybeNodeError.signal === 'SIGTERM') return 'nvidia-smi timed out';
    if (maybeNodeError.message) return maybeNodeError.message;
  }
  return String(error || 'nvidia-smi failed');
}
