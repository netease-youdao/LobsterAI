import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { describe, expect, test } from 'vitest';

import {
  compactMediaDetails,
  compactMessageMetadataMedia,
  compactPersistedMediaAsset,
  INLINE_MEDIA_SOURCE_KEY_PREFIX,
  mediaSourceKey,
} from './mediaMetadataCompaction';

const dataUrl = `data:image/png;base64,${'A'.repeat(64)}`;
const otherDataUrl = `data:image/png;base64,${'B'.repeat(64)}`;
const sourceKey = (url: string) => `${INLINE_MEDIA_SOURCE_KEY_PREFIX}${crypto.createHash('sha256').update(url).digest('hex')}`;
const filePath = '/tmp/generated-image-1.png';
const fileUrl = pathToFileURL(filePath).href;

describe('mediaSourceKey', () => {
  test('hashes inline data URLs and keeps other sources', () => {
    expect(mediaSourceKey(` ${dataUrl} `)).toBe(sourceKey(dataUrl));
    expect(mediaSourceKey('https://cdn.example/image.png')).toBe('https://cdn.example/image.png');
    expect(mediaSourceKey(sourceKey(dataUrl))).toBe(sourceKey(dataUrl));
  });
});

describe('compactPersistedMediaAsset', () => {
  test('points a saved asset at its file', () => {
    expect(compactPersistedMediaAsset({ type: 'image', url: dataUrl, originalUrl: dataUrl, filePath, localPath: filePath }))
      .toEqual({ type: 'image', url: fileUrl, originalUrl: sourceKey(dataUrl), filePath, localPath: filePath });
  });

  test('keeps the only copy of an unsaved asset and leaves remote URLs alone', () => {
    const unsaved = { type: 'image', url: dataUrl };
    const remote = { type: 'video', url: 'https://cdn.example/v.mp4', originalUrl: 'https://cdn.example/v.mp4', filePath };
    expect(compactPersistedMediaAsset(unsaved)).toBe(unsaved);
    expect(compactPersistedMediaAsset(remote)).toBe(remote);
  });
});

describe('compactMediaDetails', () => {
  test('replaces inline URLs in saved assets, result URLs and spread task fields', () => {
    const details = {
      taskId: '13334',
      mediaType: 'image',
      status: 'succeeded',
      resultUrls: [dataUrl, otherDataUrl, 'https://cdn.example/remote.png'],
      assets: [{ type: 'image', url: dataUrl, originalUrl: dataUrl, filePath, localPath: filePath, outputIndex: 0 }],
      upstream: { preview: otherDataUrl },
    };
    expect(compactMediaDetails(details)).toEqual({
      taskId: '13334',
      mediaType: 'image',
      status: 'succeeded',
      resultUrls: [fileUrl, sourceKey(otherDataUrl), 'https://cdn.example/remote.png'],
      assets: [{ type: 'image', url: fileUrl, originalUrl: sourceKey(dataUrl), filePath, localPath: filePath, outputIndex: 0 }],
      upstream: { preview: sourceKey(otherDataUrl) },
    });
    expect(details.resultUrls[0]).toBe(dataUrl);
  });

  test('matches result URLs to assets that were already compacted', () => {
    const details = {
      mediaType: 'image',
      resultUrls: [dataUrl],
      assets: [{ type: 'image', url: fileUrl, originalUrl: sourceKey(dataUrl), filePath }],
    };
    expect(compactMediaDetails(details).resultUrls).toEqual([fileUrl]);
  });

  test('returns the same object when nothing is inline', () => {
    const details = { mediaType: 'image', assets: [{ type: 'image', url: fileUrl, filePath }], resultUrls: [] };
    expect(compactMediaDetails(details)).toBe(details);
  });

  test('ignores details of tools that are not media tasks', () => {
    const details = { screenshot: dataUrl };
    expect(compactMediaDetails(details)).toBe(details);
  });
});

describe('compactMessageMetadataMedia', () => {
  test('compacts both media detail fields and keeps the rest of the metadata', () => {
    const metadata = {
      toolUseId: 'call-1',
      toolInput: { images: [dataUrl] },
      toolResultDetails: { mediaType: 'image', resultUrls: [dataUrl] },
      mediaStatusDetails: { mediaType: 'image', assets: [{ type: 'image', url: dataUrl, originalUrl: dataUrl, filePath }] },
    };
    const compacted = compactMessageMetadataMedia(metadata);
    expect(compacted.toolUseId).toBe('call-1');
    expect(compacted.toolInput).toBe(metadata.toolInput);
    expect(compacted.toolResultDetails.resultUrls).toEqual([sourceKey(dataUrl)]);
    expect(compacted.mediaStatusDetails.assets[0]).toMatchObject({ url: fileUrl, originalUrl: sourceKey(dataUrl) });
    expect(JSON.stringify([compacted.toolResultDetails, compacted.mediaStatusDetails])).not.toContain('base64');
  });

  test('returns metadata without media details unchanged', () => {
    const metadata = { isThinking: true };
    expect(compactMessageMetadataMedia(metadata)).toBe(metadata);
    expect(compactMessageMetadataMedia(undefined)).toBeUndefined();
  });
});
