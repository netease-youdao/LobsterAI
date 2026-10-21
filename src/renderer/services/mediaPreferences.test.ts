import {
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';

import {
  MediaPreferenceMode,
  type MediaPreferenceResult,
  type MediaSelection,
  MediaSelectionMode,
  MediaType,
} from '../../shared/media/defaultPolicy';
import type { AppDispatch } from '../store';
import { refreshMediaPreferences, toggleMediaModelSelection } from './mediaPreferences';

const mocked = vi.hoisted(() => ({
  state: {
    auth: { ownerAccountKey: 'account-a', accountGeneration: 1 },
    agent: { currentAgentId: 'main' },
    cowork: { mediaSelection: {} as Record<string, MediaSelection> },
  },
  getPreferences: vi.fn(),
  setPreference: vi.fn(),
}));
vi.mock('../store', () => ({ store: { getState: () => mocked.state } }));
vi.mock('../store/slices/coworkSlice', () => ({
  setMediaSelection: (payload: unknown) => ({ type: 'media-selection', payload }),
}));
vi.mock('./logReporter', () => ({ LogReporterAction: { MediaLifecycle: 'media' }, reportYdAnalyzer: vi.fn() }));
vi.mock('./usageAnalytics', () => ({ getDraftAnalytics: () => ({}), getSessionUsageContext: () => ({}) }));

const scope = { draftKey: '__home__', ownerAccountKey: 'account-a', accountGeneration: 1 };
const result = (selection: MediaSelection, revision = 0): MediaPreferenceResult => ({
  success: true, state: { ownerAccountKey: scope.ownerAccountKey, selection,
    preferences: { schemaVersion: 1, revision, image: { mode: MediaPreferenceMode.Inherit },
      video: { mode: MediaPreferenceMode.Inherit } } },
});
const dispatch = vi.fn(action => {
  mocked.state.cowork.mediaSelection[action.payload.draftKey] = action.payload.selection;
}) as unknown as AppDispatch;

beforeEach(() => {
  vi.clearAllMocks();
  mocked.state.auth = { ownerAccountKey: 'account-a', accountGeneration: 1 };
  mocked.state.cowork.mediaSelection = {};
  vi.stubGlobal('window', { electron: { media: {
    getPreferences: mocked.getPreferences, setPreference: mocked.setPreference,
  } } });
});

test('a stale refresh cannot overwrite a model clicked while it was loading', async () => {
  let resolveLoad!: (value: MediaPreferenceResult) => void;
  mocked.getPreferences.mockImplementation(() => new Promise(resolve => { resolveLoad = resolve; }));
  const refresh = refreshMediaPreferences(dispatch, scope);
  mocked.setPreference.mockResolvedValue(result({ mode: MediaSelectionMode.Image, modelId: 'mine', preferencesRevision: 1 }, 1));
  await toggleMediaModelSelection(dispatch, scope, undefined, MediaType.Image, { modelId: 'mine', displayName: 'Mine' });
  resolveLoad(result({ mode: MediaSelectionMode.Image, modelId: 'default' }));
  await refresh;
  expect(mocked.state.cowork.mediaSelection.__home__.modelId).toBe('mine');
});

test('clicking a default model off persists off rather than an empty selection', async () => {
  mocked.setPreference.mockResolvedValue(result({ mode: MediaSelectionMode.None, preferencesRevision: 1 }, 1));
  await toggleMediaModelSelection(dispatch, scope, { mode: MediaSelectionMode.Image, imageModelId: 'default' },
    MediaType.Image, { modelId: 'default', displayName: 'Default' });
  expect(mocked.setPreference).toHaveBeenCalledWith('account-a', MediaType.Image, { mode: MediaPreferenceMode.Off });
  expect(mocked.state.cowork.mediaSelection.__home__.mode).toBe(MediaSelectionMode.None);
});

test('account changes discard an in-flight response without touching the next account', async () => {
  let resolveLoad!: (value: MediaPreferenceResult) => void;
  mocked.getPreferences.mockImplementation(() => new Promise(resolve => { resolveLoad = resolve; }));
  const load = refreshMediaPreferences(dispatch, scope);
  mocked.state.auth = { ownerAccountKey: 'account-b', accountGeneration: 2 };
  resolveLoad(result({ mode: MediaSelectionMode.Auto }));
  await load;
  expect(dispatch).not.toHaveBeenCalled();
});

test('an older preference revision cannot overwrite a newer acknowledged one', async () => {
  mocked.state.cowork.mediaSelection.__home__ = { mode: MediaSelectionMode.None, preferencesRevision: 4 };
  mocked.getPreferences.mockResolvedValue(result({ mode: MediaSelectionMode.Auto, preferencesRevision: 3 }, 3));
  await refreshMediaPreferences(dispatch, scope);
  expect(mocked.state.cowork.mediaSelection.__home__.mode).toBe(MediaSelectionMode.None);
});
