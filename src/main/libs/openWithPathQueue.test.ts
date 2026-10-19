import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { AppIpcChannel } from '../../shared/app/constants';
import { collectOpenWithArgv, OpenWithPathQueue, type OpenWithPathQueueTarget } from './openWithPathQueue';

function createTarget(): { target: OpenWithPathQueueTarget; sent: string[]; destroy: () => void } {
  const sent: string[] = [];
  let destroyed = false;
  return {
    sent,
    destroy: () => {
      destroyed = true;
    },
    target: {
      isDestroyed: () => destroyed,
      send: channel => {
        sent.push(channel);
      },
    },
  };
}

describe('OpenWithPathQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('notifies once for a burst of open-file events and hands over every path', () => {
    const { target, sent } = createTarget();
    const queue = new OpenWithPathQueue({ getTarget: () => target });

    const startsBurst = [
      queue.enqueue('/Users/me/a.png'),
      queue.enqueue('/Users/me/b.pdf'),
      queue.enqueue('/Users/me/Projects'),
    ];
    expect(startsBurst).toEqual([true, false, false]);
    expect(sent).toEqual([]);

    vi.runAllTimers();

    expect(sent).toEqual([AppIpcChannel.OpenWithPathsAvailable]);
    expect(queue.consume()).toEqual(['/Users/me/a.png', '/Users/me/b.pdf', '/Users/me/Projects']);
    expect(queue.consume()).toEqual([]);
    expect(queue.enqueue('/Users/me/c.txt')).toBe(true);
  });

  test('keeps paths queued while no renderer can be notified', () => {
    const queue = new OpenWithPathQueue({ getTarget: () => null });

    queue.enqueue('/Users/me/a.png');
    vi.runAllTimers();

    expect(queue.consume()).toEqual(['/Users/me/a.png']);
  });

  test('does not notify a destroyed renderer', () => {
    const { target, sent, destroy } = createTarget();
    const queue = new OpenWithPathQueue({ getTarget: () => target });

    destroy();
    queue.enqueue('/Users/me/a.png');
    vi.runAllTimers();

    expect(sent).toEqual([]);
    expect(queue.consume()).toEqual(['/Users/me/a.png']);
  });

  test('skips the notification when the renderer already took the paths', () => {
    const { target, sent } = createTarget();
    const queue = new OpenWithPathQueue({ getTarget: () => target });

    queue.enqueue('/Users/me/a.png');
    expect(queue.consume()).toEqual(['/Users/me/a.png']);
    vi.runAllTimers();

    expect(sent).toEqual([]);
  });

  test('drops duplicate and relative paths', () => {
    const queue = new OpenWithPathQueue({ getTarget: () => null });

    queue.enqueue('/Users/me/a.png');
    queue.enqueue('/Users/me/a.png');
    expect(queue.enqueue('relative/b.png')).toBe(false);
    expect(queue.enqueue('')).toBe(false);

    expect(queue.consume()).toEqual(['/Users/me/a.png']);
  });
});

describe('collectOpenWithArgv', () => {
  const existing = new Set([
    'C:\\Users\\me\\Documents\\季度报告.docx',
    'C:\\Users\\me\\Downloads\\photo 1.png',
    'C:\\work\\notes.md',
    'C:\\repo',
  ]);
  const isExistingPath = (filePath: string) => existing.has(filePath);
  const devElectron = 'C:\\repo\\node_modules\\electron\\dist\\electron.exe';

  test('takes the paths Explorer passes to the packaged exe', () => {
    const entries = collectOpenWithArgv(
      ['C:\\Program Files\\LobsterAI\\LobsterAI.exe', 'C:\\Users\\me\\Documents\\季度报告.docx'],
      { cwd: 'C:\\Windows\\System32', isExistingPath },
    );

    expect(entries).toEqual([
      { arg: 'C:\\Users\\me\\Documents\\季度报告.docx', path: 'C:\\Users\\me\\Documents\\季度报告.docx' },
    ]);
  });

  test('skips flags, deep links and missing items', () => {
    const entries = collectOpenWithArgv(
      [
        'C:\\Program Files\\LobsterAI\\LobsterAI.exe',
        '--allow-file-access-from-files',
        '--auto-launched',
        'lobsterai://auth/callback?code=abc',
        'C:\\Users\\me\\Downloads\\photo 1.png',
        'C:\\Users\\me\\gone.txt',
      ],
      { cwd: 'C:\\Windows\\System32', isExistingPath },
    );

    expect(entries.map(entry => entry.path)).toEqual(['C:\\Users\\me\\Downloads\\photo 1.png']);
  });

  test('skips the dev app path of a cold start', () => {
    const entries = collectOpenWithArgv(
      [devElectron, '.', '--remote-debugging-port=9333', 'C:\\Users\\me\\Downloads\\photo 1.png'],
      { cwd: 'C:\\repo', appPath: 'C:\\repo', isExistingPath },
    );

    expect(entries.map(entry => entry.path)).toEqual(['C:\\Users\\me\\Downloads\\photo 1.png']);
  });

  test('skips the dev app path after Chromium moves the switches ahead of it', () => {
    // A dev login callback, as second-instance delivers it.
    const deepLink = collectOpenWithArgv(
      [devElectron, '--allow-file-access-from-files', '--no-sandbox', 'c:\\Repo', 'lobsterai://auth/callback?code=abc'],
      { cwd: 'C:\\Users\\me', appPath: 'C:\\repo', isExistingPath },
    );
    const openWith = collectOpenWithArgv(
      [devElectron, '--e2e-flag', '--allow-file-access-from-files', 'C:\\repo', 'C:\\Users\\me\\Downloads\\photo 1.png'],
      { cwd: 'C:\\Users\\me', appPath: 'C:\\repo', isExistingPath },
    );

    expect(deepLink).toEqual([]);
    expect(openWith.map(entry => entry.path)).toEqual(['C:\\Users\\me\\Downloads\\photo 1.png']);
  });

  test('resolves relative arguments against the launching directory', () => {
    const entries = collectOpenWithArgv(
      ['C:\\Program Files\\LobsterAI\\LobsterAI.exe', 'notes.md'],
      { cwd: 'C:\\work', isExistingPath },
    );

    expect(entries).toEqual([{ arg: 'notes.md', path: 'C:\\work\\notes.md' }]);
  });
});
