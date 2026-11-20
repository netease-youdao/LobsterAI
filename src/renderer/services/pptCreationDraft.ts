import { usesInheritedAgentModel } from '../../shared/agent/modelSelection';
import { UsageEntry } from '../../shared/analytics/usage';
import { type PptCatalog, PptCreation, PptCreationError, type PptExample, type PptExampleMode, type PptPreparedFile, PptWorkflow } from '../../shared/pptCreation/constants';
import { store } from '../store';
import { setDraftAttachments, setDraftCollaborationMode } from '../store/slices/coworkSlice';
import { clearAgentSelectedModel, isSameModelIdentity, type Model, setSelectedModel } from '../store/slices/modelSlice';
import { CoworkCollaborationMode } from '../types/cowork';
import { agentService } from './agent';
import { openExpertDraft } from './expertOnboarding';
import { captureImageCreationDraft, type ImageCreationDraftBackup, restoreImageCreationDraft } from './imageCreationDraft';
import { prepareExpertAnalytics, resetDraftAnalytics } from './usageAnalytics';

export interface PptDraftOptions {
  prompt: string; mode: PptExampleMode; workflow: PptWorkflow; useDemo: boolean;
  templateId?: string; files: PptPreparedFile[];
}
export type PptDraftBackup = ImageCreationDraftBackup & { modelSelection?: { agentId: string; previous?: Model } };

export async function preparePptCreationDraft(
  catalog: PptCatalog, example: PptExample, options: PptDraftOptions, isCurrent: () => boolean,
): Promise<PptDraftBackup | null> {
  const backup = captureImageCreationDraft();
  const previousModels = store.getState().model.selectedModelByAgent;
  const previousDefault = store.getState().model.defaultSelectedModel;
  const attachmentCount = backup.attachments.length + options.files.length
    + (options.useDemo ? example.materials.length : 0) + (options.templateId ? 1 : 0);
  if (!options.prompt.trim() || attachmentCount > PptCreation.MaxAttachments) throw new Error('Invalid PPT draft');
  const agent = await agentService.addPreset(catalog.expertPresetId);
  if (!agent) throw new Error('PPT expert preparation failed');
  // Preparing an inherited expert clears its old override. Allow that expected
  // cleanup while still rejecting model changes made during preparation.
  const expectedModels = { ...previousModels };
  if (usesInheritedAgentModel(agent)) delete expectedModels[agent.id];
  const files = [...options.files];
  if (options.useDemo) {
    for (const material of example.materials) files.push(await window.electron.pptCreation.getAsset({
      version: catalog.version, exampleId: example.id, assetId: material.id,
    }));
  }
  if (options.templateId) {
    const template = catalog.templates.find(item => item.id === options.templateId);
    if (!template) throw new Error('PPT template changed');
    files.push(await window.electron.pptCreation.getAsset({ version: catalog.version, templateId: template.id, assetId: template.file.id }));
  }
  const attachments = [...backup.attachments];
  for (const file of files) {
    const result = await window.electron.dialog.saveInlineFile({ dataBase64: file.base64Data, fileName: file.name, mimeType: file.mimeType, cwd: agent.workingDirectory || undefined });
    if (!result.success || !result.path) throw new Error('PPT material could not be staged');
    attachments.push({ path: result.path, name: file.name, isImage: false });
  }
  if (!isCurrent() || store.getState().cowork.currentSessionId
    || JSON.stringify(store.getState().model.selectedModelByAgent) !== JSON.stringify(expectedModels)
    || JSON.stringify(store.getState().model.defaultSelectedModel) !== JSON.stringify(previousDefault)
    || JSON.stringify(captureImageCreationDraft()) !== JSON.stringify(backup)) return null;
  const recommended = store.getState().model.availableModels.find(model => model.isServerModel
    && model.presetId === catalog.recommendedModelPreset && model.accessible !== false && !model.busy);
  if (!recommended) throw new Error(PptCreationError.ModelUnavailable);
  openExpertDraft(agent, options.prompt);
  store.dispatch(setSelectedModel({ agentId: agent.id, model: recommended }));
  store.dispatch(setDraftAttachments({ draftKey: PptCreation.HomeDraft, attachments }));
  store.dispatch(setDraftCollaborationMode({ draftKey: PptCreation.HomeDraft,
    mode: options.workflow === PptWorkflow.Outline ? CoworkCollaborationMode.Plan : CoworkCollaborationMode.Default }));
  prepareExpertAnalytics(agent.id, catalog.expertPresetId, { entry: UsageEntry.Starter, catalogVersion: catalog.version,
    exampleId: example.id, exampleMode: options.mode, exampleWorkflow: options.workflow });
  return { ...backup, modelSelection: { agentId: agent.id, previous: previousModels[agent.id] } };
}

export function restorePptCreationDraft(backup: PptDraftBackup): boolean {
  const restored = restoreImageCreationDraft(backup);
  if (restored) {
    const selection = backup.modelSelection;
    if (selection) {
      const previous = selection.previous;
      const available = previous && store.getState().model.availableModels.find(model => isSameModelIdentity(model, previous)
        && model.accessible !== false && !model.busy);
      if (available) store.dispatch(setSelectedModel({ agentId: selection.agentId, model: { ...available, presetThinkingLevel: previous.presetThinkingLevel } }));
      else store.dispatch(clearAgentSelectedModel(selection.agentId));
    }
    resetDraftAnalytics();
  }
  return restored;
}
