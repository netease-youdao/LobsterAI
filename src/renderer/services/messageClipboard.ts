import { copyTextAndHtmlToClipboard, copyTextToClipboard } from './clipboard';

/**
 * Marks HTML written by a message's copy button. Plain text cannot carry the
 * message's images, so they ride along as data-URL `<img>` tags in the HTML
 * flavor, which the composer reads back on paste.
 */
const COPIED_MESSAGE_MARKER_ATTRIBUTE = 'data-lobsterai-copied-message';
const COPIED_MESSAGE_IMAGE_NAME_ATTRIBUTE = 'data-lobsterai-image-name';

const IMAGE_MIME_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/i;
const IMAGE_DATA_URL_PREFIX_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,/i;
const BASE64_PATTERN = /^[a-z0-9+/]*={0,2}$/i;

export interface CopiedMessageImage {
  name: string;
  mimeType: string;
  base64Data: string;
}

/** An image attached to a sent message, as stored in the message metadata. */
export interface MessageImageSource {
  name: string;
  /** Stored image data; for previews this is the downscaled preview. */
  mimeType: string;
  base64Data: string;
  /** Present on previews: the type of the original file at `localPath`. */
  originalMimeType?: string;
  localPath?: string;
}

type ReadFileAsDataUrl = (filePath: string) => Promise<{ success: boolean; dataUrl?: string }>;

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const decodeHtmlEntities = (value: string): string => value
  .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
  .replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const readHtmlAttribute = (tag: string, attribute: string): string | null => {
  const match = new RegExp(`\\s${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!match) return null;
  return decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '');
};

const normalizeBase64 = (value: string): string | null => {
  const base64Data = value.replace(/\s+/g, '');
  return base64Data && BASE64_PATTERN.test(base64Data) ? base64Data : null;
};

const parseImageDataUrl = (dataUrl: string): Omit<CopiedMessageImage, 'name'> | null => {
  const prefix = IMAGE_DATA_URL_PREFIX_PATTERN.exec(dataUrl);
  if (!prefix) return null;
  const base64Data = normalizeBase64(dataUrl.slice(prefix[0].length));
  return base64Data ? { mimeType: prefix[1].toLowerCase(), base64Data } : null;
};

const fallbackImageName = (index: number): string => `image-${index + 1}`;

export const buildCopiedMessageHtml = (text: string, images: CopiedMessageImage[]): string => {
  const textHtml = text
    ? `<div>${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`
    : '';
  const imagesHtml = images.map(image => {
    const name = escapeHtml(image.name);
    return `<p><img src="data:${image.mimeType};base64,${image.base64Data}" alt="${name}" ${COPIED_MESSAGE_IMAGE_NAME_ATTRIBUTE}="${name}"></p>`;
  }).join('');
  return `<div ${COPIED_MESSAGE_MARKER_ATTRIBUTE}="1">${textHtml}${imagesHtml}</div>`;
};

/** Returns the images of a copied message, or nothing for HTML from anywhere else. */
export const extractCopiedMessageImages = (html: string): CopiedMessageImage[] => {
  if (!html || !html.includes(COPIED_MESSAGE_MARKER_ATTRIBUTE)) return [];
  if (!new RegExp(`<[a-z][^>]*\\s${COPIED_MESSAGE_MARKER_ATTRIBUTE}\\s*=`, 'i').test(html)) return [];

  const images: CopiedMessageImage[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = readHtmlAttribute(tag, 'src');
    const image = src ? parseImageDataUrl(src) : null;
    if (!image) continue;
    const name = (readHtmlAttribute(tag, COPIED_MESSAGE_IMAGE_NAME_ATTRIBUTE) ?? readHtmlAttribute(tag, 'alt'))?.trim();
    images.push({ name: name || fallbackImageName(images.length), ...image });
  }
  return images;
};

export const createCopiedMessageImageFile = (image: CopiedMessageImage): File => {
  const binary = atob(image.base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new File([bytes], image.name, { type: image.mimeType });
};

/**
 * Prefers the original file, since stored message images may be downscaled
 * previews; falls back to the stored data when the original is gone.
 */
export const resolveMessageImagesForCopy = async (
  images: MessageImageSource[],
  readFileAsDataUrl?: ReadFileAsDataUrl,
): Promise<CopiedMessageImage[]> => {
  const resolved: CopiedMessageImage[] = [];
  for (const [index, image] of images.entries()) {
    const name = image.name?.trim() || fallbackImageName(index);
    if (image.localPath && readFileAsDataUrl) {
      try {
        const result = await readFileAsDataUrl(image.localPath);
        const dataUrl = result.success ? result.dataUrl : undefined;
        const base64Index = dataUrl?.indexOf(';base64,') ?? -1;
        const base64Data = dataUrl && base64Index >= 0
          ? normalizeBase64(dataUrl.slice(base64Index + ';base64,'.length))
          : null;
        if (dataUrl && base64Data) {
          // Unknown extensions read back as application/octet-stream; keep the
          // image type recorded with the message instead.
          const readMimeType = dataUrl.slice('data:'.length, base64Index);
          const mimeType = [readMimeType, image.originalMimeType, image.mimeType]
            .find(candidate => candidate && IMAGE_MIME_TYPE_PATTERN.test(candidate));
          if (mimeType) {
            resolved.push({ name, mimeType, base64Data });
            continue;
          }
        }
      } catch (error) {
        console.warn('[MessageClipboard] failed to read the original image, using the stored copy:', error);
      }
    }

    const base64Data = normalizeBase64(image.base64Data ?? '');
    if (base64Data && IMAGE_MIME_TYPE_PATTERN.test(image.mimeType)) {
      resolved.push({ name, mimeType: image.mimeType, base64Data });
    }
  }
  return resolved;
};

/** Copies a message's text, plus its images when it has any. */
export const copyMessageToClipboard = async (
  text: string,
  images: MessageImageSource[],
): Promise<boolean> => {
  if (images.length === 0) return copyTextToClipboard(text);
  const resolvedImages = await resolveMessageImagesForCopy(images, window.electron?.dialog?.readFileAsDataUrl);
  if (resolvedImages.length === 0) return copyTextToClipboard(text);
  return copyTextAndHtmlToClipboard({
    text,
    html: buildCopiedMessageHtml(text, resolvedImages),
  });
};
