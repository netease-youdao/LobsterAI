import { describe, expect, test } from 'vitest';

import { buildCopiedMessageHtml } from '../../services/messageClipboard';
import { getClipboardAttachmentFiles, getCopiedMessageImageFiles } from './clipboardAttachments';

const createClipboardData = ({
  files = [],
  plainText = '',
  uriList = '',
  html = '',
}: {
  files?: File[];
  plainText?: string;
  uriList?: string;
  html?: string;
}): DataTransfer => ({
  files,
  getData: (type: string) => {
    if (type === 'text/plain') return plainText;
    if (type === 'text/uri-list') return uriList;
    if (type === 'text/html') return html;
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

describe('getCopiedMessageImageFiles', () => {
  test('returns the images of a message copied with its copy button', async () => {
    const base64Data = Buffer.from('png-bytes').toString('base64');
    const clipboardData = createClipboardData({
      plainText: 'describe this',
      html: buildCopiedMessageHtml('describe this', [
        { name: 'shot.png', mimeType: 'image/png', base64Data },
      ]),
    });

    const files = getCopiedMessageImageFiles(clipboardData);

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('shot.png');
    expect(files[0].type).toBe('image/png');
    expect(Buffer.from(await files[0].arrayBuffer()).toString()).toBe('png-bytes');
  });

  test('ignores rich text copied from elsewhere', () => {
    const clipboardData = createClipboardData({
      plainText: 'hello',
      html: '<p>hello</p><img src="data:image/png;base64,AAAA">',
    });

    expect(getCopiedMessageImageFiles(clipboardData)).toEqual([]);
    expect(getCopiedMessageImageFiles(null)).toEqual([]);
  });
});
