import crypto from 'crypto';
import fs from 'fs';

const WINDOWS_REPLACE_FALLBACK_ERROR_CODES = new Set(['EACCES', 'EEXIST', 'EPERM']);

const isReplaceFallbackError = (error: unknown): boolean => (
  error instanceof Error
  && 'code' in error
  && typeof error.code === 'string'
  && WINDOWS_REPLACE_FALLBACK_ERROR_CODES.has(error.code)
);

const removeFileBestEffort = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // A leftover temp/backup is safer than masking the write result.
  }
};

const writeFileAndSync = (
  filePath: string,
  content: string,
  mode: number,
  flag: 'w' | 'wx' = 'w',
): void => {
  const fileDescriptor = fs.openSync(filePath, flag, mode);
  try {
    fs.writeFileSync(fileDescriptor, content, 'utf8');
    fs.fsyncSync(fileDescriptor);
  } finally {
    fs.closeSync(fileDescriptor);
  }
  fs.chmodSync(filePath, mode);
};

/**
 * Replace an existing text file atomically where the platform permits it.
 * Windows can reject rename-over-existing with EEXIST/EPERM/EACCES; in that
 * case retain a recovery copy while performing a flushed direct overwrite,
 * and restore the original content if the overwrite fails.
 */
export function safelyReplaceTextFileSync(params: {
  filePath: string;
  content: string;
  mode: number;
  tempLabel: string;
}): void {
  const token = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const tempPath = `${params.filePath}.${params.tempLabel}-temp-${token}`;
  const backupPath = `${params.filePath}.${params.tempLabel}-backup-${token}`;
  let preserveBackup = false;

  try {
    writeFileAndSync(tempPath, params.content, params.mode, 'wx');

    try {
      fs.renameSync(tempPath, params.filePath);
      return;
    } catch (error) {
      if (!isReplaceFallbackError(error) || !fs.existsSync(params.filePath)) {
        throw error;
      }
    }

    const originalMode = fs.statSync(params.filePath).mode & 0o777;
    fs.copyFileSync(params.filePath, backupPath, fs.constants.COPYFILE_EXCL);
    const backupDescriptor = fs.openSync(backupPath, 'r+');
    try {
      fs.fsyncSync(backupDescriptor);
    } finally {
      fs.closeSync(backupDescriptor);
    }
    const originalContent = fs.readFileSync(backupPath, 'utf8');
    try {
      writeFileAndSync(params.filePath, params.content, params.mode);
    } catch (writeError) {
      try {
        writeFileAndSync(params.filePath, originalContent, originalMode);
      } catch (restoreError) {
        preserveBackup = true;
        const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(
          `File replacement failed (${writeMessage}) and backup restoration failed (${restoreMessage}); recovery copy: ${backupPath}`,
          { cause: writeError },
        );
      }
      throw writeError;
    }
  } finally {
    removeFileBestEffort(tempPath);
    if (!preserveBackup) removeFileBestEffort(backupPath);
  }
}
