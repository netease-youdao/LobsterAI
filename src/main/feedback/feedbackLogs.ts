import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FEEDBACK_LIMITS } from '../../shared/feedback/constants';
import { exportLogsZip, type LogArchiveEntry } from '../libs/logExport';

export class FeedbackLogsTooLargeError extends Error {}

// Reuse Settings → Export logs, with a private temporary ZIP cleaned up on all paths.
export async function collectFeedbackLogs(entries: LogArchiveEntry[]): Promise<Buffer> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobsterai-feedback-'));
  const outputPath = path.join(directory, 'diagnostics.zip');
  try {
    await exportLogsZip({ outputPath, entries });
    if ((await fs.stat(outputPath)).size > FEEDBACK_LIMITS.logBytes) {
      throw new FeedbackLogsTooLargeError('Feedback log archive exceeds limit');
    }
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
