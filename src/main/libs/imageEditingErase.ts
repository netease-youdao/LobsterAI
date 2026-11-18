/** Pixel rectangle in the source image. */
export interface ImageEditRect { x: number; y: number; width: number; height: number }

// A close-up keeps small marked objects large enough for the image model to notice,
// with enough surrounding context to fill them naturally.
const CROP_CONTEXT = 3;
const CROP_MIN_SIDE = 512;
const CROP_MAX_ASPECT = 2;
// Close-ups that cover most of the image gain nothing over the full image.
const CROP_FULL_IMAGE_AREA = 0.6;
const MASK_THRESHOLD = 32;

/** Bounds of the marked (white) area in an Electron BGRA bitmap, or undefined when nothing is marked. */
export function imageMaskBounds(mask: Uint8Array, width: number): ImageEditRect | undefined {
  if (!Number.isInteger(width) || width < 1 || mask.length % (width * 4) !== 0) throw new Error('Image mask dimensions differ');
  let left = width;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  for (let p = 0; p < mask.length / 4; p++) {
    if (Math.max(mask[p * 4], mask[p * 4 + 1], mask[p * 4 + 2]) < MASK_THRESHOLD) continue;
    const x = p % width;
    const y = (p - x) / width;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = y;
  }
  return right < 0 ? undefined : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** The close-up sent to the image model: centered on the mark, inside the image, with a model-friendly aspect ratio. */
export function eraseCropRect(bounds: ImageEditRect, image: { width: number; height: number }): ImageEditRect {
  let width = Math.max(bounds.width * CROP_CONTEXT, CROP_MIN_SIDE);
  let height = Math.max(bounds.height * CROP_CONTEXT, CROP_MIN_SIDE);
  if (width > height * CROP_MAX_ASPECT) height = width / CROP_MAX_ASPECT;
  else if (height > width * CROP_MAX_ASPECT) width = height / CROP_MAX_ASPECT;
  width = Math.min(image.width, Math.round(width));
  height = Math.min(image.height, Math.round(height));
  if (width * height >= image.width * image.height * CROP_FULL_IMAGE_AREA) return { x: 0, y: 0, width: image.width, height: image.height };
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, Math.round(value)));
  return {
    x: clamp(bounds.x + bounds.width / 2 - width / 2, image.width - width),
    y: clamp(bounds.y + bounds.height / 2 - height / 2, image.height - height),
    width, height,
  };
}

function boxBlur(values: Float32Array, width: number, height: number, radius: number, horizontal: boolean): Float32Array {
  const output = new Float32Array(values.length);
  const [lines, length] = horizontal ? [height, width] : [width, height];
  const index = (line: number, i: number) => horizontal ? line * width + i : i * width + line;
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let i = 0; i <= Math.min(radius, length - 1); i++) sum += values[index(line, i)];
    for (let i = 0; i < length; i++) {
      output[index(line, i)] = sum / (radius * 2 + 1);
      if (i + radius + 1 < length) sum += values[index(line, i + radius + 1)];
      if (i - radius >= 0) sum -= values[index(line, i - radius)];
    }
  }
  return output;
}

/**
 * Blends the model's close-up into the source. The mask is grown slightly and feathered outward, so the
 * marked area is fully replaced, the seam is soft, and every pixel outside the feather stays untouched.
 * The patch's color drift is measured where it should match the source and removed before blending.
 * All bitmaps are Electron premultiplied BGRA; `patch` has the crop's dimensions.
 */
export function blendErasePatch(source: Uint8Array, mask: Uint8Array, patch: Uint8Array, width: number, crop: ImageEditRect): Uint8Array {
  const height = source.length / 4 / width;
  if (!Number.isInteger(height) || mask.length !== source.length || patch.length !== crop.width * crop.height * 4
    || crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 || crop.x + crop.width > width || crop.y + crop.height > height) {
    throw new Error('Image erase patch dimensions differ');
  }
  const alpha = new Float32Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const p = ((crop.y + y) * width + crop.x + x) * 4;
      alpha[y * crop.width + x] = Math.max(mask[p], mask[p + 1], mask[p + 2]) / 255;
    }
  }
  const bounds = imageMaskBounds(mask, width);
  const feather = Math.min(48, Math.max(6, Math.round(Math.max(bounds?.width ?? 0, bounds?.height ?? 0) * 0.1)));
  const radius = Math.ceil(feather / 2);
  // Two box passes approximate a Gaussian; doubling it keeps the mask edge opaque and fades over `feather` pixels.
  let blurred: Float32Array = alpha;
  for (let pass = 0; pass < 2; pass++) {
    blurred = boxBlur(blurred, crop.width, crop.height, radius, true);
    blurred = boxBlur(blurred, crop.width, crop.height, radius, false);
  }
  const weights = alpha.map((value, i) => Math.max(value, Math.min(1, blurred[i] * 2)));
  const sourceIndex = (i: number) => ((crop.y + Math.floor(i / crop.width)) * width + crop.x + i % crop.width) * 4;
  // The model re-renders the whole close-up with a slight color drift. The area it was asked to
  // preserve shows that drift; removing its median keeps the replaced area from showing as a halo.
  const histograms = [0, 1, 2].map(() => new Uint32Array(511));
  let preserved = 0;
  for (let i = 0; i < weights.length; i++) {
    if (weights[i] > 0) continue;
    const p = sourceIndex(i);
    for (let channel = 0; channel < 3; channel++) histograms[channel][patch[i * 4 + channel] - source[p + channel] + 255]++;
    preserved++;
  }
  const drift = histograms.map(histogram => {
    let seen = 0;
    for (let value = 0; value < histogram.length && preserved; value++) if ((seen += histogram[value]) * 2 >= preserved) return value - 255;
    return 0;
  });
  const output = new Uint8Array(source);
  for (let i = 0; i < weights.length; i++) {
    const a = weights[i];
    if (a <= 0) continue;
    const p = sourceIndex(i);
    for (let channel = 0; channel < 4; channel++) {
      const value = patch[i * 4 + channel] - (channel < 3 ? drift[channel] : 0);
      output[p + channel] = Math.round(source[p + channel] + (Math.min(255, Math.max(0, value)) - source[p + channel]) * a);
    }
  }
  return output;
}
