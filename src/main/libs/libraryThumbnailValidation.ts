import { isLibraryHtmlThumbnailExtension } from '../../shared/library/htmlThumbnail';

export const LibraryThumbnailVisualThreshold = {
  MaxSamples: 4_096,
  UniformLuminanceRange: 4,
  LightLuminanceFloor: 235,
  MaxNonLightRatio: 0.002,
} as const;

export const isLikelyBlankThumbnailBitmap = (bitmap: Uint8Array): boolean => {
  const pixelCount = Math.floor(bitmap.length / 4);
  if (pixelCount <= 0) return true;

  const sampleStep = Math.max(
    1,
    Math.floor(pixelCount / LibraryThumbnailVisualThreshold.MaxSamples),
  );
  let visibleSamples = 0;
  let lightSamples = 0;
  let minimumLuminance = 255;
  let maximumLuminance = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += sampleStep) {
    const offset = pixel * 4;
    const alpha = bitmap[offset + 3];
    if (alpha <= 8) continue;

    // Electron returns a premultiplied BGRA bitmap.
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    const luminance = Math.round((red * 0.2126) + (green * 0.7152) + (blue * 0.0722));
    minimumLuminance = Math.min(minimumLuminance, luminance);
    maximumLuminance = Math.max(maximumLuminance, luminance);
    if (luminance >= LibraryThumbnailVisualThreshold.LightLuminanceFloor) {
      lightSamples += 1;
    }
    visibleSamples += 1;
  }

  if (visibleSamples === 0) return true;
  if (
    maximumLuminance - minimumLuminance
    <= LibraryThumbnailVisualThreshold.UniformLuminanceRange
  ) {
    return true;
  }

  const nonLightRatio = 1 - (lightSamples / visibleSamples);
  return nonLightRatio <= LibraryThumbnailVisualThreshold.MaxNonLightRatio;
};

interface NativeLibraryThumbnailValidationOptions {
  extension: string;
  platform: NodeJS.Platform;
  rendererConfirmedIntentionalBlank: boolean;
  getBitmap: () => Uint8Array;
}

/** Native fallback has no HTML child-frame proof, so uniform output is suspect. */
export const shouldRejectNativeLibraryThumbnail = ({
  extension,
  platform,
  rendererConfirmedIntentionalBlank,
  getBitmap,
}: NativeLibraryThumbnailValidationOptions): boolean => {
  const normalizedExtension = extension.toLowerCase();
  const shouldValidate = isLibraryHtmlThumbnailExtension(normalizedExtension)
    || (
      platform === 'win32'
      && normalizedExtension === '.pptx'
      && !rendererConfirmedIntentionalBlank
    );
  return shouldValidate && isLikelyBlankThumbnailBitmap(getBitmap());
};
