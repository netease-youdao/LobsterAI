import { useState } from 'react';

import type { PptExample } from '../../../shared/pptCreation/constants';
import { i18nService } from '../../services/i18n';

export function PptPreviewImage({ url, alt, className = '' }: { url: string; alt: string; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <div className={`flex items-center justify-center overflow-hidden rounded-xl bg-surface-raised ${className}`}>
    {failedUrl === url ? <span className="p-3 text-center text-xs text-muted">{i18nService.t('pptCreationImageFailed')}</span>
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
    <div className="grid grid-cols-4 gap-x-4 gap-y-6 [@container_(max-width:459px)]:grid-cols-2 [@container_(min-width:460px)_and_(max-width:639px)]:grid-cols-3">
      {(full ? examples : examples.slice(0, 8)).map((example, index) => <div key={example.id}
        className={`group relative min-w-0 ${full ? '' : index >= 6 ? '[@container_(max-width:639px)]:hidden' : index >= 4 ? '[@container_(max-width:459px)]:hidden' : ''}`}>
        <button type="button" disabled={busy} data-ppt-example={example.id} onClick={() => onSelect(example)}
          aria-label={`${example.title[language]} · ${t('pptCreationPreview')}`}
          className="w-full rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background disabled:opacity-60">
          <PptPreviewImage url={example.previews[0].url} alt="" className="aspect-[8/5] border border-border-subtle transition-shadow group-hover:shadow-subtle" />
          <p className="mt-2 truncate px-0.5 text-[13px] leading-5 text-foreground">{example.title[language]}</p>
        </button>
      </div>)}
    </div>
  </div>;
}
