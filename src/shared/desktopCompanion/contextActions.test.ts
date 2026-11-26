import { describe, expect, test } from 'vitest';

import { CompanionAppCategory } from './appCategories';
import {
  activeFileActionCopyKeys,
  clipboardTextPromptKey,
  COMPANION_MAX_CONTEXT_ACTIONS,
  CompanionContextActionId,
  CompanionContextActionKind,
  CompanionContextClipboardKind,
  type DesktopCompanionContextFile,
  type DesktopCompanionContextSnapshot,
  findCompanionContextAction,
  formatCompanionContextActionLabel,
  isCompanionContextActionId,
  isContextSuggestionsBlocked,
  isEligibleClipboardText,
  isSensitiveContextPath,
  looksLikeSecretText,
  parseLocalFileReference,
  resolveCompanionContextActions,
  resolveCompanionLauncherContextAction,
  shortenContextFileName,
  supportsActiveFileInspection,
} from './contextActions';
import { desktopCompanionTranslations } from './copy';
import { CompanionFileKind } from './fileKinds';

const SHEET_FILE: DesktopCompanionContextFile = {
  path: '/Users/alice/Documents/Q3-Sales-Report-2026.xlsx',
  name: 'Q3-Sales-Report-2026.xlsx',
  kind: CompanionFileKind.Spreadsheet,
  isDirectory: false,
  isImage: false,
};

const FOLDER_FILE: DesktopCompanionContextFile = {
  path: '/Users/alice/Downloads',
  name: 'Downloads',
  kind: CompanionFileKind.Folder,
  isDirectory: true,
  isImage: false,
};

