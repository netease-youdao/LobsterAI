import { CompanionCustomSkin, companionFitRect, isCompanionSourceSizeAllowed } from '../../../shared/desktopCompanion/customSkin';

export async function readCompanionSkinImage(file: File): Promise<HTMLImageElement> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > CompanionCustomSkin.MaxSourceBytes) {
    throw new Error('Invalid image format or file size.');
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read image.'));
    reader.readAsDataURL(file);
  });
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
  const fit = companionFitRect(image.naturalWidth, image.naturalHeight, zoom, x, y);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CompanionCustomSkin.OutputDimension;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to prepare image preview.');
  context.drawImage(image, fit.x, fit.y, fit.width, fit.height);
  return canvas.toDataURL('image/png');
}
