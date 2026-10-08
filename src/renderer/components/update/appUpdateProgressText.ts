import type { AppUpdateDownloadProgress } from '../../../shared/appUpdate/constants';

const KB = 1024;
const MB = KB * 1024;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

export function formatSpeed(bytesPerSecond: number | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * One-line transfer summary such as `12.3 MB / 84.0 MB · 2.1 MB/s`.
 * Total and speed are optional; `null` means nothing has been received yet.
 */
export function formatTransferProgress(progress: AppUpdateDownloadProgress | null): string | null {
  if (!progress) return null;
  const size = progress.total != null
    ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
    : formatBytes(progress.received);
  const speed = formatSpeed(progress.speed);
  return speed ? `${size} · ${speed}` : size;
}
