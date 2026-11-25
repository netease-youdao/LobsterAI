import { describe, expect, test } from 'vitest';

import { waitForWordEditorReady, type WordEditorReadyTarget } from './wordEditorSession';

type EventName = 'change' | 'selectionChange' | 'error';

function createFakeEditor() {
  const listeners: Record<EventName, Set<() => void>> = {
    change: new Set(),
    selectionChange: new Set(),
    error: new Set(),
  };
  let isLoading = false;
  let isOpening = true;
  let resolving = false;
  let measurer = 'fixed';
  let mode: 'edit' | 'view' = 'view';
  let parseError: string | null = null;
  let setModeCalls = 0;

  const emit = (event: EventName) => {
    for (const listener of [...listeners[event]]) listener();
  };

  const editor: WordEditorReadyTarget = {
    snapshot: () => ({
      parseError,
      isLoading,
      isOpening,
      editable: mode === 'edit' && measurer === 'shaped',
    }),
    fontMeasurement: () => ({ resolving, measurer }),
    setMode: next => {
      setModeCalls += 1;
      mode = next;
      // Mirrors @docx-editor.dev/core: setMode synchronously emits selectionChange.
      emit('selectionChange');
    },
    on: (event, listener) => {
      listeners[event].add(listener);
      return () => { listeners[event].delete(listener); };
    },
  };

  return {
    editor,
    emit,
    get setModeCalls() { return setModeCalls; },
    setState: (patch: Partial<{ isLoading: boolean; isOpening: boolean; resolving: boolean; measurer: string; parseError: string | null }>) => {
      if (patch.isLoading !== undefined) isLoading = patch.isLoading;
      if (patch.isOpening !== undefined) isOpening = patch.isOpening;
      if (patch.resolving !== undefined) resolving = patch.resolving;
      if (patch.measurer !== undefined) measurer = patch.measurer;
      if (patch.parseError !== undefined) parseError = patch.parseError;
    },
  };
}

describe('waitForWordEditorReady', () => {
  test('waits past synchronous change emitted before shouldYield marks font resolution active', async () => {
    const fake = createFakeEditor();
    const ready = waitForWordEditorReady(fake.editor, { locked: false, fallbackPollMs: 5000 });

    // Mirrors @docx-editor.dev/core Ni(): mounts with fixed measurer, emits change & selectionChange
    // synchronously, and only THEN marks font resolution active via q.schedule(true).
    await Promise.resolve();
    fake.setState({ isOpening: false, resolving: false, measurer: 'fixed' });
    fake.emit('change');
    fake.emit('selectionChange');
    fake.setState({ resolving: true });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fake.setModeCalls).toBe(0);

    // Shaped fonts finish resolving and emit selectionChange.
    fake.setState({ resolving: false, measurer: 'shaped' });
    fake.emit('selectionChange');

    await expect(ready).resolves.toBeUndefined();
    expect(fake.setModeCalls).toBe(1);
  });

  test('does not recurse when setMode synchronously emits selectionChange on failure', async () => {
    const fake = createFakeEditor();
    fake.setState({ isOpening: false, resolving: false, measurer: 'fixed' });

    await expect(waitForWordEditorReady(fake.editor, { locked: false, fallbackPollMs: 5000 }))
      .rejects.toThrow('Document cannot be edited with shaped fonts');
    // One attempt to enter edit mode + one rollback to view mode; never infinite recursion.
    expect(fake.setModeCalls).toBe(2);
  });
});
