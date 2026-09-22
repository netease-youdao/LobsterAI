import { expect, test } from 'vitest';

import { parseWorkspaceDiff, type WorkspaceDiffFile } from './workspaceDiff';
import { buildDiffFileTree, unmodifiedLinesBefore } from './workspaceDiffTree';

const file = (path: string, status: WorkspaceDiffFile['status'] = 'modified'): WorkspaceDiffFile => ({ id: `file:${path}`, path, status, binary: false, hunks: [], added: 0, removed: 0 });

test('tree retains exact file identities and status, sorts folders first and filters complete paths case-insensitively', () => {
  const files = [file('z.ts'), file('src/item10.ts'), file('src/item2.ts', 'renamed'), file('src/deep/new.ts', 'added'), file('<img>.ts', 'deleted')];
  const original = files.map(entry => entry.path);
  const tree = buildDiffFileTree(files);
  expect(tree[0].path).toBe('src');
  expect(tree[0].children.map(entry => entry.name)).toEqual(['deep', 'item2.ts', 'item10.ts']);
  expect(tree[0].children[1].file).toBe(files[2]);
  expect(buildDiffFileTree(files, ' SRC/DEEP ')[0].children[0].children[0].file).toBe(files[3]);
  expect(buildDiffFileTree(files, 'no match')).toEqual([]);
  expect(files.map(entry => entry.path)).toEqual(original);
});

test('unmodified gaps use both real hunk coordinates and never infer context after truncated hunks', () => {
  const { hunks } = parseWorkspaceDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -5,1 +8,1 @@\n-a\n+b\n@@ -106,1 +109,1 @@\n-c\n+d\n').files[0];
  expect(unmodifiedLinesBefore(hunks, 0)).toBe(0);
  expect(unmodifiedLinesBefore(hunks, 1)).toBe(100);
  expect(unmodifiedLinesBefore([{ ...hunks[0], incomplete: true }, hunks[1]], 1)).toBe(0);
  expect(unmodifiedLinesBefore([hunks[0], { ...hunks[1], newStart: 9 }], 1)).toBe(0);
  expect(unmodifiedLinesBefore([hunks[0], { ...hunks[1], newStart: 108 }], 1)).toBe(0);
});
