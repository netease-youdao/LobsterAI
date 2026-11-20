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
  });

  test('allows headless conversions, preview scripts, and non-shell tools', async () => {
    const { evaluateOfficeGuiGuard } = await loadHelpers();

    expect(
      evaluateOfficeGuiGuard('bash', {
        command: 'soffice --headless --convert-to pdf report.docx --outdir /tmp',
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
      evaluateOfficeGuiGuard('read', {
        command: 'open -a Keynote deck.pptx',
      }),
    ).toBeUndefined();
  });
});
