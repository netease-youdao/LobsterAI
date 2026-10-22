import { ImageEditOperation, type ImageEditRequest } from '../../shared/imageEditing/types';
import { i18nService } from './i18n';

export function imageEditUserPrompt(request: ImageEditRequest): string {
  const key = {
    [ImageEditOperation.Comment]: 'imageEditCommentPrompt', [ImageEditOperation.Markup]: 'imageEditMarkupPrompt',
    [ImageEditOperation.Erase]: 'imageEditErasePrompt', [ImageEditOperation.RemoveBackground]: 'imageEditRemovePrompt',
    [ImageEditOperation.Reframe]: 'imageEditReframePrompt', [ImageEditOperation.Resize]: 'imageEditResize', [ImageEditOperation.Original]: 'imageEditOriginal',
  }[request.operation];
  return [i18nService.t(key).replace('{ratio}', request.aspectRatio ?? ''),
    ...request.regions.map((region, index) => `${index + 1}. ${region.text}`), request.instruction,
  ].filter(Boolean).join('\n');
}
