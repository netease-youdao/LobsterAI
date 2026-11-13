import type { ImageCreationCatalog, ImageCreationExample } from '../../../shared/imageCreation/constants';
import { i18nService } from '../../services/i18n';
import ImageExampleThumbnail from './ImageExampleThumbnail';

// The home page shows at most two rows; the full catalog lives in the expert
// detail. Narrower containers drop columns, and the trailing examples with
// them, so the shelf is always two full rows.
const SHELF_MAX_EXAMPLES = 8;
const HIDE_BELOW_FOUR_COLUMNS = '[@container_(max-width:639px)]:hidden';
const HIDE_BELOW_THREE_COLUMNS = '[@container_(max-width:459px)]:hidden';

function hiddenWhenNarrow(index: number): string {
  if (index >= 6) return HIDE_BELOW_FOUR_COLUMNS;
  if (index >= 4) return HIDE_BELOW_THREE_COLUMNS;
  return '';
}

export default function ImageExampleShelf({ catalog, onSelect }: {
  catalog: ImageCreationCatalog;
  onSelect: (example: ImageCreationExample) => void;
}) {
  const language = i18nService.getLanguage();
  const t = (key: string) => i18nService.t(key);
  return <div className="[container-type:inline-size]">
    <div className="grid grid-cols-4 gap-x-4 gap-y-6 [@container_(max-width:459px)]:grid-cols-2 [@container_(min-width:460px)_and_(max-width:639px)]:grid-cols-3">
      {catalog.examples.slice(0, SHELF_MAX_EXAMPLES).map((example, index) => <button key={example.id} type="button" onClick={() => onSelect(example)}
        data-image-example={example.id} title={example.title[language]} aria-label={`${example.title[language]} · ${t('imageCreationPreview')}`}
        className={`group min-w-0 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-background ${hiddenWhenNarrow(index)}`}>
        <ImageExampleThumbnail example={example} alt="" referenceAlt="" />
        <p className="mt-2 truncate px-0.5 text-[13px] leading-5 text-foreground">{example.title[language]}</p>
      </button>)}
    </div>
  </div>;
}
