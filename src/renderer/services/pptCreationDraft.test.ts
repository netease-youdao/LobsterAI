import { AgentModelSelectionMode, AgentSource } from '@shared/agent/constants';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { pptCatalogFixture } from '../../../tests/fixtures/pptCreation';
import { ModelPresetId } from '../../shared/modelPresets/constants';
import { PptCreation, PptCreationError, PptExampleMode, PptWorkflow } from '../../shared/pptCreation/constants';
import { store } from '../store';
import { setAgents, setCurrentAgentId } from '../store/slices/agentSlice';
import { invalidateAuthAccountContext } from '../store/slices/authSlice';
import { clearCurrentSession, setDraftAttachments, setDraftCollaborationMode, setDraftPrompt } from '../store/slices/coworkSlice';
import { setActiveKitIds } from '../store/slices/kitSlice';
import { clearAgentSelectedModel, setSelectedModel, setServerModels } from '../store/slices/modelSlice';
import { setActiveSkillIds } from '../store/slices/skillSlice';
import type { Agent } from '../types/agent';
import { CoworkCollaborationMode } from '../types/cowork';
import { captureImageCreationDraft } from './imageCreationDraft';
import { modelPresetToModel } from './modelPresets';
import { type PptDraftOptions, preparePptCreationDraft, restorePptCreationDraft } from './pptCreationDraft';
import { prepareExpertAnalytics } from './usageAnalytics';

vi.mock('./cowork', () => ({ coworkService: { clearSession: () => store.dispatch(clearCurrentSession()) } }));
vi.mock('./usageAnalytics', () => ({ prepareExpertAnalytics: vi.fn(), resetDraftAnalytics: vi.fn() }));
const expert: Agent = {
  id: 'ppt-expert', name: 'PPT expert', description: '', systemPrompt: 'User-customized expert instructions', identity: '',
  model: '', thinkingLevel: '', workingDirectory: '', icon: '', skillIds: ['pptx', 'xlsx'],
  subagentAllowAgentIds: [], enabled: true, pinned: false, isDefault: false, source: AgentSource.Preset,
  presetId: 'powerpoint-deck-builder', createdAt: 1, updatedAt: 1,
};
const addPreset = vi.fn(), getAsset = vi.fn(), saveInlineFile = vi.fn(), setPreference = vi.fn();
const key = PptCreation.HomeDraft;
const fast = modelPresetToModel({ presetId: ModelPresetId.Balanced, costMultiplier: 0.5, accessible: true, supportsImage: true });
const flagship = modelPresetToModel({ presetId: ModelPresetId.Ultimate, costMultiplier: 2, accessible: true, supportsImage: true });
const options = (): PptDraftOptions => ({ prompt: 'Build my presentation', mode: PptExampleMode.Guided,
  workflow: PptWorkflow.Outline, useDemo: true, files: [] });
beforeEach(() => {
  vi.stubGlobal('window', { electron: { agents: { addPreset }, pptCreation: { getAsset }, dialog: { saveInlineFile }, modelPresets: { setPreference } } });
  addPreset.mockReset().mockResolvedValue(expert);
  setPreference.mockReset().mockResolvedValue({ success: true });
  getAsset.mockReset().mockResolvedValue({ name: 'quarterly.csv', mimeType: 'text/csv', base64Data: 'cXVhcnRlcg==' });
  saveInlineFile.mockReset().mockResolvedValue({ success: true, path: '/task-materials/quarterly.csv' });
  vi.mocked(prepareExpertAnalytics).mockClear();
  store.dispatch(clearCurrentSession()); store.dispatch(setAgents([])); store.dispatch(setCurrentAgentId('main'));
  store.dispatch(setServerModels([fast, flagship])); store.dispatch(clearAgentSelectedModel(expert.id));
  store.dispatch(setDraftPrompt({ sessionId: key, draft: 'Unfinished user draft' }));
  store.dispatch(setDraftAttachments({ draftKey: key, attachments: [{ path: '/original/notes.txt', name: 'notes.txt' }] }));
  store.dispatch(setActiveKitIds(['previous-kit'])); store.dispatch(setActiveSkillIds(['previous-skill']));
  store.dispatch(setDraftCollaborationMode({ draftKey: key, mode: CoworkCollaborationMode.Default }));
});
afterEach(() => vi.unstubAllGlobals());

