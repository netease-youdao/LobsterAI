import { imageRegionCoordinates } from './geometry';
import { ImageEditOperation, type ImageEditRequest } from './types';

/** Shared by the conversation model and image model so positions cannot diverge. */
export function imageEditRegionPrompt(request: Pick<ImageEditRequest, 'source' | 'regions'>): string {
  return `Source image: ${request.source.width} x ${request.source.height} pixels. `
    + 'Region coordinates below are percentages of the source image (left, top, width, height), measured from its top-left corner. '
    + request.regions.map((region, index) => `${index + 1}. [${imageRegionCoordinates(region, request.source).percent.join(', ')}]: ${region.text}`).join('\n');
}

export function imageEditMaskContext(request: ImageEditRequest): string {
  if (request.operation !== ImageEditOperation.Erase || !request.guidePath) return '';
  return 'This is a prepared ERASE request. The attached source image is unmarked. '
    + `Its immutable ${request.source.width} x ${request.source.height} removal mask is already saved at ${JSON.stringify(request.guidePath)}. `
    + 'WHITE marks the removal area; BLACK marks the area to preserve. LobsterAI automatically sends a close-up of the marked area with this mask to the image model, '
    + 'uses its own fixed erase prompt, and blends the result back into the source. '
    + 'Do not open, inspect or analyze the mask, and do not describe or guess the marked object: your prompt text is not used for this edit. '
    + 'Call lobsterai_image_generate once with the mapped source path and a short prompt such as "Erase the marked area".';
}

export function imageEditPrompt(request: ImageEditRequest): string {
  const base = 'Edit the FIRST input image. Keep the subject, composition and all unrequested details unchanged. Return one edited image, not a description. ';
  switch (request.operation) {
    case ImageEditOperation.Comment:
      return base + imageEditRegionPrompt(request);
    case ImageEditOperation.Markup:
      return base + 'The SECOND image is an annotated guide. Follow its marks and text as editing instructions. Do not reproduce guide marks in the result. ' + (request.instruction || '');
    case ImageEditOperation.Erase:
      return base + 'The SECOND image is a black and white removal mask: WHITE marks the objects/area to remove; BLACK must be preserved. Remove the marked objects and fill their area naturally using the surrounding background. Do not include the mask in the result. '
        + 'Keep the exact framing and scale of the FIRST image so the result aligns with it pixel for pixel.';
    case ImageEditOperation.RemoveBackground:
      return 'Create a precise alpha matte of the foreground subject in the FIRST image. Return only a grayscale mask at the SAME composition and aspect ratio. The complete foreground subject must be solid pure WHITE, all background pure BLACK, with smooth gray antialiased edges. Include ALL visible surfaces of the subject: for a cup, its inner walls, rim and interior are WHITE too. Only see-through holes where the BACKGROUND is visible (such as inside a mug handle) are BLACK. Do not cut out dark surfaces or cup interiors. No colors, shadows, grid, text, new objects, outlines or movement. Do not draw the original photograph. This mask will be applied to the original pixels to create a transparent PNG.';
    case ImageEditOperation.Reframe:
      return base + `Change the canvas aspect ratio to ${request.aspectRatio}. Extend the surrounding scene naturally. Preserve the subject's proportions and appearance; do not stretch the image.`;
    default:
      throw new Error('Unsupported AI image edit operation');
  }
}
