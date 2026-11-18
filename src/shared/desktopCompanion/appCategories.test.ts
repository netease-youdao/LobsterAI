import { describe, expect, test } from 'vitest';

import {
  categorizeCompanionApp,
  CompanionAppCategory,
  isCompanionQuietCategory,
  isCompanionSelectionBlocked,
  knownCompanionAppId,
  SELECTION_CLIPBOARD_APPS,
} from './appCategories';

describe('app categories', () => {
  test('recognises macOS bundle ids regardless of case', () => {
    expect(categorizeCompanionApp('com.microsoft.Word')).toBe(CompanionAppCategory.Document);
    expect(categorizeCompanionApp('com.netease.macmail')).toBe(CompanionAppCategory.Mail);
    expect(categorizeCompanionApp('com.tencent.xinWeChat')).toBe(CompanionAppCategory.Chat);
    expect(categorizeCompanionApp('com.google.Chrome')).toBe(CompanionAppCategory.Browser);
    expect(categorizeCompanionApp('com.jetbrains.intellij')).toBe(CompanionAppCategory.Code);
  });

  test('recognises Windows executables, including full image paths', () => {
    expect(categorizeCompanionApp('WINWORD.EXE')).toBe(CompanionAppCategory.Document);
    expect(categorizeCompanionApp('C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE')).toBe(CompanionAppCategory.Spreadsheet);
    expect(categorizeCompanionApp('wemeetapp.exe')).toBe(CompanionAppCategory.Meeting);
  });

  test('treats unknown or missing apps as other', () => {
    expect(categorizeCompanionApp('com.example.unknown')).toBe(CompanionAppCategory.Other);
    expect(categorizeCompanionApp(null)).toBe(CompanionAppCategory.Other);
  });

  test('names only apps from the built-in lists, normalized', () => {
    expect(knownCompanionAppId('C:\\Program Files\\Kingsoft\\WPS.EXE')).toBe('wps.exe');
    expect(knownCompanionAppId('com.microsoft.Word')).toBe('com.microsoft.word');
    expect(knownCompanionAppId('msedge.exe')).toBe('msedge.exe');
    expect(knownCompanionAppId('msedgewebview2.exe')).toBe('msedgewebview2.exe');
    expect(knownCompanionAppId('acme-payroll.exe')).toBeNull();
    // Prefix matches categorize an app without naming it.
    expect(knownCompanionAppId('com.jetbrains.intellij')).toBeNull();
    expect(knownCompanionAppId('constructor')).toBeNull();
    expect(knownCompanionAppId(null)).toBeNull();
  });

  test('every app read through the clipboard on Windows is a known app, so analytics can name it', () => {
    for (const app of SELECTION_CLIPBOARD_APPS) expect(knownCompanionAppId(app)).toBe(app);
  });

  // selection-hook compares its program lists by substring: a short name reaches other programs too.
  test('no clipboard app name is part of another program name', () => {
    for (const app of SELECTION_CLIPBOARD_APPS) {
      for (const other of ['telnet.exe', 'pocket.exe', 'whatsapp.exe', 'msedge.exe', 'msedgewebview2.exe']) {
        expect(other.includes(app), `${app} would match ${other}`).toBe(false);
      }
      expect(app.length, `${app} is too short to name one program`).toBeGreaterThanOrEqual('wps.exe'.length);
    }
  });

  test('stays quiet in meetings', () => {
    expect(isCompanionQuietCategory(CompanionAppCategory.Meeting)).toBe(true);
    expect(isCompanionQuietCategory(CompanionAppCategory.Mail)).toBe(false);
  });
});

describe('selection blocking', () => {
  test('never reads selections from LobsterAI itself or password managers', () => {
    expect(isCompanionSelectionBlocked('com.lobsterai.app', [])).toBe(true);
    expect(isCompanionSelectionBlocked('com.apple.Passwords', [])).toBe(true);
    expect(isCompanionSelectionBlocked('1Password.exe', [])).toBe(true);
  });

  test('skips Youdao Dict and file managers by default', () => {
    expect(isCompanionSelectionBlocked('com.youdao.YoudaoDict', [])).toBe(true);
    expect(isCompanionSelectionBlocked('com.apple.finder', [])).toBe(true);
    expect(isCompanionSelectionBlocked('explorer.exe', [])).toBe(true);
  });

  test('honours apps the user excluded', () => {
    expect(isCompanionSelectionBlocked('com.google.Chrome', [])).toBe(false);
    expect(isCompanionSelectionBlocked('com.google.Chrome', ['com.google.chrome'])).toBe(true);
  });
});