test('prepares a planning draft without submitting, preserves attachments and can restore the old draft', async () => {
  const catalog = pptCatalogFixture(), before = captureImageCreationDraft();
  const sessions = store.getState().cowork.sessions;
  const backup = await preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true);
  expect(backup).toMatchObject(before); expect(store.getState().cowork.sessions).toEqual(sessions);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(fast);
  expect(store.getState().cowork.currentSessionId).toBeNull();
  expect(store.getState().cowork.draftAttachments[key].map(file => file.path)).toEqual(['/original/notes.txt', '/task-materials/quarterly.csv']);
  expect(store.getState().cowork.draftCollaborationModes[key]).toBe(CoworkCollaborationMode.Plan);
  expect(prepareExpertAnalytics).toHaveBeenCalledWith(expert.id, catalog.expertPresetId, expect.objectContaining({
    exampleId: catalog.examples[0].id, exampleMode: PptExampleMode.Guided, exampleWorkflow: PptWorkflow.Outline, catalogVersion: catalog.version,
  }));
  expect(restorePptCreationDraft(backup!)).toBe(true); expect(captureImageCreationDraft()).toEqual(before);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toBeUndefined();
});
test('a download or staging failure leaves the original draft intact', async () => {
  const catalog = pptCatalogFixture(), before = captureImageCreationDraft();
  getAsset.mockRejectedValueOnce(new Error('Checksum mismatch'));
  await expect(preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true)).rejects.toThrow('Checksum');
  expect(captureImageCreationDraft()).toEqual(before);
  saveInlineFile.mockResolvedValueOnce({ success: false });
  await expect(preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true)).rejects.toThrow('staged');
  expect(captureImageCreationDraft()).toEqual(before);
});
test('existing attachments and automatic example materials count toward the limit before any preparation', async () => {
  const catalog = pptCatalogFixture();
  store.dispatch(setDraftAttachments({ draftKey: key, attachments: Array.from({ length: PptCreation.MaxAttachments }, (_, index) => ({
    path: `/original/note-${index}.txt`, name: `note-${index}.txt`,
  })) }));
  const before = captureImageCreationDraft();
  await expect(preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true)).rejects.toThrow('Invalid PPT draft');
  expect(addPreset).not.toHaveBeenCalled();
  expect(getAsset).not.toHaveBeenCalled();
  expect(saveInlineFile).not.toHaveBeenCalled();
  expect(captureImageCreationDraft()).toEqual(before);
});
test('a newer user edit wins over an asynchronous material preparation', async () => {
  const catalog = pptCatalogFixture();
  getAsset.mockImplementationOnce(async () => {
    store.dispatch(setDraftPrompt({ sessionId: key, draft: 'My newer draft' }));
    return { name: 'quarterly.csv', mimeType: 'text/csv', base64Data: 'cXVhcnRlcg==' };
  });
  expect(await preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true)).toBeNull();
  expect(store.getState().cowork.draftPrompts[key]).toBe('My newer draft');
  expect(store.getState().agent.currentAgentId).toBe('main');
});
test('account changes invalidate both in-flight preparation and an earlier restore', async () => {
  const catalog = pptCatalogFixture(), before = captureImageCreationDraft();
  getAsset.mockImplementationOnce(async () => {
    store.dispatch(invalidateAuthAccountContext());
    return { name: 'quarterly.csv', mimeType: 'text/csv', base64Data: 'cXVhcnRlcg==' };
  });
  expect(await preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true)).toBeNull();
  expect(restorePptCreationDraft(before)).toBe(false);
});

test('uses the current configured preset and restores the previous expert selection', async () => {
  const catalog = pptCatalogFixture();
  store.dispatch(setSelectedModel({ agentId: expert.id, model: flagship }));
  const backup = await preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(fast);
  expect(restorePptCreationDraft(backup!)).toBe(true);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(flagship);
  catalog.recommendedModelPreset = ModelPresetId.Ultimate;
  await preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(flagship);
});

test('repeated examples tolerate inherited model cleanup and still apply the configured recommendation', async () => {
  const catalog = pptCatalogFixture();
  addPreset.mockResolvedValue({ ...expert, modelSelectionMode: AgentModelSelectionMode.Inherit });
  const first = await preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true);
  expect(first).not.toBeNull();
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(fast);

  catalog.recommendedModelPreset = ModelPresetId.Ultimate;
  const second = await preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true);
  expect(second).not.toBeNull();
  expect(setPreference).toHaveBeenLastCalledWith(expert.id, null);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(flagship);
  expect(restorePptCreationDraft(second!)).toBe(true);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(fast);
});

test.each([{ accessible: false }, { busy: true }])('an unavailable recommendation never silently uses a different model: %j', async restriction => {
  const catalog = pptCatalogFixture(), before = captureImageCreationDraft();
  store.dispatch(setServerModels([{ ...fast, ...restriction }, flagship]));
  await expect(preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true)).rejects.toThrow(PptCreationError.ModelUnavailable);
  expect(captureImageCreationDraft()).toEqual(before);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toBeUndefined();
});

test.each([AgentModelSelectionMode.Explicit, AgentModelSelectionMode.Inherit])('a user model change during material preparation is not overwritten in %s mode', async modelSelectionMode => {
  const catalog = pptCatalogFixture(), before = captureImageCreationDraft();
  addPreset.mockResolvedValue({ ...expert, modelSelectionMode });
  getAsset.mockImplementationOnce(async () => {
    store.dispatch(setSelectedModel({ agentId: expert.id, model: flagship }));
    return { name: 'quarterly.csv', mimeType: 'text/csv', base64Data: 'cXVhcnRlcg==' };
  });
  expect(await preparePptCreationDraft(catalog, catalog.examples[0], options(), () => true)).toBeNull();
  expect(captureImageCreationDraft()).toEqual(before);
  expect(store.getState().model.selectedModelByAgent[expert.id]).toEqual(flagship);
});
