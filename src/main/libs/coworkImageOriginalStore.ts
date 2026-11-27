import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type CoworkImageAttachmentPayload,
  isBrowserAnnotationTransportImage,
  stripDataUrlPrefix,
} from '../../shared/cowork/imageAttachments';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

function resolveImageExtension(mimeType: string | undefined, fallback: string): string {
  const normalized = (mimeType ?? '').trim().toLowerCase().split(';')[0].trim();
  return EXTENSION_BY_MIME[normalized] ?? fallback;
}

/**
 * Keeps the originals of images that exist only as a payload (pasted or
 * captured images). A message stores just a thumbnail for these, so without
 * a retained copy it could never be edited and resent with its image.
 */
export class CoworkImageOriginalStore {
  constructor(private readonly rootDir: string) {}

  private sessionDir(sessionId: string): string {
    return path.join(this.rootDir, createHash('sha256').update(sessionId).digest('hex'));
  }

  /** Synchronous so a send keeps its place ahead of the first await. Never fails the send. */
  retain(sessionId: string, attachments: CoworkImageAttachmentPayload[] | undefined): CoworkImageAttachmentPayload[] | undefined {
    if (!attachments?.length) return attachments;
    return attachments.map(attachment => {
      // Images without a thumbnail are stored whole on the message already.
      if (attachment.localPath || attachment.retainedOriginalPath || !attachment.previewBase64Data
        || isBrowserAnnotationTransportImage(attachment)) return attachment;
      try {
        const bytes = Buffer.from(attachment.base64Data, 'base64');
        const directory = this.sessionDir(sessionId);
        const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${resolveImageExtension(attachment.mimeType, 'img')}`;
        const filePath = path.join(directory, name);
        fs.mkdirSync(directory, { recursive: true });
        if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, bytes);
        return { ...attachment, retainedOriginalPath: filePath };
      } catch (error) {
        console.warn('[CoworkImageOriginals] could not retain a pasted image original:', error);
        return attachment;
      }
    });
  }

  /**
   * Persist an inbound IM image original on disk under the session directory so
   * LobsterAI can display the original image via `localfile://` without storing
   * large base64 payloads in SQLite. Never throws; returns null on failure.
   */
  persistInboundImage(
    sessionId: string,
    attachment: Pick<CoworkImageAttachmentPayload, 'mimeType' | 'base64Data' | 'localPath'>,
  ): string | null {
    if (attachment.localPath?.trim()) {
      return attachment.localPath.trim();
    }
    const base64Data = stripDataUrlPrefix(attachment.base64Data || '').trim();
    if (!base64Data) return null;
    try {
      const bytes = Buffer.from(base64Data, 'base64');
      if (bytes.byteLength === 0) return null;
      const directory = this.sessionDir(sessionId);
      const ext = resolveImageExtension(attachment.mimeType, 'jpg');
      const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
      const filePath = path.join(directory, name);
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, bytes);
      return filePath;
    } catch (error) {
      console.warn('[CoworkImageOriginals] could not persist inbound image:', error);
      return null;
    }
  }

  deleteSession(sessionId: string): void {
    try {
      fs.rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch (error) {
      console.warn('[CoworkImageOriginals] could not remove retained originals:', error);
    }
  }
}
