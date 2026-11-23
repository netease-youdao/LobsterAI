import { describe, expect, test, vi } from 'vitest';

import { CompanionAppCategory } from '../../shared/desktopCompanion/appCategories';
import { CompanionContextClipboardKind } from '../../shared/desktopCompanion/contextActions';
import { CompanionFileKind } from '../../shared/desktopCompanion/fileKinds';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  clipboard: { availableFormats: () => [], has: () => false, readImage: () => ({ isEmpty: () => true }), readText: () => '' },
  systemPreferences: { isTrustedAccessibilityClient: () => false },
}));
vi.mock('../i18n', () => ({ t: (key: string) => key }));

const {
  CompanionContextInspector,
  macActiveDocumentScript,
  parseActiveDocumentOutput,
  windowsActiveDocumentScript,
} = await import('./companionContextInspector');

describe('CompanionContextInspector', () => {
  test('ignores startup baseline clipboard and surfaces newly copied eligible text', () => {
    let probe: any = {
      kind: CompanionContextClipboardKind.Text,
      fingerprint: 'txt:baseline',
      text: 'This baseline text was already sitting on the clipboard before the app launched.',
    };
    const inspector = new CompanionContextInspector({
      readClipboard: () => probe,
      now: () => 1_000,
    });
    inspector.captureBaselineClipboard();

    const first = inspector.inspectSync({ appId: 'com.tencent.xinwechat', category: CompanionAppCategory.Chat }, true);
    expect(first?.clipboard).toBeUndefined();

    probe = {
      kind: CompanionContextClipboardKind.Text,
      fingerprint: 'txt:fresh',
      text: '张三：下周二前完成新版悬浮球端到端回归测试。\n李四：好的，我今天先跑自动化验证。',
    };
    const second = inspector.inspectSync({ appId: 'com.tencent.xinwechat', category: CompanionAppCategory.Chat }, true);
    expect(second?.clipboard).toMatchObject({
      kind: CompanionContextClipboardKind.Text,
      fingerprint: 'txt:fresh',
      charCount: probe.text.length,
    });

    // Materializing consumes the fingerprint so it is not surfaced again on the next opening.
    const materialized = inspector.materializeClipboardText('txt:fresh');
    expect(materialized).toEqual({ text: probe.text, fingerprint: 'txt:fresh' });
    const third = inspector.inspectSync({ appId: 'com.tencent.xinwechat', category: CompanionAppCategory.Chat }, true);
    expect(third?.clipboard).toBeUndefined();
  });

  test('never surfaces concealed pasteboard items or items copied before leaving a password manager', () => {
    let probe: any = { kind: 'concealed' };
    const inspector = new CompanionContextInspector({ readClipboard: () => probe });
    expect(inspector.inspectSync({ appId: 'com.google.Chrome', category: CompanionAppCategory.Browser }, true)?.clipboard).toBeUndefined();

    probe = {
      kind: CompanionContextClipboardKind.Text,
      fingerprint: 'txt:from-1password',
      text: 'This note happened to be copied inside 1Password and must never be offered.',
    };
    inspector.suppressCurrentClipboard();
    expect(inspector.inspectSync({ appId: 'com.google.Chrome', category: CompanionAppCategory.Browser }, true)?.clipboard).toBeUndefined();
    expect(inspector.materializeClipboardText('txt:from-1password')).toBeNull();
  });

  test('blocks all context snapshots in Password and Meeting apps', () => {
    const inspector = new CompanionContextInspector({
      readClipboard: () => ({
        kind: CompanionContextClipboardKind.Image,
        fingerprint: 'img:shot',
        width: 400,
        height: 300,
        toPNG: () => Buffer.from([1, 2, 3]),
      }),
    });
    expect(inspector.inspectSync({ appId: 'com.1password.1password', category: CompanionAppCategory.Password }, true)).toBeNull();
    expect(inspector.inspectSync({ appId: 'us.zoom.xos', category: CompanionAppCategory.Meeting }, true)).toBeNull();
  });

  test('materializes clipboard images to temp attachments and consumes their fingerprint', async () => {
    const saveClipboardImage = vi.fn(async () => '/tmp/lobsterai/attachments/clipboard-1.png');
    const inspector = new CompanionContextInspector({
      readClipboard: () => ({
        kind: CompanionContextClipboardKind.Image,
        fingerprint: 'img:abc',
        width: 800,
        height: 600,
        toPNG: () => Buffer.from('png-bytes'),
      }),
      saveClipboardImage,
    });
    const snap = inspector.inspectSync({ appId: 'com.google.Chrome', category: CompanionAppCategory.Browser }, true);
    expect(snap?.clipboard).toMatchObject({ kind: CompanionContextClipboardKind.Image, fingerprint: 'img:abc', width: 800, height: 600 });

    const materialized = await inspector.materializeClipboardImage('img:abc');
    expect(saveClipboardImage).toHaveBeenCalledTimes(1);
    expect(materialized).toEqual({
      fingerprint: 'img:abc',
      attachment: {
        path: '/tmp/lobsterai/attachments/clipboard-1.png',
        name: 'desktopCompanionClipboardImageName.png',
        isImage: true,
        isDirectory: false,
      },
    });
    // Consumed after materialization.
    expect(inspector.inspectSync({ appId: 'com.google.Chrome', category: CompanionAppCategory.Browser }, true)?.clipboard).toBeUndefined();
  });

  test('dismissing a clipboard item hides it from future inspections', () => {
    const inspector = new CompanionContextInspector({
      readClipboard: () => ({
        kind: CompanionContextClipboardKind.Image,
        fingerprint: 'img:dismiss-me',
        width: 300,
        height: 200,
        toPNG: () => Buffer.from([1]),
      }),
    });
    expect(inspector.inspectSync({ appId: 'com.apple.Safari', category: CompanionAppCategory.Browser }, true)?.clipboard?.fingerprint).toBe('img:dismiss-me');
    inspector.dismissClipboard('img:dismiss-me');
    expect(inspector.inspectSync({ appId: 'com.apple.Safari', category: CompanionAppCategory.Browser }, true)?.clipboard).toBeUndefined();
  });

  test('resolves verified local files and folders while rejecting missing or sensitive paths', async () => {
    const statPath = vi.fn((p: string) => {
      if (p === '/Users/alice/Documents/Q3 预算.xlsx') return { isDirectory: false };
      if (p === '/Users/alice/Downloads') return { isDirectory: true };
      return null;
    });
    const queryActiveFile = vi.fn(async (appId: string) => {
      if (appId === 'com.microsoft.Excel') return 'file:///Users/alice/Documents/Q3%20%E9%A2%84%E7%AE%97.xlsx';
      if (appId === 'com.apple.finder') return 'file:///Users/alice/Downloads/';
      if (appId === 'com.microsoft.VSCode') return 'file:///Users/alice/.env';
      return 'file:///Users/alice/missing.pdf';
    });
    const inspector = new CompanionContextInspector({ queryActiveFile, statPath });

    await expect(inspector.resolveActiveFile({ appId: 'com.microsoft.Excel', category: CompanionAppCategory.Spreadsheet, pid: 123 })).resolves.toEqual({
      path: '/Users/alice/Documents/Q3 预算.xlsx',
      name: 'Q3 预算.xlsx',
      kind: CompanionFileKind.Spreadsheet,
      isDirectory: false,
      isImage: false,
    });
    await expect(inspector.resolveActiveFile({ appId: 'com.apple.finder', category: CompanionAppCategory.Files, pid: 456 })).resolves.toEqual({
      path: '/Users/alice/Downloads',
      name: 'Downloads',
      kind: CompanionFileKind.Folder,
      isDirectory: true,
      isImage: false,
    });
    await expect(inspector.resolveActiveFile({ appId: 'com.microsoft.VSCode', category: CompanionAppCategory.Code })).resolves.toBeNull();
    await expect(inspector.resolveActiveFile({ appId: 'com.apple.Preview', category: CompanionAppCategory.Pdf })).resolves.toBeNull();
    // Browser is skipped without even querying OS.
    queryActiveFile.mockClear();
    await expect(inspector.resolveActiveFile({ appId: 'com.google.Chrome', category: CompanionAppCategory.Browser })).resolves.toBeNull();
    expect(queryActiveFile).not.toHaveBeenCalled();
  });

  test('builds macOS AX and Windows Shell/COM query scripts and parses marked output', () => {
    const macScript = macActiveDocumentScript('com.apple.finder', 629);
    expect(macScript).toContain('AXDocument');
    expect(macScript).toContain('var pid = 629;');
    expect(windowsActiveDocumentScript('explorer.exe')).toContain('Shell.Application');
    expect(windowsActiveDocumentScript('excel.exe')).toContain('Excel.Application');
    expect(windowsActiveDocumentScript('chrome.exe')).toBeNull();
    expect(parseActiveDocumentOutput('noise\n@@LOBSTER_CTX {"path":"file:///tmp/a.pdf"}\n')).toBe('file:///tmp/a.pdf');
    expect(parseActiveDocumentOutput('@@LOBSTER_CTX {"path":null}')).toBeNull();
    expect(parseActiveDocumentOutput('broken output')).toBeNull();
  });
});
