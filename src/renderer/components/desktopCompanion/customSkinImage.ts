import { CompanionCustomSkin, companionFitRect, isCompanionGif, isCompanionSourceSizeAllowed, validateCompanionGif } from '../../../shared/desktopCompanion/customSkin';

export async function readCompanionSkinImage(file: File): Promise<HTMLImageElement> {
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > (file.type === 'image/gif' ? CompanionCustomSkin.MaxSavedBytes : CompanionCustomSkin.MaxSourceBytes)) {
    throw new Error('Invalid image format or file size.');
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read image.'));
    reader.readAsDataURL(file);
  });
  return decodeCompanionSkinImage(dataUrl);
}

export async function decodeCompanionSkinImage(dataUrl: string): Promise<HTMLImageElement> {
  if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)
    || dataUrl.length > Math.ceil(CompanionCustomSkin.MaxSourceBytes / 3) * 4 + 64) throw new Error('Invalid image.');
  if (isCompanionGif(dataUrl)) validateCompanionGif(Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), char => char.charCodeAt(0)));
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Unable to decode image.'));
    image.src = dataUrl;
  });
  if (!isCompanionSourceSizeAllowed(image.naturalWidth, image.naturalHeight)) throw new Error('Invalid image dimensions.');
  return image;
}

export function cropCompanionSkinImage(image: HTMLImageElement, zoom: number, x: number, y: number): string {
  if (isCompanionGif(image.src)) return image.src;
  const fit = companionFitRect(image.naturalWidth, image.naturalHeight, zoom, x, y);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CompanionCustomSkin.OutputDimension;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to prepare image preview.');
  context.drawImage(image, fit.x, fit.y, fit.width, fit.height);
  return canvas.toDataURL('image/png');
}
