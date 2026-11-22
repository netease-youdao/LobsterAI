import * as path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

const HELPERS_URL = pathToFileURL(
  path.resolve('dsh-bundles/lobsterai-host/plugins/office-gui-guard-helpers.mjs'),
).href;

type GuardHelpers = {
  extractShellCommand: (toolName: string, args: unknown) => string;
  evaluateOfficeGuiGuard: (toolName: string, args: unknown) => string | undefined;
};

let cached: GuardHelpers | null = null;
async function loadHelpers(): Promise<GuardHelpers> {
  if (!cached) {
    cached = (await import(HELPERS_URL)) as GuardHelpers;
  }
  return cached;
}

describe('office-gui-guard-helpers', () => {
  test('blocks desktop Office GUI launch commands across bash/pwsh', async () => {
    const { evaluateOfficeGuiGuard } = await loadHelpers();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'osascript -e \'tell application "Keynote" to open POSIX file "/tmp/deck.pptx"\'',
      }),
    ).toContain('Keynote');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open -a /Applications/wpsoffice.app "/tmp/report.docx"',
      }),
    ).toContain('wpsoffice');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: '/Applications/wpsoffice.app/Contents/MacOS/wpsoffice --headless --convert-to pdf a.docx',
      }),
    ).toContain('wpsoffice');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'soffice report.docx',
      }),
    ).toContain('--headless');

    expect(
      evaluateOfficeGuiGuard('pwsh', {
        command: 'start "" WINWORD.EXE report.docx',
      }),
    ).toContain('WINWORD');

    // Bare macOS `open <office-file>` without `-a`
    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open deck.pptx',
      }),
    ).toContain('open');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'cd /tmp && open "/Users/me/Q3 Report.docx"',
      }),
    ).toContain('.docx');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: '/usr/bin/open -g ./budget.xlsx',
      }),
    ).toContain('.xlsx');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open legacy.ppt',
      }),
    ).toContain('.ppt');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open file:///tmp/report.doc',
      }),
    ).toContain('.doc');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open sheet.xls',
      }),
    ).toContain('.xls');

    // Windows PowerShell `Invoke-Item` / `ii` launching Office files
    expect(
      evaluateOfficeGuiGuard('pwsh', {
        command: 'Invoke-Item report.docx',
      }),
    ).toContain('Invoke-Item');

    expect(
      evaluateOfficeGuiGuard('pwsh', {
        command: 'Invoke-Item -Path "C:\\Users\\me\\deck.pptx"',
      }),
    ).toContain('.pptx');

    expect(
      evaluateOfficeGuiGuard('pwsh', {
        command: 'ii sheet.xlsx',
      }),
    ).toContain('ii');

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'pwsh -Command "Invoke-Item report.docx"',
      }),
    ).toContain('Invoke-Item');
  });

  test('allows headless conversions, preview scripts, non-Office open/URLs, and non-shell tools', async () => {
    const { evaluateOfficeGuiGuard } = await loadHelpers();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'soffice --headless --convert-to pdf deck.pptx --outdir /tmp',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'which soffice libreoffice pdftoppm',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'node SKILLs/pptx/scripts/preview_html.js slides/ --out preview.jpg',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open https://example.com',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open https://example.com/files/report.docx',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open -a Safari https://example.com',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open -a Preview /tmp/preview.pdf',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'open /tmp/report.docx.pdf',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'python3 -c "open(\'report.docx\', \'rb\').read()"',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('pwsh', {
        command: 'Invoke-Item https://example.com',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('pwsh', {
        command: 'ii C:\\temp\\preview.pdf',
      }),
    ).toBeUndefined();

    expect(
      evaluateOfficeGuiGuard('read', {
        command: 'open -a Keynote deck.pptx',
      }),
    ).toBeUndefined();
  });
});