describe('resolveCompanionContextActions', () => {
  test('stays completely silent for Password and Meeting apps even if context objects exist', () => {
    for (const category of [CompanionAppCategory.Password, CompanionAppCategory.Meeting]) {
      expect(isContextSuggestionsBlocked(category)).toBe(true);
      const snapshot: DesktopCompanionContextSnapshot = {
        capturedAt: 1000,
        appId: 'com.1password.1password',
        category,
        activeFile: SHEET_FILE,
        clipboard: { kind: CompanionContextClipboardKind.Image, fingerprint: 'img:1', width: 200, height: 120 },
      };
      expect(resolveCompanionContextActions(snapshot, category)).toEqual([]);
      expect(resolveCompanionLauncherContextAction(snapshot)).toBeNull();
    }
  });

  test('returns tailored P0 closed-loop actions for every supported app category including Code', () => {
    const categories: CompanionAppCategory[] = [
      CompanionAppCategory.Chat,
      CompanionAppCategory.Browser,
      CompanionAppCategory.Spreadsheet,
      CompanionAppCategory.Document,
      CompanionAppCategory.Pdf,
      CompanionAppCategory.Presentation,
      CompanionAppCategory.Code,
      CompanionAppCategory.Files,
      CompanionAppCategory.Mail,
      CompanionAppCategory.Calendar,
      CompanionAppCategory.Notes,
    ];
    for (const category of categories) {
      const actions = resolveCompanionContextActions(null, category);
      expect(actions.length, category).toBeGreaterThanOrEqual(2);
      expect(actions.length, category).toBeLessThanOrEqual(COMPANION_MAX_CONTEXT_ACTIONS);
      for (const action of actions) {
        expect(isCompanionContextActionId(action.id)).toBe(true);
        expect(desktopCompanionTranslations.zh).toHaveProperty(action.labelKey);
        expect(desktopCompanionTranslations.en).toHaveProperty(action.labelKey);
        if (action.promptKey) {
          expect(desktopCompanionTranslations.zh).toHaveProperty(action.promptKey);
          expect(desktopCompanionTranslations.en).toHaveProperty(action.promptKey);
        }
      }
    }
    expect(resolveCompanionContextActions(null, CompanionAppCategory.Code).map(a => a.id)).toEqual([
      CompanionContextActionId.CodeScreenshotDebug,
      CompanionContextActionId.CodeExplain,
    ]);
  });

  test('prioritizes P1 active file, skips redundant file pickers, and caps at 3 chips', () => {
    const snapshot: DesktopCompanionContextSnapshot = {
      capturedAt: 1000,
      appId: 'com.microsoft.Excel',
      category: CompanionAppCategory.Spreadsheet,
      activeFile: SHEET_FILE,
    };
    const actions = resolveCompanionContextActions(snapshot);
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({
      id: CompanionContextActionId.ActiveFilePrimary,
      kind: CompanionContextActionKind.ActiveFile,
      emphasis: true,
      fileName: SHEET_FILE.name,
    });
    expect(actions[1]).toMatchObject({
      id: CompanionContextActionId.ActiveFileAttach,
      kind: CompanionContextActionKind.ActiveFile,
    });
    // SpreadsheetPickAnalyze is skipped because the exact spreadsheet is already detected.
    expect(actions[2].id).toBe(CompanionContextActionId.SpreadsheetScreenshotChart);
  });

  test('includes P1 clipboard text or image chip and tailors clipboard prompt to foreground app', () => {
    const textSnapshot: DesktopCompanionContextSnapshot = {
      capturedAt: 1000,
      appId: 'com.tencent.xinwechat',
      category: CompanionAppCategory.Chat,
      clipboard: { kind: CompanionContextClipboardKind.Text, fingerprint: 'txt:abc', charCount: 240, preview: '会议纪要' },
    };
    const textActions = resolveCompanionContextActions(textSnapshot);
    expect(textActions[0]).toMatchObject({
      id: CompanionContextActionId.ClipboardText,
      kind: CompanionContextActionKind.Clipboard,
      emphasis: true,
      clipboardCharCount: 240,
      promptKey: clipboardTextPromptKey(CompanionAppCategory.Chat),
    });
    expect(textActions).toHaveLength(3);

    const imgSnapshot: DesktopCompanionContextSnapshot = {
      capturedAt: 1000,
      appId: 'com.apple.Safari',
      category: CompanionAppCategory.Browser,
      clipboard: { kind: CompanionContextClipboardKind.Image, fingerprint: 'img:xyz', width: 640, height: 480 },
    };
    expect(resolveCompanionContextActions(imgSnapshot)[0]).toMatchObject({
      id: CompanionContextActionId.ClipboardImage,
      kind: CompanionContextActionKind.Clipboard,
      clipboardKind: CompanionContextClipboardKind.Image,
    });
  });

  test('falls back to universal screenshot and file actions for Other/null foreground with no P1 context', () => {
    expect(resolveCompanionContextActions(null, null).map(a => a.id)).toEqual([
      CompanionContextActionId.UniversalScreenshot,
      CompanionContextActionId.UniversalPickFiles,
    ]);
    expect(resolveCompanionContextActions(null, CompanionAppCategory.Other).map(a => a.id)).toEqual([
      CompanionContextActionId.UniversalScreenshot,
      CompanionContextActionId.UniversalPickFiles,
    ]);
  });

  test('hover launcher surfaces only a concrete active file/folder and stays clean otherwise', () => {
    expect(resolveCompanionLauncherContextAction(null)).toBeNull();
    expect(resolveCompanionLauncherContextAction({
      capturedAt: 1000,
      appId: 'com.google.Chrome',
      category: CompanionAppCategory.Browser,
      clipboard: { kind: CompanionContextClipboardKind.Image, fingerprint: 'img:1', width: 200, height: 200 },
    })).toBeNull();
    expect(resolveCompanionLauncherContextAction({
      capturedAt: 1000,
      appId: 'com.apple.finder',
      category: CompanionAppCategory.Files,
      activeFile: FOLDER_FILE,
    })).toMatchObject({
      id: CompanionContextActionId.ActiveFilePrimary,
      labelKey: activeFileActionCopyKeys(FOLDER_FILE).labelKey,
      isDirectory: true,
    });
  });

  test('finds both live P1 actions and static P0 actions by id', () => {
    const snapshot: DesktopCompanionContextSnapshot = {
      capturedAt: 1000,
      appId: 'com.microsoft.Excel',
      category: CompanionAppCategory.Spreadsheet,
      activeFile: SHEET_FILE,
    };
    expect(findCompanionContextAction(CompanionContextActionId.ActiveFilePrimary, snapshot)?.fileName).toBe(SHEET_FILE.name);
    expect(findCompanionContextAction(CompanionContextActionId.CodeScreenshotDebug, snapshot)?.kind).toBe(CompanionContextActionKind.Screenshot);
  });
});

