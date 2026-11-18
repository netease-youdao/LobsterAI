import {
  COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES,
  COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES,
  type CoworkImageAttachmentPayload,
  estimateBase64DecodedBytes,
  validateCoworkImageAttachmentSize,
} from '../../shared/cowork/imageAttachments';
import {
  formatPastedTextAttachmentBlocks,
  isPastedTextAttachment,
} from '../../shared/cowork/pastedText';
import type { CoworkSelectedTextSnippet } from '../../shared/cowork/selectedText';
import {
  computeMediaLabels,
  extractMediaReferencesFromPrompt,
} from '../components/cowork/mediaMentionUtils';
import type { MediaAttachmentRef } from '../types/mediaGeneration';
import { imageEditUserPrompt } from './imageEditingPrompt';

export interface CoworkPromptAttachment {
  imageEdit?: import('../../shared/imageEditing/types').ImageEditRequest;
  path: string;
  name: string;
  isImage?: boolean;
  isDirectory?: boolean;
  dataUrl?: string;
  pastedText?: string;
}

export interface PreparedCoworkPromptPayload {
  finalPrompt: string;
  imageAttachments?: CoworkImageAttachmentPayload[];
  mediaReferences?: MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
}

export const CoworkPromptPayloadFailureCode = {
  ImageTooLarge: 'image_too_large',
  ImagePreviewFailed: 'image_preview_failed',
} as const;
export type CoworkPromptPayloadFailureCode =
  typeof CoworkPromptPayloadFailureCode[keyof typeof CoworkPromptPayloadFailureCode];

export interface CoworkPromptPayloadFailure {
  code: CoworkPromptPayloadFailureCode;
  attachmentName: string;
  sizeBytes?: number;
  maxBytes?: number;
}

export type PrepareCoworkPromptPayloadResult =
  | { success: true; payload: PreparedCoworkPromptPayload }
  | { success: false; failure: CoworkPromptPayloadFailure };

interface PrepareCoworkPromptPayloadOptions {
  basePrompt: string;
  attachments: CoworkPromptAttachment[];
  selectedTextSnippets: CoworkSelectedTextSnippet[];
  modelSupportsImage: boolean;
  readFileAsDataUrl?: (path: string) => Promise<{ success: boolean; dataUrl?: string }>;
  createImagePreviewDataUrl?: (dataUrl: string) => Promise<string>;
  /** Re-encodes an image above the model's per-image limit into a data URL of at most `maxBytes`. */
  fitImageDataUrl?: (dataUrl: string, maxBytes: number) => Promise<string>;
  fileLabel: string;
  folderLabel: string;
}

const IMAGE_ATTACHMENT_PREVIEW_MAX_DIMENSION = 512;
const IMAGE_ATTACHMENT_PREVIEW_QUALITY = 0.78;
// OpenClaw downsizes model images far below this; the cap only bounds canvas work for huge sources.
const IMAGE_ATTACHMENT_MODEL_MAX_DIMENSION = 4096;
const IMAGE_ATTACHMENT_MODEL_QUALITY = 0.9;
const IMAGE_ATTACHMENT_MODEL_FIT_ATTEMPTS = 6;

const extractBase64FromDataUrl = (
  dataUrl: string,
): { mimeType: string; base64Data: string } | null => {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
};

const loadImage = (dataUrl: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Failed to load image attachment'));
  image.src = dataUrl;
});

const createDefaultImagePreviewDataUrl = async (dataUrl: string): Promise<string> => {
  const img = await loadImage(dataUrl);

  const scale = Math.min(
    1,
    IMAGE_ATTACHMENT_PREVIEW_MAX_DIMENSION
      / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height, 1),
  );
  const width = Math.max(1, Math.round((img.naturalWidth || img.width || 1) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || img.height || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create image preview canvas');
  }
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', IMAGE_ATTACHMENT_PREVIEW_QUALITY);
};

/** Builds the model's copy only; the original file stays untouched and is still referenced by localPath. */
const fitDefaultImageDataUrl = async (dataUrl: string, maxBytes: number): Promise<string> => {
  const img = await loadImage(dataUrl);
  const sourceWidth = img.naturalWidth || img.width || 1;
  const sourceHeight = img.naturalHeight || img.height || 1;
  let scale = Math.min(1, IMAGE_ATTACHMENT_MODEL_MAX_DIMENSION / Math.max(sourceWidth, sourceHeight));
  for (let attempt = 0; attempt < IMAGE_ATTACHMENT_MODEL_FIT_ATTEMPTS; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to create image attachment canvas');
    }
    // JPEG has no alpha channel: flatten transparent areas onto white rather than black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const fitted = canvas.toDataURL('image/jpeg', IMAGE_ATTACHMENT_MODEL_QUALITY);
    const fittedBytes = estimateBase64DecodedBytes(fitted);
    if (fittedBytes <= maxBytes) return fitted;
    scale *= Math.min(0.9, Math.sqrt(maxBytes / fittedBytes) * 0.9);
  }
  throw new Error('Failed to fit image attachment within the model size limit');
};

