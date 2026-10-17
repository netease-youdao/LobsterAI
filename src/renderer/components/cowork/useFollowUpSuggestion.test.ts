// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestFollowUpSuggestion } from '../../services/followUpSuggestion';
import type { CoworkSession } from '../../types/cowork';
import { handleFollowUpSuggestionKey } from './followUpSuggestion';
import FollowUpSuggestionHint from './FollowUpSuggestionHint';
import { useFollowUpSuggestion } from './useFollowUpSuggestion';

vi.mock('../../services/followUpSuggestion', () => ({ requestFollowUpSuggestion: vi.fn() }));
type Options = Parameters<typeof useFollowUpSuggestion>[0];
let options: Options;
let latest: ReturnType<typeof useFollowUpSuggestion>;
let root: Root;
let testGeneration = 0;
const acceptDraft = vi.fn();
const submit = vi.fn();
const session = (id: string) => ({ id, status: 'completed', messages: [
  { id: `${id}-u`, type: 'user', content: `Question ${id}` }, { id: `${id}-a`, type: 'assistant', content: `Answer ${id}` },
] }) as CoworkSession;
function Harness() {
  const [draft, setDraft] = React.useState('');
  latest = useFollowUpSuggestion({ ...options, enabled: options.enabled && draft.length === 0 });
  return React.createElement('div', null,
    latest.suggestion && React.createElement(FollowUpSuggestionHint, { text: latest.suggestion, className: '' }),
    React.createElement('textarea', {
      value: draft,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.currentTarget.value),
      onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (handleFollowUpSuggestionKey({ event, suggestion: latest.suggestion, inputValue: event.currentTarget.value,
          accept: text => { setDraft(text); acceptDraft(text); }, dismiss: latest.dismiss })) return;
        if (event.key === 'Enter' && draft) submit(draft);
      },
    }),
  );
}
const render = async (next: Partial<Options> = {}) => {
  options = { ...options, ...next };
  await act(async () => root.render(React.createElement(Harness)));
};
const advance = async () => act(async () => { await vi.advanceTimersByTimeAsync(700); });
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  options = { enabled: true, accountScope: `user1:${++testGeneration}`, language: 'zh', session: session('a') };
  root = createRoot(document.body.appendChild(document.createElement('div')));
  vi.mocked(requestFollowUpSuggestion).mockReset().mockResolvedValue('请给出具体操作步骤。');
  acceptDraft.mockReset(); submit.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('follow-up lifecycle', () => {
  it('waits for a finished idle composer and hides when the user types or work starts', async () => {
    await render({ enabled: false }); await advance();
    expect(requestFollowUpSuggestion).not.toHaveBeenCalled();
    await render({ enabled: true }); await advance();
    expect(latest.suggestion).toBe('请给出具体操作步骤。');
    await render({ enabled: false }); expect(latest.suggestion).toBeNull();
    await render({ enabled: true }); await advance();
    expect(requestFollowUpSuggestion).toHaveBeenCalledTimes(1);
  });
  it('rejects delayed responses after switching sessions', async () => {
    let resolveA!: (text: string) => void;
    vi.mocked(requestFollowUpSuggestion).mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }));
    await render(); await advance();
    await render({ session: session('b') }); await advance();
    await act(async () => resolveA('stale A'));
    expect(latest.suggestion).toBe('请给出具体操作步骤。');
  });
  it('never applies a result over a draft and reuses the single pending request', async () => {
    let finish!: (text: string) => void;
    vi.mocked(requestFollowUpSuggestion).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await advance(); await render({ enabled: false });
    await act(async () => finish('the suggestion'));
    expect(latest.suggestion).toBeNull();
    await render({ enabled: true }); await advance();
    expect(latest.suggestion).toBe('the suggestion');
    expect(requestFollowUpSuggestion).toHaveBeenCalledTimes(1);
  });
  it('dismisses/accepts a suggestion for the turn and offers one after the next answer', async () => {
    await render(); await advance(); await act(async () => latest.dismiss());
    await render({ enabled: false }); await render({ enabled: true }); await advance();
    expect(latest.suggestion).toBeNull();
    const next = session('a'); next.messages[1].id = 'new-answer';
    await render({ session: next }); await advance();
    expect(latest.suggestion).toBeTruthy();
  });
  it('fences account switches and does not reuse another login generation cache', async () => {
    await render(); await advance();
    const stillCurrent = vi.mocked(requestFollowUpSuggestion).mock.calls[0][2]!;
    expect(stillCurrent()).toBe(true);
    await render({ accountScope: 'user2:1' });
    expect(stillCurrent()).toBe(false);
    expect(latest.suggestion).toBeNull();
    await advance(); expect(requestFollowUpSuggestion).toHaveBeenCalledTimes(2);
  });
  it('does not retry a failed suggestion on every rerender', async () => {
    vi.mocked(requestFollowUpSuggestion).mockResolvedValue(null);
    await render(); await advance();
    await render({ session: { ...options.session! } }); await advance();
    expect(latest.suggestion).toBeNull(); expect(requestFollowUpSuggestion).toHaveBeenCalledTimes(1);
    vi.mocked(requestFollowUpSuggestion).mockResolvedValue('Try this next step.');
    await render({ session: session('next-turn') }); await advance();
    expect(latest.suggestion).toBe('Try this next step.');
  });
  it('reuses completed results after remounting and remembers dismissed turns', async () => {
    await render(); await advance();
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await render(); await advance();
    expect(latest.suggestion).toBeTruthy(); expect(requestFollowUpSuggestion).toHaveBeenCalledTimes(1);
    await act(async () => latest.dismiss());
    await act(async () => root.unmount());
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await render(); await advance();
    expect(latest.suggestion).toBeNull(); expect(requestFollowUpSuggestion).toHaveBeenCalledTimes(1);
  });
  it('invalidates the pending network account guard immediately on unmount', async () => {
    await render(); await advance();
    const stillCurrent = vi.mocked(requestFollowUpSuggestion).mock.calls[0][2]!;
    await act(async () => root.unmount());
    expect(stillCurrent()).toBe(false);
    root = createRoot(document.body.appendChild(document.createElement('div')));
  });
  it('renders ghost text and accepts Tab as a draft without submitting a turn', async () => {
    await render(); await advance();
    const textarea = document.querySelector('textarea')!;
    expect(textarea.value).toBe('');
    expect(document.querySelector('[data-follow-up-suggestion]')?.textContent).toContain('请给出具体操作步骤。');
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(textarea.value).toBe('请给出具体操作步骤。');
    expect(acceptDraft).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector('[data-follow-up-suggestion]')).toBeNull();
  });
  it('does not overwrite text already in the live textarea before React rerenders', async () => {
    await render(); await advance();
    const textarea = document.querySelector('textarea')!;
    textarea.value = 'My own question';
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(textarea.value).toBe('My own question');
    expect(acceptDraft).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
