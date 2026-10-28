import { ChatBubbleBottomCenterTextIcon, XMarkIcon } from '@heroicons/react/24/outline';

import { ImageEditOperation, type ImageEditRequest } from '../../../../shared/imageEditing/types';
import { i18nService } from '../../../services/i18n';
import { focusImageEdit, imageEditTitle } from '../../../services/imageEditing';
import { imageEditUserPrompt } from '../../../services/imageEditingPrompt';
import { RemoveBackgroundIcon } from './ImageEditingIcons';

export function ImageEditDraftCard({ request, onRemove }: { request: ImageEditRequest; onRemove: () => void }) {
  const Icon = request.operation === ImageEditOperation.RemoveBackground ? RemoveBackgroundIcon : ChatBubbleBottomCenterTextIcon;
  return <div className="min-w-0 flex-1 basis-full rounded-xl border border-accent/25 bg-accent/5 px-3 py-2 text-xs">
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-accent" />
      <button type="button" className="min-w-0 flex-1 truncate text-left font-medium text-primary" onClick={() => focusImageEdit(request.source, undefined,
        request.operation === ImageEditOperation.Comment ? request.regions : undefined, request.operation)}>
        {imageEditTitle(request.operation)} · {request.source.title}
      </button>
      <span className="shrink-0 text-muted">{i18nService.t('imageEditReady')}</span>
      <button type="button" onClick={onRemove} aria-label={i18nService.t('imageEditDelete')} className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"><XMarkIcon className="h-3.5 w-3.5" /></button>
    </div>
    {!request.regions.length && <p className="mt-1.5 leading-5 text-secondary">{imageEditUserPrompt(request)}</p>}
    {request.regions.map((region, index) => <button key={region.id} type="button" onClick={() => focusImageEdit(request.source, region.id, request.regions)}
      title={i18nService.t('imageEditChooseRegion')} className="mt-1 block w-full truncate text-left text-secondary hover:text-accent">
      <span className="mr-2 inline-flex h-4 w-4 items-center justify-center rounded-full bg-accent/15 text-[10px] text-accent">{index + 1}</span>{region.text}
    </button>)}
  </div>;
}
