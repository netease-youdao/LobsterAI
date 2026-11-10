import { ArrowUpRightIcon, PhotoIcon } from '@heroicons/react/24/outline';

import type { ImageCreationCatalog, ImageCreationExample } from '../../../shared/imageCreation/constants';
import { i18nService } from '../../services/i18n';

export default function ImageExampleGallery({ catalog, onSelect, compact = false }: {
  catalog: ImageCreationCatalog;
  onSelect: (example: ImageCreationExample) => void;
  compact?: boolean;
}) {
  const language = i18nService.getLanguage();
  const t = (key: string) => i18nService.t(key);
  return <div className={`grid grid-cols-2 gap-x-6 gap-y-9 ${compact ? '' : 'lg:grid-cols-4'}`}>
    {catalog.examples.map(example => <button key={example.id} type="button" onClick={() => onSelect(example)}
      data-image-example={example.id} aria-label={`${example.title[language]} · ${t('imageCreationPreview')}`}
      className="group min-w-0 self-start rounded-2xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background">
      <div className="relative aspect-[8/5] overflow-hidden rounded-2xl bg-[#f4f3ef] transition-shadow duration-200 group-hover:shadow-subtle dark:bg-surface-raised">
        <div className={`flex h-full w-full items-center justify-center ${example.showReferencePreview ? 'gap-1.5' : ''}`}>
          {example.showReferencePreview && example.referenceImageUrl && <img src={example.referenceImageUrl} alt={t('imageCreationReference')} loading="lazy"
            className="h-full min-w-0 flex-1 object-contain" />}
          <img src={example.imageUrl} alt={example.title[language]} loading="lazy" className="h-full min-w-0 flex-1 object-contain"
            onError={event => { event.currentTarget.style.visibility = 'hidden'; }}
            onLoad={event => { event.currentTarget.style.visibility = 'visible'; }} />
        </div>
        <span className="absolute right-3 top-3 rounded-full bg-white/90 p-1.5 text-neutral-800 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"><ArrowUpRightIcon className="h-4 w-4" /></span>
      </div>
      <div className="px-0.5 pt-3">
        <h3 className="line-clamp-2 text-sm font-medium leading-5 text-foreground transition-colors group-hover:text-primary">{example.title[language]}</h3>
        <p className="mt-1.5 flex items-center gap-1.5 text-xs leading-5 text-muted"><PhotoIcon className="h-3.5 w-3.5 shrink-0" />
          {example.referenceImageUrl ? t('imageCreationWithReference') : t('imageCreationTryDirectly')}
        </p>
      </div>
    </button>)}
  </div>;
}
