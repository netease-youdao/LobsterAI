/** Query parameter asking the local file protocol for a copy of an image downscaled to this many pixels. */
export const LOCAL_FILE_THUMBNAIL_PARAM = 'thumb';
/** Query parameter saying which side of the image the thumbnail edge applies to. */
export const LOCAL_FILE_THUMBNAIL_FIT_PARAM = 'thumbFit';

/**
 * `contain`: the long side is at most the edge, for images shown whole.
 * `cover`: the short side is at least the edge, for images cropped to fill a box.
 */
export const LocalFileThumbnailFit = {
  Contain: 'contain',
  Cover: 'cover',
} as const;
export type LocalFileThumbnailFit = typeof LocalFileThumbnailFit[keyof typeof LocalFileThumbnailFit];

export const parseLocalFileThumbnailFit = (value: string | null | undefined): LocalFileThumbnailFit => (
  value === LocalFileThumbnailFit.Cover ? LocalFileThumbnailFit.Cover : LocalFileThumbnailFit.Contain
);

/** Edges the protocol builds; requests snap up to one so a few sizes cover every display and the cache stays small. */
export const LOCAL_FILE_THUMBNAIL_EDGES = [256, 512, 1024, 1536, 2048] as const;

/** The thumbnail edge serving a request for `pixels`, or null when only the original is big enough. */
export function snapLocalFileThumbnailEdge(pixels: number): number | null {
  if (!Number.isFinite(pixels) || pixels <= 0) return null;
  return LOCAL_FILE_THUMBNAIL_EDGES.find(edge => edge >= pixels) ?? null;
}
