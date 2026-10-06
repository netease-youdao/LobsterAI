import { describe, expect, test } from 'vitest';

import { getClipboardAttachmentFiles } from './clipboardAttachments';

const createClipboardData = ({
  files = [],
  plainText = '',
  uriList = '',
}: {
  files?: File[];
  plainText?: string;
  uriList?: string;
}): DataTransfer => ({
  files,
  getData: (type: string) => {
    if (type === 'text/plain') return plainText;
    if (type === 'text/uri-list') return uriList;
    return '';
  },
}) as unknown as DataTransfer;

describe('getClipboardAttachmentFiles', () => {
  test('does not infer attachments from path-shaped text or file URIs', () => {
    const clipboardData = createClipboardData({
      plainText: [
        'D:\\securepass\\app\\src\\ProtectionOverlayActivity.java:50: 错误',
        '    @Override',
        '    ^',
      ].join('\r\n'),
      uriList: 'file:///D:/securepass/app/src/ProtectionOverlayActivity.java',
    });

    expect(getClipboardAttachmentFiles(clipboardData)).toEqual([]);
  });

  test('returns actual clipboard file objects for attachment handling', () => {
    const file = { name: 'ProtectionOverlayActivity.java' } as File;
    const clipboardData = createClipboardData({
      files: [file],
      plainText: 'D:\\securepass\\app\\src\\ProtectionOverlayActivity.java',
    });

    expect(getClipboardAttachmentFiles(clipboardData)).toEqual([file]);
  });
});
