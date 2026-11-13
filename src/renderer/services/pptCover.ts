import { MediaTaskStatus } from '../../shared/media/constants';
import { MediaPreferenceMode, MediaSelectionMode, MediaSelectionSource, MediaType } from '../../shared/media/defaultPolicy';
import { type PptCatalog, type PptPreparedFile } from '../../shared/pptCreation/constants';
import { buildCoverImagePrompt, CoverTaskState, defaultCoverStyle, layoutCoverText, PptCover, type PptCoverFields } from '../../shared/pptCreation/cover';
import { store } from '../store';
import { CoworkSessionStatusValue } from '../types/cowork';
import type { MediaModel } from '../types/mediaGeneration';
import { agentService } from './agent';
import { i18nService } from './i18n';

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
export const coverOwner = () => `${store.getState().auth.ownerAccountKey}:${store.getState().auth.accountGeneration}`;
export async function coverImageModel(catalog: PptCatalog): Promise<MediaModel> {
  const response = await window.electron.media.getModels(MediaType.Image);
  const model = (response.models as MediaModel[] | undefined)?.find(model => model.modelId === (catalog.coverImageModel ?? PptCover.DefaultImageModel));
  if (!response.success || !model) throw new Error(i18nService.t('pptCoverModelUnavailable'));
  return model;
}

export async function startCoverImage(catalog: PptCatalog, exampleId: string, subject: string, reference: string, isCurrent: () => boolean): Promise<string> {
  const owner = coverOwner();
  const model = await coverImageModel(catalog);
  const recommended = store.getState().model.availableModels.find(item => item.isServerModel
    && item.presetId === catalog.recommendedModelPreset && item.accessible !== false && !item.busy);
  if (!recommended) throw new Error(i18nService.t('pptCreationModelUnavailable'));
  const agent = await agentService.addPreset('image-creation-partner');
  if (!agent) throw new Error(i18nService.t('pptCoverGenerationFailed'));
  const config = await window.electron.cowork.getConfig();
  const workingDirectory = agent.workingDirectory || config.config?.workingDirectory;
  if (!workingDirectory) throw new Error(i18nService.t('pptCoverGenerationFailed'));
  const staged = await window.electron.dialog.saveInlineFile({ dataBase64: reference, fileName: 'cover-style.png', mimeType: 'image/png', cwd: workingDirectory });
  if (!staged.success || !staged.path) throw new Error(i18nService.t('pptCoverGenerationFailed'));
  if (!isCurrent() || owner !== coverOwner()) throw new Error(i18nService.t('pptCreationDraftChanged'));
  const language = i18nService.getLanguage();
  // This is a normal, billed client task. The explicit button authorizes one image
  // for this turn only; it does not alter the user's global media preference.
  const result = await window.electron.cowork.startSession({
    pptCover: { version: catalog.version, exampleId },
    title: `${i18nService.t('pptCoverImageTask')}: ${subject.slice(0, 32)}`,
    prompt: `${buildCoverImagePrompt(subject, (catalog.coverStylePrompt ?? defaultCoverStyle)[language])}\nReference image: @cover-style (${staged.path}). Use this reference in the image tool's images parameter.`,
    cwd: workingDirectory, agentId: agent.id,
    modelPresetId: catalog.recommendedModelPreset, activeSkillIds: [],
    mediaSelection: { mode: MediaSelectionMode.Image, imageModelId: model.modelId, modelId: model.modelId,
      modelName: model.displayName, imagePreference: MediaPreferenceMode.Selected, imageSource: MediaSelectionSource.User,
      videoPreference: MediaPreferenceMode.Off },
    mediaReferences: [{ token: '@cover-style', mediaType: MediaType.Image, index: 1, fileId: 'cover-style',
      fileName: 'cover-style.png', mimeType: 'image/png', localPath: staged.path, role: 'reference_image' }],
  });
  if (!result.success || !result.session) {
    console.warn('[PptCover] Could not start image task:', result.error);
    throw new Error(i18nService.t('pptCoverGenerationFailed'));
  }
  return result.session.id;
}

export async function inspectCoverImage(sessionId: string) {
  const response = await window.electron.cowork.getSession(sessionId);
  if (!response.success || !response.session) throw new Error(i18nService.t('pptCoverGenerationFailed'));
  const messages = [...response.session.messages].reverse();
  let submitted = false;
  for (const message of messages) {
    const details = record(message.metadata?.toolResultDetails);
    submitted ||= typeof details.taskId === 'string' || typeof details.taskId === 'number';
    const assets = Array.isArray(details.assets) ? details.assets.map(record) : [];
    const image = assets.find(asset => (asset.type === MediaType.Image || asset.mimeType === 'image/png')
      && typeof asset.filePath === 'string');
    if (image) return { state: CoverTaskState.Ready, path: String(image.filePath), taskId: String(details.taskId ?? ''), model: String(details.model ?? '') };
    if ([MediaTaskStatus.Failed, MediaTaskStatus.Cancelled, MediaTaskStatus.Timeout].some(status => status === details.status)) {
      return { state: CoverTaskState.Failed, error: String(details.errorMessage || i18nService.t('pptCoverGenerationFailed')) };
    }
  }
  if (!submitted && response.session.status !== CoworkSessionStatusValue.Running) {
    return { state: CoverTaskState.Failed, error: i18nService.t('pptCoverGenerationFailed') };
  }
  return { state: CoverTaskState.Running };
}

export async function readCoverImage(path: string): Promise<string> {
  const result = await window.electron.dialog.readFileAsDataUrl(path);
  if (!result.success || !result.dataUrl?.startsWith('data:image/')) throw new Error(i18nService.t('pptCoverGenerationFailed'));
  const image = await loadCoverBitmap(result.dataUrl);
  if (image.width * image.height > PptCover.MaxPixels || Math.abs(image.width / image.height - 16 / 9) > 0.04) throw new Error(i18nService.t('pptCoverImageRatio'));
  const canvas = document.createElement('canvas'); canvas.width = 2560; canvas.height = 1440;
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1];
}
export function loadCoverBitmap(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; });
}
export async function renderCoverPng(background: string, fields: PptCoverFields): Promise<string> {
  await document.fonts.ready;
  const image = await loadCoverBitmap(`data:image/png;base64,${background}`);
  const canvas = document.createElement('canvas'); canvas.width = PptCover.Width * 2; canvas.height = PptCover.Height * 2;
  const ctx = canvas.getContext('2d')!; ctx.scale(2, 2); ctx.drawImage(image, 0, 0, PptCover.Width, PptCover.Height);
  ctx.textBaseline = 'top';
  for (const line of layoutCoverText(fields)) {
    ctx.font = `${line.bold ? 'bold ' : ''}${line.size}px "${PptCover.Font}", sans-serif`;
    ctx.fillStyle = `#${line.color}`; ctx.fillText(line.text, line.x, line.y);
  }
  return canvas.toDataURL('image/png').split(',')[1];
}
export async function saveCoverFile(file: PptPreparedFile, cwd?: string): Promise<string> {
  const result = await window.electron.dialog.saveInlineFile({ dataBase64: file.base64Data, fileName: file.name, mimeType: file.mimeType, cwd });
  if (!result.success || !result.path) throw new Error(i18nService.t('pptCoverExportFailed'));
  return result.path;
}
