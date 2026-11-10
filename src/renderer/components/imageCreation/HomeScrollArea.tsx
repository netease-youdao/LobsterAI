import './imageCreationScroll.css';

import { ChevronDownIcon } from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';

import { i18nService } from '../../services/i18n';
import { useScrollAffordance } from './useScrollAffordance';

export default function HomeScrollArea({ galleryVisible, children }: { galleryVisible: boolean; children: ReactNode }) {
  const { scrollRef, canScrollDown, scrollNext } = useScrollAffordance<HTMLDivElement>(galleryVisible);
  const showHint = galleryVisible && canScrollDown;

  return <div className="relative z-10 flex min-h-0 flex-1 flex-col">
    <div ref={scrollRef} data-home-scroll data-more-examples={showHint}
      tabIndex={galleryVisible ? 0 : undefined}
      aria-label={galleryVisible ? i18nService.t('imageCreationHeading') : undefined}
      className={`min-h-0 flex-1 overflow-y-auto ${galleryVisible ? 'image-creation-scrollbar image-creation-home-scroll focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30' : ''}`}>
      {children}
    </div>
    {showHint && <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <button type="button" onClick={scrollNext} aria-controls="image-creation-gallery"
        className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface/95 px-3.5 py-1.5 text-xs text-secondary shadow-subtle backdrop-blur-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50">
        {i18nService.t('imageCreationScrollExamples')}<ChevronDownIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>}
  </div>;
}
