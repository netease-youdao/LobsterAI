import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FONTS_DIR = path.join(REPO_ROOT, 'src/renderer/assets/fonts');
const INDEX_CSS_PATH = path.join(REPO_ROOT, 'src/renderer/index.css');
const COWORK_VIEW_PATH = path.join(REPO_ROOT, 'src/renderer/components/cowork/CoworkView.tsx');

interface FontSourceEntry {
  file: string;
  sha256: string;
  bytes: number;
  license: string;
  codepointCount?: number;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('home headline serif font bundle', () => {
  test('ships the verified OFL-1.1 WOFF2 common-CJK subset and license', () => {
    const sourcesPath = path.join(FONTS_DIR, 'sources.json');
    const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8')) as FontSourceEntry[];

    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const entry of sources) {
      expect(entry.license).toBe('OFL-1.1');
      const fileBytes = fs.readFileSync(path.join(FONTS_DIR, entry.file));
      expect(fileBytes.length).toBe(entry.bytes);
      expect(sha256(fileBytes)).toBe(entry.sha256);
    }

    const fontEntry = sources.find(entry => entry.file === 'LobsterHomeSerif-Medium.woff2');
    expect(fontEntry).toBeDefined();
    expect(fontEntry?.codepointCount).toBeGreaterThanOrEqual(3500);

    const woff2Bytes = fs.readFileSync(path.join(FONTS_DIR, 'LobsterHomeSerif-Medium.woff2'));
    expect(woff2Bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');

    const licenseText = fs.readFileSync(path.join(FONTS_DIR, 'OFL-NotoSerifSC.txt'), 'utf8');
    expect(licenseText).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });

  test('declares @font-face in index.css and prioritizes it before Songti SC in CoworkView', () => {
    const css = fs.readFileSync(INDEX_CSS_PATH, 'utf8');
    expect(css).toContain("font-family: 'Lobster Home Serif';");
    expect(css).toContain("url('./assets/fonts/LobsterHomeSerif-Medium.woff2') format('woff2')");

    const coworkViewSource = fs.readFileSync(COWORK_VIEW_PATH, 'utf8');
    const match = coworkViewSource.match(/HOME_HEADLINE_FONT_FAMILY\s*=\s*'([^']+)'/);
    expect(match).not.toBeNull();
    const stack = match![1];

    const bundledIndex = stack.indexOf('"Lobster Home Serif"');
    const songtiIndex = stack.indexOf('"Songti SC"');
    expect(bundledIndex).toBe(0);
    expect(songtiIndex).toBeGreaterThan(bundledIndex);
    expect(coworkViewSource).toContain('fontFeatureSettings: \'"palt" 1\'');
  });
});
