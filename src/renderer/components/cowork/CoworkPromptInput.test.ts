import { test, expect } from 'vitest';
import { mergeAttachments } from './CoworkPromptInput';

interface DraftAttachment {
  path: string;
  name: string;
  isImage?: boolean;
  dataUrl?: string;
}

test('single file: merges one file into empty list', () => {
  const oneFile: DraftAttachment = {
    path: '/path/to/file.txt',
    name: 'file.txt',
  };
  const result = mergeAttachments([], [oneFile]);
  expect(result).toHaveLength(1);
  expect(result[0].path).toBe('/path/to/file.txt');
  expect(result[0].name).toBe('file.txt');
});

test('multiple files: merges three files into empty list', () => {
  const files: DraftAttachment[] = [
    { path: '/path/a.txt', name: 'a.txt' },
    { path: '/path/b.txt', name: 'b.txt' },
    { path: '/path/c.txt', name: 'c.txt' },
  ];
  const result = mergeAttachments([], files);
  expect(result).toHaveLength(3);
  expect(result.map((f: DraftAttachment) => f.path)).toEqual([
    '/path/a.txt',
    '/path/b.txt',
    '/path/c.txt',
  ]);
});

test('append to existing: adds new file to existing list', () => {
  const existing: DraftAttachment[] = [
    { path: '/path/existing.txt', name: 'existing.txt' },
  ];
  const newFile: DraftAttachment[] = [
    { path: '/path/new.txt', name: 'new.txt' },
  ];
  const result = mergeAttachments(existing, newFile);
  expect(result).toHaveLength(2);
  expect(result[0].path).toBe('/path/existing.txt');
  expect(result[1].path).toBe('/path/new.txt');
});

test('cross-batch dedup: removes duplicate path from incoming batch', () => {
  const existing: DraftAttachment[] = [
    { path: 'a.txt', name: 'a.txt' },
  ];
  const incoming: DraftAttachment[] = [
    { path: 'a.txt', name: 'a.txt' },
    { path: 'b.txt', name: 'b.txt' },
  ];
  const result = mergeAttachments(existing, incoming);
  expect(result).toHaveLength(2);
  const paths = result.map((f: DraftAttachment) => f.path);
  expect(paths).toContain('a.txt');
  expect(paths).toContain('b.txt');
  expect(paths.filter((p: string) => p === 'a.txt')).toHaveLength(1);
});

test('within-batch dedup: removes duplicate within incoming batch', () => {
  const incoming: DraftAttachment[] = [
    { path: 'a.txt', name: 'a.txt' },
    { path: 'a.txt', name: 'a.txt' },
  ];
  const result = mergeAttachments([], incoming);
  expect(result).toHaveLength(1);
  expect(result[0].path).toBe('a.txt');
});

test('empty incoming: returns existing list unchanged', () => {
  const existing: DraftAttachment[] = [
    { path: '/path/file.txt', name: 'file.txt' },
  ];
  const result = mergeAttachments(existing, []);
  expect(result).toHaveLength(1);
  expect(result[0].path).toBe('/path/file.txt');
});

test('image metadata: preserves isImage flag and dataUrl', () => {
  const imageFile: DraftAttachment = {
    path: '/path/image.png',
    name: 'image.png',
    isImage: true,
    dataUrl: 'data:image/png;base64,iVBORw0KGgo...',
  };
  const result = mergeAttachments([], [imageFile]);
  expect(result).toHaveLength(1);
  expect(result[0].isImage).toBe(true);
  expect(result[0].dataUrl).toBe('data:image/png;base64,iVBORw0KGgo...');
});

test('empty both: returns empty array', () => {
  const result = mergeAttachments([], []);
  expect(result).toHaveLength(0);
  expect(result).toEqual([]);
});
