import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

import { CoworkImageAttachmentRole } from '../../shared/cowork/imageAttachments';
import { migrateLegacyConversationImages } from './legacyConversationImages';

test('prepares picked and inline history per profile, marks thumbnail fallbacks, and skips annotation transport', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-visual-'));
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);'
      + 'CREATE TABLE cowork_messages(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,metadata TEXT)');
    const original = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const file = path.join(profile, 'selected.png');
    fs.writeFileSync(file, original);
    const thumb = { name: 'picked', base64Data: '/9j/4AA=', mimeType: 'image/jpeg',
      originalMimeType: 'image/png', originalSizeBytes: original.length, isPreview: true };
    const inline = { name: 'paste', mimeType: 'image/png', base64Data: original.toString('base64') };
    const add = db.prepare('INSERT INTO cowork_messages VALUES (?, ?, ?, ?)');
    add.run('1', 'first', 'user', JSON.stringify({ imageAttachmentPreviews: [
      { ...thumb, localPath: file }, { ...thumb, name: 'missing' },
      { ...thumb, role: CoworkImageAttachmentRole.BrowserAnnotation },
    ] }));
    add.run('2', 'second', 'user', JSON.stringify({ imageAttachments: [inline] }));
    add.run('3', 'first', 'assistant', JSON.stringify({ imageAttachments: [inline] }));
    const read = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM cowork_messages WHERE id = ?').get(id) as {metadata: string}).metadata);
    migrateLegacyConversationImages(db, profile);
    const first = read('1'), second = read('2');
    expect(first.historyImageReferences.map((image: {previewOnly: boolean}) => image.previewOnly)).toEqual([false, true]);
    const retained = first.imageAttachmentPreviews[0].retainedOriginalPath;
    expect(fs.readFileSync(retained)).toEqual(original);
    expect(path.relative(profile, retained).split(path.sep)[0]).toEqual('cowork-image-originals');
    expect(first.imageAttachmentPreviews[1].retainedOriginalPath).toBeUndefined();
    expect(second.historyImageReferences[0].path).not.toEqual(retained);
    expect(fs.readFileSync(second.historyImageReferences[0].path)).toEqual(original);
    expect(read('3').historyImageReferences).toBeUndefined();
    fs.unlinkSync(file);
    migrateLegacyConversationImages(db, profile);
    expect(read('1')).toEqual(first);
    expect(fs.readFileSync(retained)).toEqual(original);
  } finally {
    db.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
