import crypto from 'crypto';
import fs from 'fs';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { HtmlShareSourceType } from '../../../shared/htmlShare/constants';
import { packageArtifactFile } from './artifactFileSharePackager';

const tempRoots: string[] = [];
const archiveRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-artifact-share-packager-test-'));
  tempRoots.push(root);
  return root;
}

async function writeFile(filePath: string, content: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content);
}

async function loadZip(archivePath: string): Promise<JSZip> {
  archiveRoots.push(path.dirname(archivePath));
  return JSZip.loadAsync(await fs.promises.readFile(archivePath));
}

function pngBytes(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lmG7ZQAAAABJRU5ErkJggg==',
    'base64',
  );
}

afterEach(async () => {
  await Promise.all([
    ...tempRoots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })),
    ...archiveRoots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })),
  ]);
});

describe('artifactFileSharePackager', () => {
  test('packages Mermaid as a single UTF-8 source file', async () => {
    const content = 'flowchart TD\nA --> B\n';

    const packaged = await packageArtifactFile({
      sourceType: HtmlShareSourceType.MermaidFile,
      fileName: 'diagram.mmd',
      content,
    });
    const zip = await loadZip(packaged.archivePath);

    expect(Object.keys(zip.files).sort()).toEqual(['diagram.mmd']);
    expect(packaged.entryFile).toBe('diagram.mmd');
    expect(packaged.contentType).toBe('text/plain;charset=UTF-8');
    expect(packaged.sourceSha256).toBe(crypto.createHash('sha256').update(content).digest('hex'));
  });

  test('packages Markdown with same-directory local images and omits remote images', async () => {
    const root = await createTempRoot();
    const markdownPath = path.join(root, 'README.md');
    await writeFile(path.join(root, 'images/arch.png'), pngBytes());
    await writeFile(
      markdownPath,
      [
        '# Demo',
        '',
        '![arch](images/arch.png)',
        'Plain text path: images/arch.png',
        '![remote](https://example.com/remote.png)',
      ].join('\n'),
    );

    const packaged = await packageArtifactFile({
      sourceType: HtmlShareSourceType.MarkdownFile,
      filePath: markdownPath,
      fileName: 'README.md',
    });
    const zip = await loadZip(packaged.archivePath);
    const entries = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
    const markdown = await zip.file('README.md')!.async('string');
    const manifest = JSON.parse(await zip.file('_lobster_share_manifest.json')!.async('string'));

    expect(entries).toHaveLength(3);
    expect(entries).toContain('README.md');
    expect(entries).toContain('_lobster_share_manifest.json');
    expect(entries.some(entry => entry.startsWith('_lobster_assets/') && entry.endsWith('arch.png'))).toBe(true);
    expect(markdown).toContain('_lobster_assets/');
    expect(markdown).toContain('Plain text path: images/arch.png');
    expect(markdown).not.toContain('![arch](images/arch.png)');
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.omittedAssets).toEqual([
      {
        originalUrl: 'https://example.com/remote.png',
        reason: 'unsupported_or_external_reference',
      },
    ]);
    expect(packaged.warnings).toEqual([
      'Markdown asset skipped: https://example.com/remote.png (unsupported_or_external_reference)',
    ]);
  });

  test('packages Markdown file URL images inside the Markdown directory', async () => {
    const root = await createTempRoot();
    const markdownPath = path.join(root, 'pets.md');
    const imagePath = path.join(root, 'generated-image-20260617-163944-1.png');
    const imageUrl = pathToFileURL(imagePath).href;
    await writeFile(imagePath, pngBytes());
    await writeFile(
      markdownPath,
      [
        '# Pets',
        '',
        `![generated](${imageUrl})`,
      ].join('\n'),
    );

    const packaged = await packageArtifactFile({
      sourceType: HtmlShareSourceType.MarkdownFile,
      filePath: markdownPath,
      fileName: 'pets.md',
    });
    const zip = await loadZip(packaged.archivePath);
    const entries = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
    const markdown = await zip.file('pets.md')!.async('string');
    const manifestText = await zip.file('_lobster_share_manifest.json')!.async('string');
    const manifest = JSON.parse(manifestText);

    expect(entries).toHaveLength(3);
    expect(entries.some(entry =>
      entry.startsWith('_lobster_assets/') &&
      entry.endsWith('generated-image-20260617-163944-1.png'),
    )).toBe(true);
    expect(markdown).toContain('_lobster_assets/');
    expect(markdown).not.toContain(imageUrl);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].originalUrl).toBe('generated-image-20260617-163944-1.png');
    expect(manifestText).not.toContain(root);
    expect(packaged.warnings).toEqual([]);
  });

  test('removes the temporary Markdown archive when packaging fails', async () => {
    const originalMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    const originalStat = fs.promises.stat.bind(fs.promises);
    let packagingTempDir = '';
    const mkdtempSpy = vi.spyOn(fs.promises, 'mkdtemp').mockImplementation(async (prefix, options) => {
      const created = await originalMkdtemp(prefix, options as BufferEncoding);
      if (prefix.includes('lobster-artifact-share-')) packagingTempDir = created;
      return created;
    });
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (target, options) => {
      if (String(target).endsWith(`${path.sep}share.zip`)) {
        throw new Error('simulated archive stat failure');
      }
      return originalStat(target, options as never);
    });

    try {
      await expect(packageArtifactFile({
        sourceType: HtmlShareSourceType.MarkdownFile,
        fileName: 'README.md',
        content: '# Demo\n',
      })).rejects.toThrow('simulated archive stat failure');
      expect(packagingTempDir).not.toBe('');
      expect(fs.existsSync(packagingTempDir)).toBe(false);
    } finally {
      statSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }
  });
});
