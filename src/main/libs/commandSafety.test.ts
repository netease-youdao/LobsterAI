import { describe, expect, test } from 'vitest';

import {
  detectDisallowedOfficeGuiLaunch,
  getCommandDangerLevel,
  isDangerousCommand,
} from './commandSafety';

describe('detectDisallowedOfficeGuiLaunch', () => {
  test('blocks explicit Office GUI launches and interactive soffice', () => {
    expect(
      detectDisallowedOfficeGuiLaunch('osascript -e \'tell application "Keynote" to open POSIX file "/tmp/deck.pptx"\''),
    ).toMatchObject({ matched: true, app: 'Keynote' });

    expect(
      detectDisallowedOfficeGuiLaunch('open -a "Microsoft Word" /tmp/report.docx'),
    ).toMatchObject({ matched: true, app: 'Microsoft Word' });

    expect(
      detectDisallowedOfficeGuiLaunch('start "" POWERPNT.EXE deck.pptx'),
    ).toMatchObject({ matched: true, app: 'POWERPNT' });

    expect(
      detectDisallowedOfficeGuiLaunch('soffice report.docx'),
    ).toMatchObject({ matched: true, app: 'soffice' });
  });

  test('blocks bare macOS open and Windows PowerShell Invoke-Item / ii on Office document files', () => {
    for (const cmd of [
      'open deck.pptx',
      'open /tmp/report.docx',
      'open "/Users/me/Q3 Budget.xlsx"',
      'cd /tmp && open ./legacy.doc',
      'open legacy.xls',
      'open legacy.ppt',
      '/usr/bin/open -g file:///tmp/deck.pptx',
    ]) {
      const result = detectDisallowedOfficeGuiLaunch(cmd);
      expect(result.matched, cmd).toBe(true);
      expect(result.app, cmd).toBe('open');
    }

    for (const [cmd, expectedApp] of [
      ['Invoke-Item report.docx', 'Invoke-Item'],
      ['Invoke-Item -Path "C:\\docs\\deck.pptx"', 'Invoke-Item'],
      ['ii sheet.xlsx', 'ii'],
      ['cd D:\\work; ii ".\\report.doc"', 'ii'],
      ['pwsh -Command "Invoke-Item budget.xls"', 'Invoke-Item'],
    ] as const) {
      const result = detectDisallowedOfficeGuiLaunch(cmd);
      expect(result.matched, cmd).toBe(true);
      expect(result.app, cmd).toBe(expectedApp);
    }
  });

  test('allows non-Office open/URLs, headless soffice, and Python/Node scripts', () => {
    for (const cmd of [
      'open https://example.com',
      'open https://example.com/files/report.docx',
      'open -a Safari https://example.com',
      'open -a Preview /tmp/preview.pdf',
      'open /tmp/preview.png',
      'open /tmp/report.docx.pdf',
      'Invoke-Item https://example.com',
      'ii C:\\temp\\preview.pdf',
      'soffice --headless --convert-to pdf deck.pptx --outdir /tmp',
      'python3 -c "open(\'report.docx\', \'rb\').read()"',
      'node SKILLs/pptx/scripts/preview_html.js slides/ --out preview.jpg',
    ]) {
      expect(detectDisallowedOfficeGuiLaunch(cmd), cmd).toEqual({ matched: false });
    }
  });
});

describe('commandSafety danger classification sanity', () => {
  test('retains destructive and safe classification', () => {
    expect(isDangerousCommand('rm -rf /tmp/old')).toBe(true);
    expect(getCommandDangerLevel('rm -rf /tmp/old')).toEqual({
      level: 'destructive',
      reason: 'recursive-delete',
    });
    expect(getCommandDangerLevel('ls -la')).toEqual({ level: 'safe', reason: '' });
  });
});
