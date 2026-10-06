export interface RasterThumbnailDrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const calculateRasterThumbnailDrawRect = (
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): RasterThumbnailDrawRect => {
  if (
    sourceWidth <= 0
    || sourceHeight <= 0
    || targetWidth <= 0
    || targetHeight <= 0
  ) {
    throw new Error('Raster thumbnail dimensions must be positive');
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
};
