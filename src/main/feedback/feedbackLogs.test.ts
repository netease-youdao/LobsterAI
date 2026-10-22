import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { unzipSync } from 'fflate';
import { expect, test } from 'vitest';

import { collectFeedbackLogs } from './feedbackLogs';

test('uploads complete original export entries, including files larger than 1 MiB', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-log-test-'));
  try {
    const filePath = path.join(directory, 'main.log');
    const content = Buffer.from('Original diagnostic line\n'.repeat(60000));
    await fs.writeFile(filePath, content);
    const zip = unzipSync(await collectFeedbackLogs([
      { archiveName: 'main.log', filePath },
      { archiveName: 'missing.log', filePath: path.join(directory, 'missing.log') },
    ]));
    expect(Buffer.from(zip['main.log'])).toEqual(content);
    expect(zip['missing.log'].length).toBe(0);
    expect(Object.keys(zip)).toEqual(['main.log', 'missing.log']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
