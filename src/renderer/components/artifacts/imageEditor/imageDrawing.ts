import { ImageEditorTool, type ImageMark } from '../../../../shared/imageEditing/types';
import { i18nService } from '../../../services/i18n';
import { imageTextBounds, wrapImageText } from './imageText';

export function drawImageMark(context: CanvasRenderingContext2D, mark: ImageMark, width: number, height: number): void {
  if (!mark.points.length) return;
  const points = mark.points.map(p => ({ x: p.x * width, y: p.y * height }));
  const first = points[0];
  const last = points[points.length - 1];
  const stroke = mark.width * Math.max(width, height);
  context.save(); context.strokeStyle = mark.color; context.fillStyle = mark.color;
  if (mark.tool === ImageEditorTool.Eraser) context.globalCompositeOperation = 'destination-out';
  context.lineWidth = stroke; context.lineCap = 'round'; context.lineJoin = 'round';
  if (mark.tool === ImageEditorTool.Text) {
    const fontSize = (mark.fontSize ?? mark.width * 6) * Math.max(width, height);
    context.font = `${fontSize}px sans-serif`; context.textBaseline = 'top';
    const box = imageTextBounds(mark);
    if (mark.points.length > 1) { context.beginPath(); context.rect(box.x * width, box.y * height, box.width * width, box.height * height); context.clip(); }
    (mark.points.length > 1 ? wrapImageText(mark.text ?? '', box.width * width, value => context.measureText(value).width) : (mark.text ?? '').split('\n'))
      .forEach((line, i) => context.fillText(line, first.x, first.y + i * fontSize * 1.25));
  } else if (mark.tool === ImageEditorTool.Rectangle) {
    context.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
  } else {
    context.beginPath(); context.moveTo(first.x, first.y);
    points.slice(1).forEach(p => context.lineTo(p.x, p.y));
    if (points.length === 1) context.lineTo(first.x + 0.01, first.y);
    context.stroke();
    if (mark.tool === ImageEditorTool.Arrow) {
      const angle = Math.atan2(last.y - first.y, last.x - first.x);
      const head = Math.max(stroke * 4, width * 0.014);
      context.beginPath(); context.moveTo(last.x, last.y);
      context.lineTo(last.x - head * Math.cos(angle - Math.PI / 6), last.y - head * Math.sin(angle - Math.PI / 6));
      context.moveTo(last.x, last.y);
      context.lineTo(last.x - head * Math.cos(angle + Math.PI / 6), last.y - head * Math.sin(angle + Math.PI / 6)); context.stroke();
    }
  }
  context.restore();
}

/** Erasing is composited only within this transparent layer, never into the source image. */
export function drawImageMarks(context: CanvasRenderingContext2D, marks: ImageMark[], width: number, height: number): void {
  if (!marks.length) return;
  const layer = document.createElement('canvas'); layer.width = width; layer.height = height;
  const overlay = layer.getContext('2d'); if (!overlay) return;
  marks.forEach(mark => drawImageMark(overlay, mark, width, height));
  context.drawImage(layer, 0, 0);
}

export async function loadEditorImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error(i18nService.t('imageEditFailed'))); image.src = dataUrl;
  });
}

export function exportImageDrawing(image: HTMLImageElement, marks: ImageMark[], width = image.naturalWidth, height = image.naturalHeight, mask = false): string {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d'); if (!context) throw new Error(i18nService.t('imageEditFailed'));
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  if (mask) { context.fillStyle = '#000000'; context.fillRect(0, 0, width, height); }
  else context.drawImage(image, 0, 0, width, height);
  drawImageMarks(context, mask ? marks.map(mark => ({ ...mark, color: '#ffffff' })) : marks, width, height);
  return canvas.toDataURL('image/png');
}
