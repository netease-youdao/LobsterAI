import { expect, test } from 'vitest';

import { MediaDownloadCoordinator } from './mediaDownloadCoordinator';

test('foreground and background share a download and can retry after failure', async () => {
  const coordinator = new MediaDownloadCoordinator<string>();
  let reject!: (error: Error) => void;
  const first = coordinator.run('session:url', () => new Promise<string>((_resolve, fail) => { reject = fail; }));
  const second = coordinator.run('session:url', () => { throw new Error('duplicate download'); });
  expect(second).toBe(first);
  reject(new Error('network offline'));
  await expect(first).rejects.toThrow('network offline');
  await expect(coordinator.run('session:url', async () => 'saved')).resolves.toBe('saved');
});
