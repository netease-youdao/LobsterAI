import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { wordFontAliases,WordFontStyle } from '../../../shared/artifactPreview/wordFonts';
import { defaultWordFontDirectories, WordFontCatalog } from './fontCatalog';
import { bufferSource, readFontFaces } from './sfnt';

const fontsRoot = path.resolve(__dirname, '../../../renderer/assets/word-fonts');
const temporaryDirectories: string[] = [];

async function fontDirectory(files: string[]): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-word-fonts-'));
  temporaryDirectories.push(directory);
  await fs.mkdir(path.join(directory, 'nested'), { recursive: true });
  for (const [index, file] of files.entries()) {
    await fs.copyFile(path.join(fontsRoot, file), path.join(directory, index % 2 ? 'nested' : '', file));
  }
  await fs.writeFile(path.join(directory, 'broken.ttf'), 'not a font');
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('WordFontCatalog', () => {
  test('resolves the four styles of an installed family and skips unreadable files', async () => {
    const directory = await fontDirectory(['Carlito-Regular.ttf', 'Carlito-Bold.ttf', 'Carlito-Italic.ttf', 'Carlito-BoldItalic.ttf']);
    const catalog = new WordFontCatalog({ directories: [directory] });
    const faces = await catalog.resolve(['carlito']);
    expect(faces.map(face => `${face.weight}/${face.style}`).sort()).toEqual(['400/italic', '400/normal', '700/italic', '700/normal']);
    expect(faces.every(face => face.family === 'Carlito' && face.requested === 'carlito')).toBe(true);
    const bytes = await catalog.readFace(faces.find(face => face.weight === 700 && face.style === WordFontStyle.Normal)!.id);
    const [face] = await readFontFaces(bufferSource(bytes));
    expect(face.weight).toBe(700);
    await expect(catalog.readFace('unknown')).rejects.toThrow();
  });

  test('maps a missing bold to the nearest real face instead of inventing one', async () => {
    const directory = await fontDirectory(['Caladea-Regular.ttf']);
    const catalog = new WordFontCatalog({ directories: [directory] });
    const faces = await catalog.resolve(['Caladea', 'Not Installed']);
    expect(faces).toHaveLength(1);
    expect(faces[0]).toMatchObject({ weight: 400, style: WordFontStyle.Normal });
  });

  test('reuses the cache for unchanged files', async () => {
    const directory = await fontDirectory(['Carlito-Regular.ttf']);
    const cachePath = path.join(directory, 'cache', 'catalog.json');
    await new WordFontCatalog({ directories: [directory], cachePath }).ensureScanned();
    const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as { files: { faces: unknown[] }[] };
    expect(cached.files).toHaveLength(1);
    const again = new WordFontCatalog({ directories: [directory], cachePath });
    expect((await again.resolve(['Carlito']))[0].family).toBe('Carlito');
  });

  test('knows Word\'s Chinese and English names for the same family', () => {
    expect(wordFontAliases('宋体')).toEqual(['宋体', 'SimSun']);
    expect(wordFontAliases('microsoft yahei')).toEqual(['microsoft yahei', '微软雅黑']);
    expect(wordFontAliases('Helvetica')).toContain('Arial');
  });

  test('scans the Windows, macOS Office and Linux font folders', () => {
    expect(defaultWordFontDirectories('win32', { WINDIR: 'C:\\Windows', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'C:\\Users\\a'))
      .toEqual(['C:\\Windows\\Fonts', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\Windows\\Fonts']);
    expect(defaultWordFontDirectories('darwin', {}, '/Users/a')).toContain('/Applications/Microsoft Word.app/Contents/Resources/DFonts');
    expect(defaultWordFontDirectories('linux', {}, '/home/a')).toContain('/usr/share/fonts');
  });
});
