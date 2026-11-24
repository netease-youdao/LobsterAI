import { PhotoIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';

import type { PptExample } from '../../../shared/pptCreation/constants';
import { i18nService } from '../../services/i18n';

const SHELF_MAX_EXAMPLES = 8;
const HIDE_BELOW_FOUR_COLUMNS = '[@container_(max-width:639px)]:hidden';
const HIDE_BELOW_THREE_COLUMNS = '[@container_(max-width:459px)]:hidden';

function hiddenWhenNarrow(index: number): string {
  if (index >= 6) return HIDE_BELOW_FOUR_COLUMNS;
  if (index >= 4) return HIDE_BELOW_THREE_COLUMNS;
  return '';
}

export function PptPreviewImage({ url, alt, className = '' }: { url: string; alt: string; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <div className={`flex items-center justify-center overflow-hidden rounded-xl bg-surface-raised ${className}`}>
    {failedUrl === url ? <span className="flex flex-col items-center gap-2 p-3 text-center text-xs text-foreground/70"><PhotoIcon aria-hidden="true" className="h-6 w-6 text-secondary" />{i18nService.t('pptCreationImageFailed')}</span>
      : <img src={url} alt={alt} loading="lazy" className="h-full w-full object-contain" onError={() => setFailedUrl(url)} />}
  </div>;
}

function PptCoverThumbnail({ url, alt }: { url: string; alt: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl bg-surface-raised">
      {failedUrl === url ? (
        <span className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center text-xs text-foreground/70">
          <PhotoIcon aria-hidden="true" className="h-6 w-6 text-secondary" />
          {i18nService.t('pptCreationImageFailed')}
        </span>
      ) : (
        <div className="relative h-full w-full transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none">
          <img
            src={url}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            draggable={false}
            className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl"
          />
          <img
            src={url}
            alt={alt}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailedUrl(url)}
            className="relative h-full w-full object-contain"
          />
        </div>
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-black/[0.06] dark:ring-white/[0.08]"
      />
    </div>
  );
}

export default function PptExampleGallery({ examples, full = false, busy, onSelect }: {
  examples: PptExample[]; full?: boolean; busy: boolean;
  onSelect: (example: PptExample) => void;
}) {
  const language = i18nService.getLanguage();
  const t = (key: string) => i18nService.t(key);
  return <div className="[container-type:inline-size]" data-ppt-example-gallery>
    <div className="grid grid-cols-4 gap-x-4 gap-y-5 [@container_(max-width:459px)]:grid-cols-2 [@container_(min-width:460px)_and_(max-width:639px)]:grid-cols-3">
      {(full ? examples : examples.slice(0, SHELF_MAX_EXAMPLES)).map((example, index) => (
        <button
          key={example.id}
          type="button"
          disabled={busy}
          data-ppt-example={example.id}
          title={example.title[language]}
          aria-label={`${example.title[language]} · ${t('pptCreationPreview')}`}
          onClick={() => onSelect(example)}
          className={`group min-w-0 rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-60 ${
            full ? '' : hiddenWhenNarrow(index)
          }`}
        >
          <PptCoverThumbnail url={example.previews[0].url} alt="" />
          {full ? (
            <div className="mt-2 px-0.5">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-[13px] font-medium leading-5 text-foreground">
                  {example.title[language]}
                </p>
                <span className="shrink-0 text-[11px] text-secondary">
                  {t('pptCreationPages').replace('{count}', String(example.slideCount))}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-secondary">
                {example.description[language]}
              </p>
            </div>
          ) : (
            <p className="mt-2 truncate px-0.5 text-[13px] font-medium leading-5 text-foreground">
              {example.title[language]}
            </p>
          )}
        </button>
      ))}
    </div>
  </div>;
}
