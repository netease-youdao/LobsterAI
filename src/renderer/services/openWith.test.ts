import { describe, expect, test } from 'vitest';

import { type OpenWithPathStat, resolveOpenWithAttachments } from './openWith';

const statFrom = (entries: Record<string, OpenWithPathStat>) =>
  async (filePath: string): Promise<OpenWithPathStat> => entries[filePath] ?? { success: false };

describe('resolveOpenWithAttachments', () => {
  test('maps files, images and folders to draft attachments in order', async () => {
    const attachments = await resolveOpenWithAttachments(
      ['/Users/me/report.pdf', '/Users/me/Photo.PNG', '/Users/me/Projects'],
      statFrom({
        '/Users/me/report.pdf': { success: true, isFile: true },
        '/Users/me/Photo.PNG': { success: true, isFile: true },
        '/Users/me/Projects': { success: true, isDirectory: true },
      }),
    );

    expect(attachments).toEqual([
      { path: '/Users/me/report.pdf', name: 'report.pdf' },
      { path: '/Users/me/Photo.PNG', name: 'Photo.PNG', isImage: true },
      { path: '/Users/me/Projects', name: 'Projects', isDirectory: true },
    ]);
  });

  test('skips paths that are missing, unreadable or neither file nor folder', async () => {
    const attachments = await resolveOpenWithAttachments(
      ['/Users/me/gone.txt', '/Users/me/locked.txt', '/dev/fifo', '/Users/me/kept.txt'],
      async filePath => {
        if (filePath === '/Users/me/locked.txt') throw new Error('EACCES');
        if (filePath === '/dev/fifo') return { success: true, isFile: false, isDirectory: false };
        if (filePath === '/Users/me/kept.txt') return { success: true, isFile: true };
        return { success: false };
      },
    );

    expect(attachments).toEqual([{ path: '/Users/me/kept.txt', name: 'kept.txt' }]);
  });
});
