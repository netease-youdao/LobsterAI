import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type CoworkImageAttachmentPayload, isBrowserAnnotationTransportImage } from '../../shared/cowork/imageAttachments';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
};

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
        const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${EXTENSION_BY_MIME[attachment.mimeType] ?? 'img'}`;
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

  deleteSession(sessionId: string): void {
    try {
      fs.rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
    } catch (error) {
      console.warn('[CoworkImageOriginals] could not remove retained originals:', error);
    }
  }
}
