import { useState } from 'react';

import type { ImageCreationExample } from '../../../shared/imageCreation/constants';

// Tiles are 16:10. An image at least this wide for its height fills the tile;
// a narrower one (poster, portrait) would lose most of its content to the crop,
// so it is shown whole on a soft backdrop of itself instead.
const FILL_MIN_ASPECT = 1.2;

const ThumbnailShape = {
  Fill: 'fill',
  Framed: 'framed',
} as const;
type ThumbnailShape = typeof ThumbnailShape[keyof typeof ThumbnailShape];

function FadeImage({ src, alt, className, onMeasure }: {
  src: string;
  alt: string;
  className: string;
  onMeasure?: (image: HTMLImageElement) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return <img src={src} alt={alt} loading="lazy" draggable={false}
    onLoad={event => { onMeasure?.(event.currentTarget); setLoaded(true); }}
    onError={() => setLoaded(false)}
    className={`${className} transition-opacity duration-300 motion-reduce:transition-none ${loaded ? 'opacity-100' : 'opacity-0'}`} />;
}

export default function ImageExampleThumbnail({ example, alt, referenceAlt }: {
  example: ImageCreationExample;
  alt: string;
  referenceAlt: string;
}) {
  const [shape, setShape] = useState<ThumbnailShape>(ThumbnailShape.Fill);
  const reference = example.showReferencePreview ? example.referenceImageUrl : undefined;
  const framed = !reference && shape === ThumbnailShape.Framed;

  return <div className="relative aspect-[8/5] overflow-hidden rounded-xl bg-surface-raised">
    <div className="h-full w-full transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none">
      {reference
        // Before and after share the tile; each half is close to a portrait
        // source, so both fill their half without letterboxing.
        ? <div className="flex h-full gap-0.5 bg-background">
          <FadeImage key={reference} src={reference} alt={referenceAlt} className="h-full min-w-0 flex-1 object-cover" />
          <FadeImage key={example.imageUrl} src={example.imageUrl} alt={alt} className="h-full min-w-0 flex-1 object-cover" />
        </div>
        : <>
          {framed && <img src={example.imageUrl} alt="" aria-hidden="true" draggable={false}
            className="absolute inset-0 h-full w-full scale-150 object-cover blur-2xl saturate-150" />}
          <div className={`relative flex h-full items-center justify-center ${framed ? 'py-[4.5%]' : ''}`}>
            <FadeImage key={example.imageUrl} src={example.imageUrl} alt={alt}
              onMeasure={image => setShape(image.naturalWidth / image.naturalHeight >= FILL_MIN_ASPECT ? ThumbnailShape.Fill : ThumbnailShape.Framed)}
              className={framed ? 'h-full w-auto rounded-[3px] shadow-[0_4px_14px_rgba(0,0,0,0.18)]' : 'h-full w-full object-cover'} />
          </div>
        </>}
    </div>
    {/* Hairline so near-white artwork keeps its edge on a light page. */}
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-black/[0.06] dark:ring-white/10" />
  </div>;
}
