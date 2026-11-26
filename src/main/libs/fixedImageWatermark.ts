import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArtifactPreviewProtocol } from '../../shared/artifactPreview/constants';
import { ImageProcessingOperation, LOBSTERAI_WATERMARK_TARGET, REMOVE_WATERMARK_OPERATION } from '../../shared/media/constants';
import { getLocalFileProtocolPath } from '../artifactLocalFileProtocol';
import { t } from '../i18n';
import { MediaGenerationAction, MediaGenerationTool } from '../mediaGenerationPolicy';
import { applyMediaReferencesToGenerationParams, type MediaAttachmentRefMain, MediaGenerationRequestType } from '../mediaGenerationReferences';

export function isFixedWatermarkRestore(tool: string, args: Record<string, unknown>): boolean {
  return tool === MediaGenerationTool.Image && (args.action ?? MediaGenerationAction.Generate) === MediaGenerationAction.Generate
    && (args.imageOperation === REMOVE_WATERMARK_OPERATION
      || (args.imageOperation === ImageProcessingOperation.Erase && args.eraseTarget === LOBSTERAI_WATERMARK_TARGET));
}

export async function watermarkOriginalSource(args: Record<string, unknown>, refs?: MediaAttachmentRefMain[], cwd?: string): Promise<string> {
  const inputs = [...(args.image ? [args.image] : []), ...(Array.isArray(args.images) ? args.images : [])];
  const params = applyMediaReferencesToGenerationParams({
    mediaType: MediaGenerationRequestType.Image, params: { images: inputs }, refs, preferExplicitImageInputs: true,
  });
  if (!Array.isArray(params.images) || params.images.length !== 1 || typeof params.images[0] !== 'string') {
    throw new Error(t('mediaImageProcessingSource'));
  }
  const source = params.images[0];
  if (source.startsWith('https://')) return source;
  const digest = createHash('sha256');
  if (source.startsWith('data:image/')) {
    const comma = source.indexOf(',');
    if (comma < 0 || !source.slice(0, comma).endsWith(';base64')) throw new Error(t('mediaImageProcessingSource'));
    digest.update(source.slice(comma + 1), 'base64');
  } else {
    const file = source.startsWith('file://') ? fileURLToPath(source)
      : source.startsWith(`${ArtifactPreviewProtocol.LocalFile}://`) ? getLocalFileProtocolPath(source)
        : path.resolve(cwd || '.', source);
    if (!(await stat(file)).isFile()) throw new Error(t('mediaImageProcessingSource'));
    for await (const chunk of createReadStream(file)) digest.update(chunk);
  }
  return 'sha256:' + digest.digest('hex');
}
