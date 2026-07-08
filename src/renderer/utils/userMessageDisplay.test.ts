import { describe, expect, test } from 'vitest';

import { parseUserMessageForDisplay } from './userMessageDisplay';

// ─── Helpers ────────────────────────────────────────────────

const WIN_INBOUND = String.raw`C:\Users\yangwn\AppData\Roaming\LobsterAI\openclaw\state\media\inbound`;
const MAC_INBOUND = '/Users/yangwn/Library/Application Support/LobsterAI/openclaw/state/media/inbound';

const fileImg = (dir: string, name: string) => `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`;

const toFileUrl = (p: string) => {
  const normalized = p.replace(/\\/g, '/');
  const urlPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `![](file://${encodeURI(urlPath)})`;
};

// ─── Passthrough ────────────────────────────────────────────

describe('passthrough (no transformation)', () => {
  test('empty string', () => {
    expect(parseUserMessageForDisplay('')).toBe('');
  });

  test('null/undefined returns as-is', () => {
    // @ts-expect-error test null input
    expect(parseUserMessageForDisplay(null)).toBe(null);
    // @ts-expect-error test undefined input
    expect(parseUserMessageForDisplay(undefined)).toBe(undefined);
  });

  test('plain text message unchanged', () => {
    expect(parseUserMessageForDisplay('你好，今天天气不错')).toBe('你好，今天天气不错');
  });

  test('message with markdown unchanged', () => {
    const md = '## Hello\n\n- item 1\n- item 2\n\n```js\nconsole.log("hi")\n```';
    expect(parseUserMessageForDisplay(md)).toBe(md);
  });

  test('file path NOT in inbound directory unchanged', () => {
    const msg = String.raw`C:\Users\yangwn\Desktop\screenshot.jpg`;
    expect(parseUserMessageForDisplay(msg)).toBe(msg);
  });
});

// ─── LobsterAI goal mode ────────────────────────────────────

describe('LobsterAI goal mode command display', () => {
  test('strips /goal start prefix from displayed user text', () => {
    const input = '/goal start 帮我做一个烘焙工作室的展示网页';
    expect(parseUserMessageForDisplay(input)).toBe('帮我做一个烘焙工作室的展示网页');
  });

  test('strips /goal set and preserves following attachment lines', () => {
    const input = [
      '/goal set Ship the landing page',
      '',
      '文件: /Users/admin/Desktop/brief.md',
    ].join('\n');
    expect(parseUserMessageForDisplay(input)).toBe([
      'Ship the landing page',
      '',
      '文件: /Users/admin/Desktop/brief.md',
    ].join('\n'));
  });

  test('does not strip non-start goal commands', () => {
    expect(parseUserMessageForDisplay('/goal status')).toBe('/goal status');
  });
});

// ─── Pattern A: NIM/DingTalk ────────────────────────────────

