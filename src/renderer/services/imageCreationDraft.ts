import { ImageCreation, type ImageExampleReference } from '../../shared/imageCreation/constants';
import { store } from '../store';
import {
  setDraftAttachments, setDraftBrowserAnnotationBatches, setDraftCollaborationMode, setDraftKitIds,
  setDraftPrompt, setDraftSelectedTextSnippets, setDraftSkillIds,
} from '../store/slices/coworkSlice';
import { setActiveKitIds } from '../store/slices/kitSlice';
import { setActiveSkillIds } from '../store/slices/skillSlice';
import { CoworkCollaborationMode } from '../types/cowork';
import { agentService } from './agent';
import { openExpertDraft } from './expertOnboarding';

export function captureImageCreationDraft() {
  const state = store.getState();
  const key = ImageCreation.HomeDraft;
  return {
    owner: state.auth.ownerAccountKey, generation: state.auth.accountGeneration,
    agentId: state.agent.currentAgentId,
    prompt: state.cowork.draftPrompts[key] ?? '',
    attachments: state.cowork.draftAttachments[key] ?? [],
    snippets: state.cowork.draftSelectedTextSnippets[key] ?? [],
    annotations: state.cowork.draftBrowserAnnotationBatches[key] ?? [],
    kitIds: state.kit.activeKitIds,
    skillIds: state.skill.activeSkillIds,
    inheritedSkillIds: state.cowork.draftInheritedSkillIds[key] ?? [],
    mode: state.cowork.draftCollaborationModes[key] ?? CoworkCollaborationMode.Default,
  };
}
export type ImageCreationDraftBackup = ReturnType<typeof captureImageCreationDraft>;

export interface PreparedImageExampleReference extends ImageExampleReference { localPath: string }

export async function stageImageCreationReference(
  reference: ImageExampleReference, workingDirectory?: string,
): Promise<PreparedImageExampleReference> {
  let transport = reference;
  // Keep compact WebP delivery assets, but stage a lossless PNG for providers
  // whose vision/image-input endpoints do not accept WebP.
  if (reference.mimeType === 'image/webp') {
    const image = new Image();
    image.src = `data:${reference.mimeType};base64,${reference.base64Data}`;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > ImageCreation.MaxReferencePixels) {
      throw new Error('Invalid image example dimensions');
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image example conversion unavailable');
    context.drawImage(image, 0, 0);
    transport = { name: reference.name.replace(/\.[^.]+$/, '') + '.png', mimeType: 'image/png',
      base64Data: canvas.toDataURL('image/png').split(',')[1] };
  }
  const result = await window.electron.dialog.saveInlineFile({
    dataBase64: transport.base64Data, fileName: transport.name, mimeType: transport.mimeType,
    cwd: workingDirectory || undefined,
  });
  if (!result.success || !result.path) throw new Error('Image example attachment could not be saved');
  return { ...transport, localPath: result.path };
}

export async function prepareImageCreationDraft(
  presetId: string, prompt: string, reference: ImageExampleReference | undefined, isCurrent: () => boolean,
): Promise<ImageCreationDraftBackup | null> {
  const backup = captureImageCreationDraft();
  const agent = await agentService.addPreset(presetId);
  if (!agent) throw new Error('Image expert preparation failed');
  const staged = reference ? await stageImageCreationReference(reference, agent.workingDirectory) : undefined;
  // Installing an expert can take a while. Never overwrite a draft edited, sent,
  // navigated away from, or switched to another account during that interval.
  if (!isCurrent() || JSON.stringify(captureImageCreationDraft()) !== JSON.stringify(backup)
    || store.getState().cowork.currentSessionId) return null;
  openExpertDraft(agent, prompt);
  if (staged) {
    store.dispatch(setDraftAttachments({ draftKey: ImageCreation.HomeDraft, attachments: [{
      path: staged.localPath, name: staged.name, isImage: true,
      dataUrl: `data:${staged.mimeType};base64,${staged.base64Data}`,
    }] }));
  }
  return backup;
}

export function restoreImageCreationDraft(backup: ImageCreationDraftBackup): boolean {
  const state = store.getState();
  if (state.cowork.currentSessionId || state.auth.ownerAccountKey !== backup.owner
    || state.auth.accountGeneration !== backup.generation) return false;
  const draftKey = ImageCreation.HomeDraft;
  agentService.switchAgent(backup.agentId);
  store.dispatch(setDraftPrompt({ sessionId: draftKey, draft: backup.prompt }));
  store.dispatch(setDraftAttachments({ draftKey, attachments: backup.attachments }));
  store.dispatch(setDraftSelectedTextSnippets({ draftKey, snippets: backup.snippets }));
  store.dispatch(setDraftBrowserAnnotationBatches({ draftKey, batches: backup.annotations }));
  store.dispatch(setDraftKitIds({ draftKey, kitIds: backup.kitIds }));
  store.dispatch(setDraftSkillIds({ draftKey, skillIds: backup.skillIds, inheritedSkillIds: backup.inheritedSkillIds }));
  store.dispatch(setActiveKitIds(backup.kitIds));
  store.dispatch(setActiveSkillIds(backup.skillIds));
  store.dispatch(setDraftCollaborationMode({ draftKey, mode: backup.mode }));
  return true;
}
