import { AgentSource } from '@shared/agent/constants';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { ImageCreation } from '../../shared/imageCreation/constants';
import { store } from '../store';
import { setAgents, setCurrentAgentId } from '../store/slices/agentSlice';
import { invalidateAuthAccountContext } from '../store/slices/authSlice';
import { clearCurrentSession, setDraftAttachments, setDraftCollaborationMode, setDraftPrompt, setDraftSkillIds } from '../store/slices/coworkSlice';
import { setActiveKitIds } from '../store/slices/kitSlice';
import { setActiveSkillIds } from '../store/slices/skillSlice';
import type { Agent } from '../types/agent';
import { CoworkCollaborationMode } from '../types/cowork';
import { prepareCoworkPromptPayload } from './coworkPromptPayload';
import { captureImageCreationDraft, prepareImageCreationDraft, restoreImageCreationDraft } from './imageCreationDraft';

vi.mock('./cowork', () => ({ coworkService: { clearSession: () => store.dispatch(clearCurrentSession()) } }));

const expert: Agent = {
  id: 'image-expert', name: 'Image expert', description: '', systemPrompt: '', identity: '',
  model: '', thinkingLevel: '', workingDirectory: '', icon: '', skillIds: ['seedream'],
  subagentAllowAgentIds: [], enabled: true, pinned: false, isDefault: false, source: AgentSource.Preset,
  presetId: 'image-creation-partner', createdAt: 1, updatedAt: 1,
};
const key = ImageCreation.HomeDraft;
const addPreset = vi.fn();
const saveInlineFile = vi.fn();

beforeEach(() => {
  vi.stubGlobal('window', { electron: { agents: { addPreset }, dialog: { saveInlineFile } } });
  addPreset.mockReset().mockResolvedValue(expert);
  saveInlineFile.mockReset().mockResolvedValue({ success: true, path: '/uploads/reference.png' });
  store.dispatch(clearCurrentSession());
  store.dispatch(setAgents([]));
  store.dispatch(setCurrentAgentId('main'));
  store.dispatch(setDraftPrompt({ sessionId: key, draft: 'My unfinished task' }));
  store.dispatch(setDraftAttachments({ draftKey: key, attachments: [{ name: 'notes.txt', path: '/notes.txt' }] }));
  store.dispatch(setActiveKitIds(['old-kit']));
  store.dispatch(setActiveSkillIds(['old-skill']));
  store.dispatch(setDraftSkillIds({ draftKey: key, skillIds: ['old-skill'], inheritedSkillIds: ['old-skill'] }));
  store.dispatch(setDraftCollaborationMode({ draftKey: key, mode: CoworkCollaborationMode.Plan }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('preparing a referenced example leaves tasks untouched and can restore the entire previous draft', async () => {
  const before = captureImageCreationDraft();
  const sessions = store.getState().cowork.sessions;
  const backup = await prepareImageCreationDraft(expert.presetId!, '@图片1 Use this photo', {
    name: 'reference.png', mimeType: 'image/png', base64Data: 'aGVsbG8=',
  }, () => true);
  expect(backup).toEqual(before);
  expect(store.getState().cowork.sessions).toEqual(sessions);
  expect(store.getState().cowork.currentSessionId).toBeNull();
  expect(store.getState().cowork.draftAttachments[key]).toEqual([expect.objectContaining({
    name: 'reference.png', path: '/uploads/reference.png', dataUrl: 'data:image/png;base64,aGVsbG8=', isImage: true,
  })]);
  expect(saveInlineFile).toHaveBeenCalledWith({ dataBase64: 'aGVsbG8=', fileName: 'reference.png', mimeType: 'image/png', cwd: undefined });
  const payload = await prepareCoworkPromptPayload({ basePrompt: store.getState().cowork.draftPrompts[key],
    attachments: store.getState().cowork.draftAttachments[key], selectedTextSnippets: [], modelSupportsImage: true,
    fileLabel: 'File', folderLabel: 'Folder' });
  expect(payload.success && payload.payload.mediaReferences?.[0]?.localPath).toBe('/uploads/reference.png');
  expect(store.getState().skill.activeSkillIds).toEqual(expert.skillIds);
  expect(restoreImageCreationDraft(backup!)).toBe(true);
  expect(captureImageCreationDraft()).toEqual(before);
});

test('a failed expert installation preserves the original draft', async () => {
  addPreset.mockResolvedValueOnce(null);
  const before = captureImageCreationDraft();
  await expect(prepareImageCreationDraft(expert.presetId!, 'Example', undefined, () => true)).rejects.toThrow();
  expect(captureImageCreationDraft()).toEqual(before);
});

test('the original preparation error reaches the example caller without changing its draft', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const error = new Error('Expert catalog integrity check failed');
  addPreset.mockRejectedValueOnce(error);
  const before = captureImageCreationDraft();

  await expect(prepareImageCreationDraft(expert.presetId!, 'Example', undefined, () => true)).rejects.toBe(error);
  expect(captureImageCreationDraft()).toEqual(before);
  expect(saveInlineFile).not.toHaveBeenCalled();
});

test('a failed reference save preserves the previous draft instead of sending an in-memory-only image', async () => {
  saveInlineFile.mockResolvedValueOnce({ success: false });
  const before = captureImageCreationDraft();
  await expect(prepareImageCreationDraft(expert.presetId!, 'Use this image', {
    name: 'reference.png', mimeType: 'image/png', base64Data: 'aGVsbG8=',
  }, () => true)).rejects.toThrow('could not be saved');
  expect(captureImageCreationDraft()).toEqual(before);
});

test('late preparation cannot replace a draft edited while the expert installs', async () => {
  let finish!: (agent: Agent) => void;
  addPreset.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = prepareImageCreationDraft(expert.presetId!, 'Example', undefined, () => true);
  store.dispatch(setDraftPrompt({ sessionId: key, draft: 'Newer user text' }));
  finish(expert);
  expect(await pending).toBeNull();
  expect(store.getState().cowork.draftPrompts[key]).toBe('Newer user text');
  expect(store.getState().agent.currentAgentId).toBe('main');
});

test('closing the preview invalidates an in-flight preparation', async () => {
  const before = captureImageCreationDraft();
  expect(await prepareImageCreationDraft(expert.presetId!, 'Example', undefined, () => false)).toBeNull();
  expect(captureImageCreationDraft()).toEqual(before);
});

test('an account change prevents both late preparation and restoring the previous account draft', async () => {
  const backup = captureImageCreationDraft();
  let finish!: (agent: Agent) => void;
  addPreset.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = prepareImageCreationDraft(expert.presetId!, 'Example', undefined, () => true);
  store.dispatch(invalidateAuthAccountContext());
  finish(expert);
  expect(await pending).toBeNull();
  expect(restoreImageCreationDraft(backup)).toBe(false);
  expect(store.getState().cowork.draftPrompts[key]).toBe(backup.prompt);
});
