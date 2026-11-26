import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import {
  COWORK_IMAGE_ATTACHMENT_MAX_BYTES,
  type CoworkImageAttachmentPayload,
  type CoworkImageAttachmentPreview,
  estimateBase64DecodedBytes,
  isBrowserAnnotationTransportImage,
  isStoredOriginalImagePreview,
  stripDataUrlPrefix,
} from '../../shared/cowork/imageAttachments';
import { CoworkImageOriginalStore } from '../libs/coworkImageOriginalStore';
import { inferImageExtensionFromBytes } from '../libs/mediaAssetPersistence';
import { TrustedWriteContext, withTrustedMigrationWrite } from './remoteWriteContext';

const HISTORY_IMAGES_KEY = 'migration.dsh.conversationImages.v1';
type StoredImage = CoworkImageAttachmentPreview | CoworkImageAttachmentPayload;

function readPickedImage(filePath: string | undefined): Buffer | undefined {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return;
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size > 0 && stat.size <= COWORK_IMAGE_ATTACHMENT_MAX_BYTES) {
      const bytes = fs.readFileSync(filePath);
      if (inferImageExtensionFromBytes(bytes)) return bytes;
    }
  } catch {
    // A previously picked file may have been moved; the stored preview is still usable.
  }
}

function prepareImage(store: CoworkImageOriginalStore, sessionId: string, image: StoredImage) {
  if (!image || typeof image.name !== 'string' || isBrowserAnnotationTransportImage(image)) return;
  const inline = typeof image.base64Data === 'string'
    && estimateBase64DecodedBytes(image.base64Data) <= COWORK_IMAGE_ATTACHMENT_MAX_BYTES
    ? Buffer.from(stripDataUrlPrefix(image.base64Data), 'base64') : undefined;
  const isPreview = 'isPreview' in image && image.isPreview;
  const inlineOriginal = inline && inferImageExtensionFromBytes(inline)
    && (!isPreview || isStoredOriginalImagePreview(image));
  const original = (inlineOriginal ? inline : undefined)
    ?? readPickedImage(image.retainedOriginalPath) ?? readPickedImage(image.localPath);
  const bytes = original ?? inline;
  const ext = bytes && inferImageExtensionFromBytes(bytes);
  if (!bytes || !ext) return;
  const mimeType = ext === '.jpg' ? 'image/jpeg' : 'image/' + ext.slice(1);
  const retained = store.persistInboundImage(sessionId, { mimeType, base64Data: bytes.toString('base64') });
  if (!retained) throw new Error('Could not prepare a historical image attachment');
  if (original) image.retainedOriginalPath = retained;
  return { name: image.name, path: retained, previewOnly: !original };
}

/** Materialize picked, pasted, or inline release images before the upgraded window opens. */
export function migrateLegacyConversationImages(db: Database.Database, userDataDir: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()) return;
  if (db.prepare('SELECT 1 FROM kv WHERE key = ?').get(HISTORY_IMAGES_KEY)) return;
  const columns = (db.pragma('table_info(cowork_messages)') as { name: string }[]).map(c => c.name);
  if (!['id', 'session_id', 'type', 'metadata'].every(c => columns.includes(c))) return;
  const store = new CoworkImageOriginalStore(path.join(userDataDir, 'cowork-image-originals'));
  withTrustedMigrationWrite(db, TrustedWriteContext.Session, db.transaction(() => {
    // Keep only IDs in memory, decoding one message's image payload at a time.
    const ids = db.prepare(
      'SELECT id FROM cowork_messages WHERE type = ? AND metadata LIKE ?',
    ).all('user', '%"imageAttachment%') as { id: string }[];
    const get = db.prepare('SELECT session_id, metadata FROM cowork_messages WHERE id = ?');
    const update = db.prepare('UPDATE cowork_messages SET metadata = ? WHERE id = ?');
    for (const { id } of ids) {
      const row = get.get(id) as { session_id: string; metadata: string };
      let metadata;
      try { metadata = JSON.parse(row.metadata); } catch { continue; }
      const images = metadata?.imageAttachmentPreviews?.length ? metadata.imageAttachmentPreviews : metadata?.imageAttachments;
      if (!Array.isArray(images)) continue;
      const references = images.map(image => prepareImage(store, row.session_id, image)).filter(Boolean);
      if (references.length) {
        metadata.historyImageReferences = references;
        update.run(JSON.stringify(metadata), id);
      }
    }
    db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(HISTORY_IMAGES_KEY, 'true', Date.now());
  }));
}
