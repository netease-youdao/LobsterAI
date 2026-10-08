import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), on: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: mocks }));

import type { BrowserWindow, IpcMainEvent } from 'electron';

import { MarkdownFileIpc } from '../../shared/artifactPreview/markdownEditing';
import { hasUnsafeMarkdownEdits, registerMarkdownEditingHandlers } from './markdownEditing';

const owners: EventEmitter[] = [];
afterEach(() => {
  owners.splice(0).forEach(owner => owner.emit('destroyed'));
  vi.clearAllMocks();
});

function setup() {
  const owner = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false });
  owners.push(owner);
  registerMarkdownEditingHandlers(() => ({ webContents: owner }) as BrowserWindow);
  const handler = mocks.on.mock.calls.find(([channel]) => channel === MarkdownFileIpc.SetUnsafeEdits)![1] as (
    event: IpcMainEvent, unsafe: unknown,
  ) => void;
  const report = (unsafe: unknown, sender = owner, senderFrame = owner.mainFrame) => handler({ sender, senderFrame } as IpcMainEvent, unsafe);
  return { owner, report };
}

describe('Markdown unsafe-edit reporting', () => {
  test('accepts only a boolean from the main window top-level frame', () => {
    const { owner, report } = setup();
    report(true, owner, {});
    report(true, Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false }));
    report('true');
    expect(hasUnsafeMarkdownEdits()).toBe(false);
    report(true);
    report(true);
    expect(hasUnsafeMarkdownEdits()).toBe(true);
    expect(owner.listenerCount('destroyed')).toBe(1);
    report(false);
    expect(hasUnsafeMarkdownEdits()).toBe(false);
  });

  test('keeps the guard during a cancelled reload and clears it after committed navigation or renderer exit', () => {
    const { owner, report } = setup();
    report(true);
    owner.emit('did-start-navigation');
    expect(hasUnsafeMarkdownEdits()).toBe(true);
    owner.emit('did-navigate');
    expect(hasUnsafeMarkdownEdits()).toBe(false);
    report(true);
    owner.emit('render-process-gone');
    expect(hasUnsafeMarkdownEdits()).toBe(false);
    report(true);
    owner.emit('destroyed');
    expect(hasUnsafeMarkdownEdits()).toBe(false);
  });
});
