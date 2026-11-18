import { expect, test } from 'vitest';

import { type ArtifactTabActionTarget, artifactTabMenuActions } from './artifactTabActions';

function fixture(active: string) {
  const open = new Set(['files', 'browser', 'image1', 'image2']);
  const closed: string[] = [];
  let selected = active;
  const tabs: ArtifactTabActionTarget[] = [...open].map(id => ({
    id, active: id === active,
    close: () => { open.delete(id); closed.push(id); selected = 'fallback'; },
    activate: () => { selected = id; },
  }));
  return { tabs, open, closed, selected: () => selected };
}

test('close others uses every tab lifecycle and keeps the chosen tab even when it was inactive', () => {
  const state = fixture('image2');
  artifactTabMenuActions(state.tabs, 'image1').onCloseOthers?.();
  expect(state.closed).toEqual(['files', 'browser', 'image2']);
  expect([...state.open]).toEqual(['image1']);
  expect(state.selected()).toBe('image1');
});

test('close right respects the displayed order across special and file tabs and preserves a surviving active tab', () => {
  const state = fixture('files');
  artifactTabMenuActions(state.tabs, 'browser').onCloseToRight?.();
  expect(state.closed).toEqual(['image1', 'image2']);
  expect([...state.open]).toEqual(['files', 'browser']);
  expect(state.selected()).toBe('files');
});

test('close right selects the target when the active tab was closed and disables empty groups', () => {
  const state = fixture('image2');
  artifactTabMenuActions(state.tabs, 'image1').onCloseToRight?.();
  expect(state.selected()).toBe('image1');
  expect(artifactTabMenuActions(state.tabs, 'image2').onCloseToRight).toBeUndefined();
  expect(artifactTabMenuActions([state.tabs[0]], 'files').onCloseOthers).toBeUndefined();
  expect(artifactTabMenuActions(state.tabs, 'deleted')).toEqual({});
});
