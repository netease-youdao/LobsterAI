import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArtifactPreviewProtocol } from '../../shared/artifactPreview/constants';
import { sniffImageMimeType } from '../../shared/cowork/imageAttachments';
import { ImageProcessingOperation, LOBSTERAI_WATERMARK_TARGET, REMOVE_WATERMARK_OPERATION } from '../../shared/media/constants';
import { getLocalFileProtocolPath } from '../artifactLocalFileProtocol';
import { t } from '../i18n';
import { MediaGenerationAction, MediaGenerationTool } from '../mediaGenerationPolicy';
import { applyMediaReferencesToGenerationParams, type MediaAttachmentRefMain, MediaGenerationRequestType } from '../mediaGenerationReferences';

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function isFixedWatermarkErase(tool: string, args: Record<string, unknown>): boolean {
  return tool === MediaGenerationTool.Image && (args.action ?? MediaGenerationAction.Generate) === MediaGenerationAction.Generate
    && (args.imageOperation === REMOVE_WATERMARK_OPERATION
      || (args.imageOperation === ImageProcessingOperation.Erase && args.eraseTarget === LOBSTERAI_WATERMARK_TARGET));
}

export async function watermarkEraseSource(
  args: Record<string, unknown>, refs?: MediaAttachmentRefMain[], cwd?: string,
  cachedFile?: (url: string) => string | undefined,
): Promise<string> {
  const inputs = [...(args.image ? [args.image] : []), ...(Array.isArray(args.images) ? args.images : [])];
  const params = applyMediaReferencesToGenerationParams({
    mediaType: MediaGenerationRequestType.Image, params: { images: inputs }, refs, preferExplicitImageInputs: true,
  });
  if (!Array.isArray(params.images) || params.images.length !== 1 || typeof params.images[0] !== 'string') {
    throw new Error(t('mediaImageProcessingSource'));
  }
  let source = params.images[0];
  if (source.startsWith('https://')) {
    const local = cachedFile?.(source);
    if (!local) return source;
    source = local;
  }
  if (source.startsWith('data:image/')) {
    const comma = source.indexOf(',');
    if (comma < 0 || comma > 64 || !source.slice(0, comma).endsWith(';base64')) throw new Error(t('mediaImageProcessingSource'));
    if (source.length - comma - 1 > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw new Error(t('mediaTaskInputTooLarge'));
    return source;
  }
  const file = source.startsWith('file://') ? fileURLToPath(source)
    : source.startsWith(`${ArtifactPreviewProtocol.LocalFile}://`) ? getLocalFileProtocolPath(source)
      : path.resolve(cwd || '.', source);
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size) throw new Error(t('mediaImageProcessingSource'));
    if (info.size > MAX_IMAGE_BYTES) throw new Error(t('mediaTaskInputTooLarge'));
    const bytes = await handle.readFile();
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(t('mediaTaskInputTooLarge'));
    const mime = sniffImageMimeType(bytes);
    if (!mime) throw new Error(t('mediaImageProcessingSource'));
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } finally {
    await handle.close();
  }
}
