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

  test('persists inbound IM images with servable extensions and cleans them up with the session', () => {
    const { store } = createStore();
    const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const saved = store.persistInboundImage('im-session-1', {
      mimeType: 'image/png',
      base64Data: rawBytes.toString('base64'),
    });
    expect(saved).not.toBeNull();
    expect(saved).toMatch(/\.png$/);
    expect(fs.readFileSync(saved!)).toEqual(rawBytes);
    // Identical bytes in the same session reuse the persisted file.
    expect(
      store.persistInboundImage('im-session-1', {
        mimeType: 'image/png',
        base64Data: rawBytes.toString('base64'),
      }),
    ).toBe(saved);

    // Unknown MIME types fall back to .jpg so localfile:// can serve them.
    const fallbackSaved = store.persistInboundImage('im-session-1', {
      mimeType: 'application/octet-stream',
      base64Data: Buffer.from('jpeg-ish').toString('base64'),
    });
    expect(fallbackSaved).toMatch(/\.jpg$/);

    // Existing localPath is returned as-is; empty base64 returns null.
    expect(
      store.persistInboundImage('im-session-1', {
        mimeType: 'image/jpeg',
        base64Data: '',
        localPath: '/existing/image.jpg',
      }),
    ).toBe('/existing/image.jpg');
    expect(
      store.persistInboundImage('im-session-1', {
        mimeType: 'image/jpeg',
        base64Data: '',
      }),
    ).toBeNull();

    store.deleteSession('im-session-1');
    expect(fs.existsSync(saved!)).toBe(false);
    expect(fs.existsSync(fallbackSaved!)).toBe(false);
  });
});
