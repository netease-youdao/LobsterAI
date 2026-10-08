import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { MarkdownFileError, MAX_EDITABLE_MARKDOWN_BYTES } from '../../shared/artifactPreview/markdownEditing';
import { readMarkdownFile, saveMarkdownFile } from './markdownFileEditing';

const roots: string[] = [];
async function fixture(content: string | Buffer = '# Original\n') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-markdown-edit-'));
  roots.push(root);
  const filePath = path.join(root, '文档.md');
  await fs.writeFile(filePath, content);
  return filePath;
}
async function read(filePath: string) {
  const result = await readMarkdownFile(filePath);
  if (!result.success) throw new Error(result.error);
  return result.file;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Markdown file editing', () => {
  test('writes UTF-8 atomically, preserves permissions, and supports empty content and retries', async () => {
    const filePath = await fixture('\uFEFF# 原文\r\n');
    await fs.chmod(filePath, 0o640);
    const original = await read(filePath);
    expect(original.content).toBe('\uFEFF# 原文\r\n');
    const request = { filePath, content: '# 新内容\n', expectedVersion: original.version };
    expect((await saveMarkdownFile(request)).success).toBe(true);
    expect(await fs.readFile(filePath, 'utf8')).toBe(request.content);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o640);
    expect((await saveMarkdownFile(request)).success).toBe(true);
    const saved = await read(filePath);
    expect((await saveMarkdownFile({ filePath, content: '', expectedVersion: saved.version })).success).toBe(true);
    expect(await fs.readFile(filePath, 'utf8')).toBe('');
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['文档.md']);
  });

  test('refuses stale versions and serializes concurrent saves to the same file', async () => {
    const filePath = await fixture();
    const original = await read(filePath);
    const results = await Promise.all(['first', 'second'].map(content => saveMarkdownFile({ filePath, content, expectedVersion: original.version })));
    expect(results.filter(result => result.success)).toHaveLength(1);
    expect(results.find(result => !result.success)).toMatchObject({ code: MarkdownFileError.Conflict });
    const current = await read(filePath);
    await fs.writeFile(filePath, 'Written by another program');
    expect(await saveMarkdownFile({ filePath, content: 'My edit', expectedVersion: current.version })).toMatchObject({ success: false, code: MarkdownFileError.Conflict });
    expect(await fs.readFile(filePath, 'utf8')).toBe('Written by another program');
  });

  test('keeps the original intact and cleans up the temporary file if replacement fails', async () => {
    const filePath = await fixture();
    const original = await read(filePath);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk failure'));
    expect((await saveMarkdownFile({ filePath, content: 'new', expectedVersion: original.version })).success).toBe(false);
    expect(await fs.readFile(filePath, 'utf8')).toBe(original.content);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['文档.md']);
  });

  test('never edits truncated, binary, or invalid UTF-8 input', async () => {
    expect(await readMarkdownFile(await fixture(Buffer.alloc(MAX_EDITABLE_MARKDOWN_BYTES + 1, 65)))).toMatchObject({ code: MarkdownFileError.TooLarge });
    expect(await readMarkdownFile(await fixture(Buffer.from([0xff, 0xfe])))).toMatchObject({ code: MarkdownFileError.InvalidEncoding });
    expect(await readMarkdownFile(await fixture('abc\0def'))).toMatchObject({ code: MarkdownFileError.InvalidEncoding });
    expect(await readMarkdownFile('relative.md')).toMatchObject({ code: MarkdownFileError.InvalidFile });
  });

  test('saves through Markdown symlinks without replacing the link', async () => {
    const filePath = await fixture();
    const link = path.join(path.dirname(filePath), 'linked.md');
    await fs.symlink(filePath, link);
    const original = await read(link);
    expect((await saveMarkdownFile({ filePath: link, content: 'linked edit', expectedVersion: original.version })).success).toBe(true);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(filePath, 'utf8')).toBe('linked edit');
  });
});
