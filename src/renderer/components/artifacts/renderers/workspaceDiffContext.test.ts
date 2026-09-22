import { expect, test } from 'vitest';

import { parseWorkspaceDiff } from './workspaceDiff';
import { contextGap, expandContext, trailingContextMarker } from './workspaceDiffContext';
const file = parseWorkspaceDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,1 +3,1 @@\n-old\n+new\n@@ -7,1 +7,1 @@\n-before\n+after\n').files[0];
test('expands actual leading and inter-hunk source with both line numbers', () => {
  const source = { oldSource: 'a\nb\nold\nd\ne\nf\nbefore\n', newSource: 'a\nb\nnew\nd\ne\nf\nafter\n' };
  expect(contextGap(file.hunks, 0).count).toBe(2);
  expect(contextGap(file.hunks, 1).count).toBe(3);
  expect(expandContext(file.hunks, 1, 2, source)?.lines.map(line => [line.oldNumber, line.newNumber, line.content])).toEqual([[5, 5, 'e'], [6, 6, 'f']]);
  expect(expandContext(file.hunks, 1, 3, { ...source, newSource: source.newSource.replace('\ne\n', '\nchanged\n') })).toBeUndefined();
});

test('trailing context retains the actual final line without counting the trailing newline as another line', () => {
  const sources = {oldSource: 'a\nb\nold\nd\ne\nf\nbefore\ntail 1\ntail 2\n',newSource: 'a\nb\nnew\nd\ne\nf\nafter\ntail 1\ntail 2\n'};
  const hunks = [...file.hunks, trailingContextMarker(sources)];
  expect(contextGap(hunks, 2).count).toBe(2);
  expect(expandContext(hunks, 2, 40, sources)?.lines.map(line => [line.oldNumber, line.newNumber, line.content])).toEqual([[8,8,'tail 1'],[9,9,'tail 2']]);
});