describe('context formatting and safety filters', () => {
  test('shortens long filenames while preserving their extension', () => {
    expect(shortenContextFileName('Q3.xlsx')).toBe('Q3.xlsx');
    expect(shortenContextFileName('Q3-Sales-Report-2026-Final.xlsx', 18)).toBe('Q3-Sales-Rep….xlsx');
    expect(shortenContextFileName('VeryLongFolderNameWithoutExtension', 16)).toBe('VeryLongFolderN…');
  });

  test('formats localized labels with file name and clipboard char count', () => {
    const zh = (key: string) => (desktopCompanionTranslations.zh as Record<string, string>)[key] ?? key;
    const en = (key: string) => (desktopCompanionTranslations.en as Record<string, string>)[key] ?? key;
    const fileAction = resolveCompanionLauncherContextAction({
      capturedAt: 1,
      appId: 'com.microsoft.Excel',
      category: CompanionAppCategory.Spreadsheet,
      activeFile: { ...SHEET_FILE, name: 'Q3预算.xlsx' },
    })!;
    expect(formatCompanionContextActionLabel(fileAction, zh)).toBe('分析「Q3预算.xlsx」');
    expect(formatCompanionContextActionLabel(fileAction, en)).toBe('Analyze "Q3预算.xlsx"');

    const clipAction = resolveCompanionContextActions({
      capturedAt: 1,
      appId: 'com.google.Chrome',
      category: CompanionAppCategory.Browser,
      clipboard: { kind: CompanionContextClipboardKind.Text, fingerprint: 'txt:1', charCount: 380 },
    })[0];
    expect(formatCompanionContextActionLabel(clipAction, zh)).toBe('整理刚复制的 380 字');
    expect(formatCompanionContextActionLabel(clipAction, en)).toBe('Organize copied 380 chars');
  });

  test('parses local file URLs and blocks remote or sensitive paths', () => {
    expect(parseLocalFileReference('file:///Users/alice/Documents/Q3%20%E9%A2%84%E7%AE%97.xlsx')).toBe('/Users/alice/Documents/Q3 预算.xlsx');
    expect(parseLocalFileReference('file:///Users/alice/Downloads/')).toBe('/Users/alice/Downloads');
    expect(parseLocalFileReference('file:///C:/Users/alice/report.docx')).toBe('C:/Users/alice/report.docx');
    expect(parseLocalFileReference('C:\\Users\\alice\\Downloads\\')).toBe('C:\\Users\\alice\\Downloads');
    expect(parseLocalFileReference('file://fileserver.corp/share/doc.pdf')).toBeNull();
    expect(parseLocalFileReference('https://example.com/doc.pdf')).toBeNull();
    expect(parseLocalFileReference('file:///Users/alice/.ssh/id_rsa')).toBeNull();
    expect(parseLocalFileReference('/Users/alice/project/.env.local')).toBeNull();
    expect(isSensitiveContextPath('/System/Library/CoreServices')).toBe(true);
    expect(isSensitiveContextPath('/Users/alice/Library/Keychains/login.keychain-db')).toBe(true);
    expect(isSensitiveContextPath('/Users/alice/Documents/plan.docx')).toBe(false);
  });

  test('filters secrets and short snippets out of clipboard text suggestions', () => {
    expect(looksLikeSecretText('sk-1234567890abcdef1234567890abcdef')).toBe(true);
    expect(looksLikeSecretText('ghp_1234567890abcdef1234567890abcdef1234')).toBe(true);
    expect(looksLikeSecretText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature_token_here')).toBe(true);
    expect(looksLikeSecretText('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQE...')).toBe(true);
    expect(looksLikeSecretText('SuperSecretPasswordWithoutSpaces1234567890!')).toBe(true);
    expect(isEligibleClipboardText('too short')).toBe(false);
    expect(isEligibleClipboardText('张三：周五前把报价发给客户\n李四：收到，明天先出初稿')).toBe(true);
    expect(isEligibleClipboardText('This is a long enough copied paragraph discussing quarterly revenue trends and follow-ups.')).toBe(true);
  });

  test('limits active-file inspection to document/folder-oriented categories', () => {
    expect(supportsActiveFileInspection(CompanionAppCategory.Spreadsheet)).toBe(true);
    expect(supportsActiveFileInspection(CompanionAppCategory.Files)).toBe(true);
    expect(supportsActiveFileInspection(CompanionAppCategory.Pdf)).toBe(true);
    expect(supportsActiveFileInspection(CompanionAppCategory.Browser)).toBe(false);
    expect(supportsActiveFileInspection(CompanionAppCategory.Password)).toBe(false);
    expect(supportsActiveFileInspection(CompanionAppCategory.Chat)).toBe(false);
  });
});
