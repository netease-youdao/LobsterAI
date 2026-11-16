import { ArrowUpRightIcon, PhotoIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';

import type { PptExample } from '../../../shared/pptCreation/constants';
import { i18nService } from '../../services/i18n';

export function PptPreviewImage({ url, alt, className = '' }: { url: string; alt: string; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <div className={`flex items-center justify-center overflow-hidden rounded-xl bg-surface-raised ${className}`}>
    {failedUrl === url ? <span className="flex flex-col items-center gap-2 p-3 text-center text-xs text-foreground/70"><PhotoIcon aria-hidden="true" className="h-6 w-6 text-secondary" />{i18nService.t('pptCreationImageFailed')}</span>
      : <img src={url} alt={alt} loading="lazy" className="h-full w-full object-contain" onError={() => setFailedUrl(url)} />}
  </div>;
}

export default function PptExampleGallery({ examples, full = false, busy, onSelect }: {
  examples: PptExample[]; full?: boolean; busy: boolean;
  onSelect: (example: PptExample) => void;
}) {
  const language = i18nService.getLanguage();
  const t = (key: string) => i18nService.t(key);
  return <div className="[container-type:inline-size]" data-ppt-example-gallery>
    <div className="grid grid-cols-4 gap-3 [@container_(max-width:459px)]:grid-cols-2 [@container_(min-width:460px)_and_(max-width:639px)]:grid-cols-3">
      {(full ? examples : examples.slice(0, 8)).map((example, index) => <div key={example.id}
        className={`group relative min-w-0 ${full ? '' : index >= 6 ? '[@container_(max-width:639px)]:hidden' : index >= 4 ? '[@container_(max-width:459px)]:hidden' : ''}`}>
        <button type="button" disabled={busy} data-ppt-example={example.id} onClick={() => onSelect(example)}
          aria-label={`${example.title[language]} · ${t('pptCreationPreview')}`}
          className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left outline-none transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-card focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none disabled:cursor-wait disabled:opacity-60">
          <div className="w-full p-1.5 pb-0"><PptPreviewImage url={example.previews[0].url} alt="" className="aspect-video" /></div>
          <div className={`flex w-full flex-1 flex-col ${full ? 'px-3 pb-3 pt-2.5' : 'px-2.5 pb-2.5 pt-2'}`}>
            <p className={`break-words text-sm font-medium leading-5 text-foreground ${full ? 'min-h-10' : ''}`}>{example.title[language]}</p>
            {full && <p className="mt-2 line-clamp-2 text-xs leading-5 text-foreground/70">{example.description[language]}</p>}
            {full && <div className="mt-auto flex items-center justify-between gap-2 pt-2 text-xs text-foreground/60">
              <span>{t('pptCreationPages').replace('{count}', String(example.slideCount))}</span>
              <ArrowUpRightIcon aria-hidden="true" className="h-4 w-4 text-secondary transition-colors group-hover:text-primary group-focus-within:text-primary" />
            </div>}
          </div>
        </button>
      </div>)}
    </div>
  </div>;
}
