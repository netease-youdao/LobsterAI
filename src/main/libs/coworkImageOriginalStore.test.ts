import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { CoworkImageAttachmentRole } from '../../shared/cowork/imageAttachments';
import { CoworkImageOriginalStore } from './coworkImageOriginalStore';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createStore(): { store: CoworkImageOriginalStore; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-image-originals-'));
  roots.push(root);
  return { store: new CoworkImageOriginalStore(root), root };
}

const pasted = { name: 'pasted.png', mimeType: 'image/png', base64Data: Buffer.from('original').toString('base64'),
  previewMimeType: 'image/jpeg', previewBase64Data: 'thumbnail' };

describe('retained originals of payload-only images', () => {
  test('keeps the original of a pasted image that is stored as a thumbnail', () => {
    const { store } = createStore();
    const [retained] = store.retain('session', [pasted])!;
    expect(fs.readFileSync(retained.retainedOriginalPath!, 'utf8')).toBe('original');
    expect(retained.retainedOriginalPath).toMatch(/\.png$/);
    // Resending the same image reuses the retained copy.
    expect(store.retain('session', [pasted])![0].retainedOriginalPath).toBe(retained.retainedOriginalPath);
  });

  test('leaves images that already have a durable original untouched', () => {
    const { store, root } = createStore();
    const attachments = [
      { ...pasted, localPath: '/images/file.png' },
      { ...pasted, previewMimeType: undefined, previewBase64Data: undefined },
      { ...pasted, role: CoworkImageAttachmentRole.BrowserAnnotation },
    ];
    expect(store.retain('session', attachments)).toEqual(attachments);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(store.retain('session', undefined)).toBeUndefined();
  });

  test('removes a session\'s originals with the session, and only that session\'s', () => {
    const { store } = createStore();
    const [first] = store.retain('first', [pasted])!;
    const [second] = store.retain('second', [pasted])!;
    store.deleteSession('first');
    expect(fs.existsSync(first.retainedOriginalPath!)).toBe(false);
    expect(fs.existsSync(second.retainedOriginalPath!)).toBe(true);
  });
});
