import { configureStore } from '@reduxjs/toolkit';
import { afterEach, expect, it, vi } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '../types/artifact';
import { libraryArtifactListener } from './libraryArtifactListener';
import { setSessionArtifacts } from './slices/artifactSlice';

vi.mock('../services/usageAnalytics', () => ({ reportArtifactDiscovery: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const recordCandidates = vi.fn().mockResolvedValue({ success: true, data: { recorded: 1, ignored: 0 } });
  vi.stubGlobal('window', { electron: { library: { recordCandidates } } });
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = configureStore({ reducer: (state = {}) => state,
    middleware: getDefault => getDefault().prepend(libraryArtifactListener.middleware) });
  const artifact: Artifact = { id: 'a', sessionId: 's', messageId: 'm', type: ArtifactTypeValue.Document,
    title: 'private-title', content: 'private-content', filePath: '/private/report.pdf', createdAt: 100 };
  return { recordCandidates, debug, warn,
    send: (count: number) => store.dispatch(setSessionArtifacts({ sessionId: 's', artifacts: Array.from({ length: count }, (_, i) => ({ ...artifact, id: `a${i}` })) })) };
}
it('keeps candidate IPC batches bounded and logs only counts and timing', async () => {
  const f = fixture(); f.send(101);
  await vi.waitFor(() => expect(f.debug).toHaveBeenCalledTimes(4));
  expect(f.recordCandidates.mock.calls.map(([batch]) => batch.length)).toEqual([100, 1]);
  const output = JSON.stringify(f.debug.mock.calls);
  expect(output).toContain('recorded');
  expect(output).not.toContain('private');
  expect(f.warn).not.toHaveBeenCalled();
});
it.each([false, true])('stops a rejected batch without leaking errors or rejecting the listener (throws=%s)', async throws => {
  const f = fixture();
  if (throws) f.recordCandidates.mockRejectedValue(new Error('private-path token=secret'));
  else f.recordCandidates.mockResolvedValue({ success: false, error: 'private-path token=secret' });
  f.send(101);
  await vi.waitFor(() => expect(f.warn).toHaveBeenCalledOnce());
  expect(f.recordCandidates).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.warn.mock.calls)).not.toMatch(/private|secret/);
});
