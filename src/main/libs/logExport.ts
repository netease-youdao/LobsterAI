import fs from 'fs';
import { pipeline } from 'stream/promises';
import yazl from 'yazl';

export type LogArchiveEntry = {
  archiveName: string;
  filePath: string;
};

export type ExportLogsZipInput = {
  outputPath: string;
  entries: LogArchiveEntry[];
};

export type ExportLogsZipResult = {
  missingEntries: string[];
};

const EXPORT_TIMEOUT_MS = 30_000;

export async function exportLogsZip(input: ExportLogsZipInput): Promise<ExportLogsZipResult> {
  const zipFile = new yazl.ZipFile();
  const missingEntries: string[] = [];

  // Defensive: propagate ZipFile-level errors into the output stream so
  // pipeline() can reject immediately instead of hanging until timeout.
  // Cast needed because @types/yazl types outputStream as NodeJS.ReadableStream,
  // but the runtime value is a PassThrough which has destroy().
  zipFile.on('error', (err) => {
    (zipFile.outputStream as unknown as { destroy(err: Error): void }).destroy(err as Error);
  });

  for (const entry of input.entries) {
    try {
      // Single stat call: avoids redundant existsSync + statSync and reduces the
      // TOCTOU window compared to calling stat twice.
      const stat = fs.statSync(entry.filePath);
      if (stat.isFile()) {
        // Snapshot the file at its current size using a bounded read stream.
        // This avoids yazl's stat-vs-read race condition when the file is being
        // actively written to (e.g. the current-day log file or cowork.log during
        // an active session). yazl.addFile() stats the file eagerly but reads it
        // lazily; if more bytes are appended between stat and read, yazl emits a
        // size-mismatch error that pipeline() cannot catch, leaving a corrupt zip.
        const { size } = stat;
        if (size > 0) {
          const readStream = fs.createReadStream(entry.filePath, { start: 0, end: size - 1 });
          zipFile.addReadStream(readStream, entry.archiveName);
        } else {
          zipFile.addBuffer(Buffer.alloc(0), entry.archiveName);
        }
        continue;
      }
    } catch {
      // File does not exist or became inaccessible — treat as missing
    }
    missingEntries.push(entry.archiveName);
    zipFile.addBuffer(Buffer.alloc(0), entry.archiveName);
  }

  const outputStream = fs.createWriteStream(input.outputPath);

  const pipelinePromise = pipeline(zipFile.outputStream, outputStream);
  zipFile.end();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Log export timed out')), EXPORT_TIMEOUT_MS);
  });

  try {
    await Promise.race([pipelinePromise, timeoutPromise]);
  } catch (err) {
    // Destroy the write stream first to release the file descriptor. On Windows,
    // unlinkSync fails with EBUSY if the fd is still open. Swallow the subsequent
    // pipeline rejection that destroy() triggers.
    outputStream.destroy();
    pipelinePromise.catch(() => {});
    // Remove the partial zip so users don't find a corrupt file on disk.
    try { fs.unlinkSync(input.outputPath); } catch { /* ignore cleanup errors */ }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return { missingEntries };
}