describe('Pattern A: NIM/DingTalk', () => {
  test('[图片] with URL and [附件信息] → strip metadata, preserve URL as text', () => {
    const imgPath = fileImg(WIN_INBOUND, 'abc123.jpg');
    const input = [
      '[图片] https://nos.netease.com/xxx.jpg',
      '',
      '[附件信息]',
      `- 类型: image, 路径: ${imgPath}, MIME: image/jpeg, 尺寸: 1920x1080`,
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe('https://nos.netease.com/xxx.jpg');
    expect(result).not.toContain('[图片]');
    expect(result).not.toContain('[附件信息]');
  });

  test('[图片] without URL → strip placeholder', () => {
    const input = [
      '[图片]',
      '',
      '[附件信息]',
      `- 类型: image, 路径: ${fileImg(WIN_INBOUND, 'abc123.jpg')}, MIME: image/jpeg`,
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe('');
  });

  test('user text + [图片] → preserve user text and URL', () => {
    const input = [
      '看看这张图',
      '[图片] https://nos.netease.com/xxx.jpg',
      '',
      '[附件信息]',
      `- 类型: image, 路径: ${fileImg(WIN_INBOUND, 'abc123.jpg')}, MIME: image/jpeg`,
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toContain('看看这张图');
    expect(result).toContain('https://nos.netease.com/xxx.jpg');
    expect(result).not.toContain('[图片]');
  });

  test('[语音消息] placeholder stripped', () => {
    const input = [
      '[语音消息]',
      '',
      '[附件信息]',
      `- 类型: audio, 路径: ${WIN_INBOUND}\\voice.mp3, MIME: audio/mp3`,
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).not.toContain('[语音消息]');
    expect(result).not.toContain('[附件信息]');
  });

  test('[文件] with URL → preserve URL', () => {
    const input = '[文件] https://nos.netease.com/file.pdf';
    const result = parseUserMessageForDisplay(input);
    expect(result).toBe('https://nos.netease.com/file.pdf');
  });

  test('[文件] without URL → strip', () => {
    const input = '[文件]';
    const result = parseUserMessageForDisplay(input);
    expect(result).toBe('');
  });

  test('multiple images in [附件信息] → strip block', () => {
    const input = [
      '[图片]',
      '',
      '[附件信息]',
      `- 类型: image, 路径: ${fileImg(WIN_INBOUND, 'img1.jpg')}, MIME: image/jpeg`,
      `- 类型: image, 路径: ${fileImg(WIN_INBOUND, 'img2.png')}, MIME: image/png`,
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).not.toContain('[附件信息]');
    expect(result).not.toContain('[图片]');
  });
});

// ─── Pattern B: OpenClaw gateway ────────────────────────────

describe('Pattern B: 企微 (WeCom)', () => {
  test('full format with pipe → strip all, render image', () => {
    const imgPath = fileImg(WIN_INBOUND, 'b02db622.jpg');
    const input = [
      `[media attached: ${imgPath} (image/jpeg) | ${imgPath}]`,
      'To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths - they are blocked for security. Keep caption in the text body.',
      '',
      'media:image',
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe(toFileUrl(imgPath));
    expect(result).not.toContain('[media attached');
    expect(result).not.toContain('To send an image back');
    expect(result).not.toContain('media:image');
  });
});

describe('Pattern B: 微信 (WeChat)', () => {
  test('format without pipe → strip all, render image', () => {
    const imgPath = fileImg(WIN_INBOUND, '154ba6cf.jpg');
    const input = [
      `[media attached: ${imgPath} (image/*)]`,
      'To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths - they are blocked for security. Keep caption in the text body.',
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe(toFileUrl(imgPath));
  });

  test('OpenClaw 6.1 metadata media path → render image without rewriting text', () => {
    const imgPath = fileImg(WIN_INBOUND, '913d415a.jpg');
    const input = [
      '[Image]',
      'Description:',
      'The image shows a cartoon frog-like creature.',
    ].join('\n');

    const result = parseUserMessageForDisplay(input, {
      localMediaAttachments: [{ localPath: imgPath, mimeType: 'image/jpeg' }],
    });

    expect(result).toBe(`${input}\n\n${toFileUrl(imgPath)}`);
  });

  test('metadata media path dedupes legacy [media attached:] path', () => {
    const imgPath = fileImg(WIN_INBOUND, '913d415a.jpg');
    const input = [
      `[media attached: ${imgPath} (image/jpeg)]`,
      'To send an image back, prefer the message tool (media/path/filePath).',
    ].join('\n');

    const result = parseUserMessageForDisplay(input, {
      localMediaAttachments: [{ localPath: imgPath, mimeType: 'image/jpeg' }],
    });

    expect(result).toBe(toFileUrl(imgPath));
  });

  test('metadata-only image message renders image', () => {
    const imgPath = fileImg(WIN_INBOUND, 'metadata-only.jpg');

    const result = parseUserMessageForDisplay('', {
      localMediaAttachments: [{ localPath: imgPath, mimeType: 'image/jpeg' }],
    });

    expect(result).toBe(toFileUrl(imgPath));
  });
});

describe('Pattern B: 飞书 (Feishu) — full content', () => {
  test('full format with System: line and bare path → strip all, render image', () => {
    const imgPath = fileImg(WIN_INBOUND, '0f209ea9.jpg');
    const input = [
      `[media attached: ${imgPath} (image/jpeg) | ${imgPath}]`,
      'To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths - they are blocked for security. Keep caption in the text body.',
      'System: [2026-04-27 15:54:25 GMT+8] Feishu[41f9d3b5] DM | ou_a17d2d2850e3d7a4cb4db0eeaf9cebd3 [msg:om_x100, image, 1 attachment(s)]',
      '',
      imgPath,
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe(toFileUrl(imgPath));
    expect(result).not.toContain('System:');
    expect(result).not.toContain('[media attached');
  });
});

describe('Pattern B: 飞书 — after server-side stripFeishuSystemHeader', () => {
  test('bare inbound path only (post-strip) → render image', () => {
    const imgPath = fileImg(WIN_INBOUND, '58c6a4bb.jpg');
    // After stripFeishuSystemHeader, only the bare path remains
    const result = parseUserMessageForDisplay(imgPath);
    expect(result).toBe(toFileUrl(imgPath));
  });

  test('bare inbound path with \\r\\n → render image', () => {
    const imgPath = fileImg(WIN_INBOUND, '58c6a4bb.jpg');
    const result = parseUserMessageForDisplay(`${imgPath}\r\n`);
    expect(result).toBe(toFileUrl(imgPath));
  });
});

// ─── System: timestamp lines ────────────────────────────────

describe('System: timestamp lines', () => {
  test('NIM system header stripped from text message', () => {
    const input = [
      'System: [2026-04-28 11:53:11 GMT+8] From user889589',
      '',
      '123',
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe('123');
  });

  test('multiple system lines stripped', () => {
    const input = [
      'System: [2026-04-28 11:53:11 GMT+8] From user889589',
      'System: [2026-04-28 11:53:12 GMT+8] NIM[abc123] DM',
      '',
      'hello',
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe('hello');
  });

  test('does NOT strip user text that looks vaguely like System:', () => {
    const msg = 'System: this is not a timestamp line';
    expect(parseUserMessageForDisplay(msg)).toBe(msg);
  });

  test('does NOT strip System: without valid timestamp', () => {
    const msg = 'System: [invalid] something';
    expect(parseUserMessageForDisplay(msg)).toBe(msg);
  });
});

// ─── Mac compatibility ──────────────────────────────────────

describe('Mac compatibility', () => {
  test('Mac inbound path → render image', () => {
    const imgPath = fileImg(MAC_INBOUND, 'abc123.jpg');
    const result = parseUserMessageForDisplay(imgPath);
    expect(result).toBe(toFileUrl(imgPath));
  });

  test('Mac path in [media attached:] → render image', () => {
    const imgPath = fileImg(MAC_INBOUND, 'abc123.jpg');
    const input = [
      `[media attached: ${imgPath} (image/jpeg) | ${imgPath}]`,
      'To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg.',
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe(toFileUrl(imgPath));
  });
});

// ─── False positive safety ──────────────────────────────────

describe('false positive safety', () => {
  test('user discussing a file path (not inbound) is NOT stripped', () => {
    const msg = String.raw`文件在 C:\Users\test\Documents\photo.jpg`;
    expect(parseUserMessageForDisplay(msg)).toBe(msg);
  });

  test('user typing "media:video" in a sentence is NOT stripped', () => {
    const msg = '格式是 media:video 这样的';
    expect(parseUserMessageForDisplay(msg)).toBe(msg);
  });

  test('user mentioning "To send an image back" without [media attached:] is NOT stripped', () => {
    const msg = 'To send an image back, prefer the message tool — 这是说明文档的内容';
    expect(parseUserMessageForDisplay(msg)).toBe(msg);
  });

  test('user typing [图片] in a sentence is NOT stripped (not on its own line)', () => {
    const msg = '他发了一个[图片]标记在消息里';
    // [图片] is not on its own line, NIM_PLACEHOLDER_RE requires ^...$
    expect(parseUserMessageForDisplay(msg)).toBe(msg);
  });
});

// ─── \\r\\n handling ─────────────────────────────────────────

describe('\\r\\n handling', () => {
  test('企微 format with \\r\\n line endings', () => {
    const imgPath = fileImg(WIN_INBOUND, 'b02db622.jpg');
    const input = [
      `[media attached: ${imgPath} (image/jpeg) | ${imgPath}]`,
      'To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg.',
      '',
      'media:image',
    ].join('\r\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe(toFileUrl(imgPath));
  });

  test('NIM format with \\r\\n line endings', () => {
    const input = [
      '[图片] https://nos.netease.com/xxx.jpg',
      '',
      '[附件信息]',
      `- 类型: image, 路径: ${fileImg(WIN_INBOUND, 'abc123.jpg')}, MIME: image/jpeg`,
    ].join('\r\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).toBe('https://nos.netease.com/xxx.jpg');
  });
});

// ─── Non-image media ────────────────────────────────────────

describe('non-image media', () => {
  test('[media attached:] with application/pdf → strip markers but no image rendered', () => {
    const pdfPath = fileImg(WIN_INBOUND, 'doc.pdf');
    const input = [
      `[media attached: ${pdfPath} (application/pdf) | ${pdfPath}]`,
      'To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg.',
    ].join('\n');

    const result = parseUserMessageForDisplay(input);
    expect(result).not.toContain('[media attached');
    // PDF should not be rendered as an image
    expect(result).not.toContain('![](');
  });
});