export async function prepareCoworkPromptPayload(
  options: PrepareCoworkPromptPayloadOptions,
): Promise<PrepareCoworkPromptPayloadResult> {
  const imageAttachments: CoworkImageAttachmentPayload[] = [];
  const imageAttachmentPathsWithPayload = new Set<string>();
  const createPreview = options.createImagePreviewDataUrl ?? createDefaultImagePreviewDataUrl;
  const fitImage = options.fitImageDataUrl ?? fitDefaultImageDataUrl;

  for (const attachment of options.attachments) {
    let imageDataUrl = attachment.dataUrl;
    if (
      attachment.isImage
      && !imageDataUrl
      && options.modelSupportsImage
      && !attachment.path.startsWith('inline:')
      && options.readFileAsDataUrl
    ) {
      try {
        const result = await options.readFileAsDataUrl(attachment.path);
        if (result.success && result.dataUrl) {
          imageDataUrl = result.dataUrl;
        }
      } catch {
        // Keep the attachment as a path when the file cannot be rehydrated.
      }
    }

    if (!attachment.isImage || !imageDataUrl) continue;
    let extracted = extractBase64FromDataUrl(imageDataUrl);
    if (!extracted) continue;

    let sizeValidation = validateCoworkImageAttachmentSize({
      base64Data: extracted.base64Data,
    });
    if (!sizeValidation.ok) {
      return {
        success: false,
        failure: {
          code: CoworkPromptPayloadFailureCode.ImageTooLarge,
          attachmentName: attachment.name,
          sizeBytes: sizeValidation.sizeBytes,
          maxBytes: sizeValidation.maxBytes,
        },
      };
    }

    if (sizeValidation.sizeBytes > COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES) {
      const originalSizeBytes = sizeValidation.sizeBytes;
      let fittedDataUrl: string | undefined;
      try {
        fittedDataUrl = await fitImage(imageDataUrl, COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES);
      } catch (error) {
        console.warn('[CoworkPromptPayload] Failed to fit image attachment within the model limit:', error);
      }
      const fitted = fittedDataUrl ? extractBase64FromDataUrl(fittedDataUrl) : null;
      const fittedValidation = fitted
        ? validateCoworkImageAttachmentSize({ base64Data: fitted.base64Data }, COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES)
        : null;
      if (!fittedDataUrl || !fitted || !fittedValidation?.ok) {
        return {
          success: false,
          failure: {
            code: CoworkPromptPayloadFailureCode.ImageTooLarge,
            attachmentName: attachment.name,
            sizeBytes: originalSizeBytes,
            maxBytes: COWORK_IMAGE_ATTACHMENT_MODEL_MAX_BYTES,
          },
        };
      }
      console.debug(
        `[CoworkPromptPayload] Re-encoded image attachment for the model: ${originalSizeBytes} -> ${fittedValidation.sizeBytes} bytes.`,
      );
      imageDataUrl = fittedDataUrl;
      extracted = fitted;
      sizeValidation = fittedValidation;
    }

    let previewMimeType: string | undefined;
    let previewBase64Data: string | undefined;
    if (sizeValidation.sizeBytes > COWORK_IMAGE_ATTACHMENT_PREVIEW_FALLBACK_MAX_BYTES) {
      try {
        const preview = extractBase64FromDataUrl(await createPreview(imageDataUrl));
        if (preview) {
          previewMimeType = preview.mimeType;
          previewBase64Data = preview.base64Data;
        }
      } catch {
        // Report a structured failure below.
      }
      if (!previewBase64Data) {
        return {
          success: false,
          failure: {
            code: CoworkPromptPayloadFailureCode.ImagePreviewFailed,
            attachmentName: attachment.name,
          },
        };
      }
    }

    imageAttachments.push({
      name: attachment.name,
      mimeType: extracted.mimeType,
      base64Data: extracted.base64Data,
      sizeBytes: sizeValidation.sizeBytes,
      ...(!attachment.path.startsWith('inline:') ? { localPath: attachment.path } : {}),
      ...(previewMimeType && previewBase64Data ? { previewMimeType, previewBase64Data } : {}),
    });
    imageAttachmentPathsWithPayload.add(attachment.path);
  }

  const attachmentLines = options.attachments
    .filter(attachment => (
      !attachment.path.startsWith('inline:')
      && !attachment.imageEdit
      && !isPastedTextAttachment(attachment)
      && !(attachment.isImage && imageAttachmentPathsWithPayload.has(attachment.path))
    ))
    .map(attachment => `${attachment.isDirectory ? options.folderLabel : options.fileLabel}: ${attachment.path}`)
    .join('\n');
  // Pasted-text cards follow the typed prompt in the order they were pasted.
  const basePrompt = [options.basePrompt, ...formatPastedTextAttachmentBlocks(options.attachments)]
    .filter(Boolean)
    .join('\n\n');
  let finalPrompt = basePrompt
    ? (attachmentLines ? `${basePrompt}\n\n${attachmentLines}` : basePrompt)
    : attachmentLines;
  const mediaLabels = computeMediaLabels(options.attachments);
  const editLines = mediaLabels.filter(item => item.attachment.imageEdit).map(item =>
    `@${item.label} ${imageEditUserPrompt(item.attachment.imageEdit!)}`);
  if (editLines.length) finalPrompt = [finalPrompt, ...editLines].filter(Boolean).join('\n\n');
  const mediaReferences = extractMediaReferencesFromPrompt(finalPrompt, mediaLabels);

  return {
    success: true,
    payload: {
      finalPrompt,
      imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      mediaReferences: mediaReferences.length > 0 ? mediaReferences : undefined,
      selectedTextSnippets: options.selectedTextSnippets.length > 0
        ? options.selectedTextSnippets
        : undefined,
    },
  };
}
