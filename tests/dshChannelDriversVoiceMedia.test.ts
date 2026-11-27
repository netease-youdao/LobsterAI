import { createCipheriv } from 'node:crypto';

import { afterEach, describe, expect, test, vi } from 'vitest';

const DINGTALK_DRIVER_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/dingtalk.mjs';
const FEISHU_DRIVER_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/feishu.mjs';
const WECOM_DRIVER_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/wecom.mjs';
const QQ_DRIVER_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/qq.mjs';
const TELEGRAM_DRIVER_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/telegram.mjs';
const DISCORD_DRIVER_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/discord.mjs';
const MEDIA_UTILS_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/media-utils.mjs';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22]);
const AMR_SAMPLE = Buffer.from('#!AMR\n\x04\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'binary');
const OGG_OPUS_SAMPLE = Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00OpusHead', 'binary');

describe('DSH IM Channel Drivers — Voice & Image Inbound Support', () => {
  test('DingTalkChannelDriver supports audio recognition text, audio downloadCode fallback, and picture download', async () => {
    const { DingTalkChannelDriver } = await import(DINGTALK_DRIVER_PATH);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://api.dingtalk.com/v1.0/oauth2/accessToken') {
        expect(JSON.parse(String(init?.body))).toEqual({
          appKey: 'dt-app-key',
          appSecret: 'dt-app-secret',
        });
        return new Response(JSON.stringify({ accessToken: 'dt-tok-1', expireIn: 7200 }), { status: 200 });
      }
      if (url === 'https://api.dingtalk.com/v1.0/robot/messageFiles/download') {
        const reqBody = JSON.parse(String(init?.body)) as { downloadCode: string; robotCode: string };
        expect((init?.headers as Record<string, string>)['x-acs-dingtalk-access-token']).toBe('dt-tok-1');
        expect(reqBody.robotCode).toBe('dt-app-key');
        if (reqBody.downloadCode === 'voice-dl-code') {
          return new Response(JSON.stringify({ downloadUrl: 'https://cdn.dingtalk.test/voice.amr' }), { status: 200 });
        }
        if (reqBody.downloadCode === 'pic-dl-code') {
          return new Response(JSON.stringify({ downloadUrl: 'https://cdn.dingtalk.test/pic.png' }), { status: 200 });
        }
      }
      if (url === 'https://cdn.dingtalk.test/voice.amr') {
        return new Response(new Uint8Array(AMR_SAMPLE), { status: 200, headers: { 'content-type': 'audio/amr' } });
      }
      if (url === 'https://cdn.dingtalk.test/pic.png') {
        return new Response(new Uint8Array(PNG_MAGIC), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`Unexpected DingTalk URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const driver = new DingTalkChannelDriver({
      instanceId: 'dt-1',
      config: { clientId: 'dt-app-key', clientSecret: 'dt-app-secret' },
      onInbound: async () => {},
    });

    // 1. Audio with DingTalk server-side recognition text -> immediate text, zero CDN fetch
    const recResult = await driver.extractInboundPayload(
      {
        msgtype: 'audio',
        content: JSON.stringify({ recognition: '帮我总结今天的会议纪要', downloadCode: 'unused-code' }),
      },
      undefined,
    );
    expect(recResult).toEqual({ text: '帮我总结今天的会议纪要', attachments: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    // 2. Audio without recognition (or placeholder) -> downloads binary via downloadCode
    const rawVoiceResult = await driver.extractInboundPayload(
      {
        msgtype: 'audio',
        content: { downloadCode: 'voice-dl-code', recognition: '' },
      },
      undefined,
    );
    expect(rawVoiceResult).toEqual({
      text: '',
      attachments: [{ kind: 'voice', dataBase64: AMR_SAMPLE.toString('base64') }],
    });

    // 3. Picture message via downloadCode
    const picResult = await driver.extractInboundPayload(
      {
        msgtype: 'picture',
        msgId: 'm-pic',
        content: { downloadCode: 'pic-dl-code' },
      },
      undefined,
    );
    expect(picResult).toEqual({
      text: '',
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          dataBase64: PNG_MAGIC.toString('base64'),
          sizeBytes: PNG_MAGIC.byteLength,
          name: 'dingtalk-image-m-pic.png',
        },
      ],
    });
  });

  test('FeishuChannelDriver encodes/decodes pbbp2 protobuf frames and downloads audio & image resources', async () => {
    const { FeishuChannelDriver, decodePbbp2Frame, encodePbbp2Frame } = await import(FEISHU_DRIVER_PATH);

    // Verify pbbp2 binary round-trip
    const encoded = encodePbbp2Frame({
      SeqID: 42n,
      LogID: 99n,
      service: 33554678,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'evt-1' },
      ],
      payload: Buffer.from('{"hello":"feishu"}', 'utf8'),
    });
    const decoded = decodePbbp2Frame(encoded);
    expect(decoded.SeqID).toBe(42n);
    expect(decoded.service).toBe(33554678);
    expect(decoded.method).toBe(1);
    expect(decoded.headers).toEqual([
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'evt-1' },
    ]);
    expect(Buffer.from(decoded.payload).toString('utf8')).toBe('{"hello":"feishu"}');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't-feishu-tok', expire: 7200 }),
          { status: 200 },
        );
      }
      if (url === 'https://open.feishu.cn/open-apis/im/v1/messages/om_voice_1/resources/file_v1?type=file') {
        return new Response(new Uint8Array(OGG_OPUS_SAMPLE), { status: 200 });
      }
      throw new Error(`Unexpected Feishu URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const received: Array<Record<string, unknown>> = [];
    const driver = new FeishuChannelDriver({
      instanceId: 'fs-1',
      config: { appId: 'cli_a', appSecret: 'sec_b' },
      onInbound: async (msg: Record<string, unknown>) => {
        received.push(msg);
      },
    });

    await driver.handleFeishuEventPayload(
      {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_user_1' } },
          message: {
            message_id: 'om_voice_1',
            chat_id: 'oc_chat_1',
            chat_type: 'p2p',
            message_type: 'audio',
            content: JSON.stringify({ file_key: 'file_v1', duration: 3500 }),
          },
        },
      },
      undefined,
    );

    expect(received).toEqual([
      {
        platform: 'feishu',
        instanceId: 'fs-1',
        chatId: 'oc_chat_1',
        senderId: 'ou_user_1',
        text: '',
        attachments: [
          {
            kind: 'voice',
            dataBase64: OGG_OPUS_SAMPLE.toString('base64'),
            playtimeMs: 3500,
          },
        ],
        messageId: 'om_voice_1',
        chatType: 'direct',
        replyContext: { receiveIdType: 'chat_id', isGroup: false, replyToMessageId: 'om_voice_1' },
      },
    ]);
  });

  test('WeComChannelDriver handles voice.content ASR text and AES-256-CBC 32-byte PKCS7 encrypted media', async () => {
    const { WeComChannelDriver } = await import(WECOM_DRIVER_PATH);

    // Encrypt PNG_MAGIC with WeCom AES-256-CBC (32-byte key, IV = key[0..16], 32-byte PKCS#7 padding)
    const aesKey = Buffer.alloc(32, 0x5a);
    const iv = aesKey.subarray(0, 16);
    const padLen = 32 - (PNG_MAGIC.length % 32);
    const padded = Buffer.concat([PNG_MAGIC, Buffer.alloc(padLen, padLen)]);
    const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
    cipher.setAutoPadding(false);
    const encryptedImg = Buffer.concat([cipher.update(padded), cipher.final()]);
    const aesKeyBase64 = aesKey.toString('base64');

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(encryptedImg), { status: 200 })),
    );

    const driver = new WeComChannelDriver({
      instanceId: 'wc-1',
      config: { botId: 'aibot-1', secret: 'sec-1' },
      onInbound: async () => {},
    });

    const voiceRes = await driver.extractWsInbound(
      {
        body: {
          msgid: 'wc-m1',
          msgtype: 'voice',
          voice: { content: '企业微信已转写的语音内容' },
        },
      },
      undefined,
    );
    expect(voiceRes).toEqual({ text: '企业微信已转写的语音内容', attachments: [] });

    const imgRes = await driver.extractWsInbound(
      {
        body: {
          msgid: 'wc-m2',
          msgtype: 'image',
          image: { url: 'https://wecom.cdn.test/enc.bin', aeskey: aesKeyBase64 },
        },
      },
      undefined,
    );
    expect(imgRes).toEqual({
      text: '',
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          dataBase64: PNG_MAGIC.toString('base64'),
          sizeBytes: PNG_MAGIC.byteLength,
          name: 'wecom-image-wc-m2-1.png',
        },
      ],
    });
  });

  test('QQChannelDriver handles asr_refer_text and protocol-relative voice_wav_url', async () => {
    const { QQChannelDriver } = await import(QQ_DRIVER_PATH);
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://qq.cdn.test/voice.wav');
      return new Response(new Uint8Array(OGG_OPUS_SAMPLE), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const driver = new QQChannelDriver({
      instanceId: 'qq-1',
      config: { appId: '1020', clientSecret: 'sec' },
      onInbound: async () => {},
    });

    // 1. Uses QQ server asr_refer_text when provided
    const asrRes = await driver.extractInboundPayload(
      {
        id: 'qq-1',
        content: ' <@!bot123> ',
        attachments: [{ content_type: 'voice', url: '//qq.cdn.test/v.silk', asr_refer_text: 'QQ语音识别结果' }],
      },
      undefined,
    );
    expect(asrRes).toEqual({ text: 'QQ语音识别结果', attachments: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    // 2. Downloads voice_wav_url when asr_refer_text is empty
    const wavRes = await driver.extractInboundPayload(
      {
        id: 'qq-2',
        content: '',
        attachments: [{ content_type: 'voice', url: '//qq.cdn.test/v.silk', voice_wav_url: '//qq.cdn.test/voice.wav' }],
      },
      undefined,
    );
    expect(wavRes).toEqual({
      text: '',
      attachments: [{ kind: 'voice', dataBase64: OGG_OPUS_SAMPLE.toString('base64') }],
    });
  });

  test('TelegramChannelDriver and DiscordChannelDriver download inbound voice and image attachments', async () => {
    const { TelegramChannelDriver } = await import(TELEGRAM_DRIVER_PATH);
    const { DiscordChannelDriver } = await import(DISCORD_DRIVER_PATH);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === 'https://api.telegram.org/bottest-tg-tok/getFile') {
          return new Response(
            JSON.stringify({ ok: true, result: { file_path: 'voice/file_1.oga' } }),
            { status: 200 },
          );
        }
        if (url === 'https://api.telegram.org/file/bottest-tg-tok/voice/file_1.oga') {
          return new Response(new Uint8Array(OGG_OPUS_SAMPLE), { status: 200 });
        }
        if (url === 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg') {
          return new Response(new Uint8Array(OGG_OPUS_SAMPLE), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const tgDriver = new TelegramChannelDriver({
      instanceId: 'tg-1',
      config: { botToken: 'test-tg-tok' },
      onInbound: async () => {},
    });
    const tgRes = await tgDriver.extractInboundPayload(
      { message_id: 7, voice: { file_id: 'tg-v1', duration: 4 } },
      undefined,
    );
    expect(tgRes).toEqual({
      text: '',
      attachments: [
        {
          kind: 'voice',
          dataBase64: OGG_OPUS_SAMPLE.toString('base64'),
          playtimeMs: 4000,
        },
      ],
    });

    const dcDriver = new DiscordChannelDriver({
      instanceId: 'dc-1',
      config: { botToken: 'test-dc-tok' },
      onInbound: async () => {},
    });
    dcDriver.botUserId = '999';
    const dcRes = await dcDriver.extractInboundPayload(
      {
        id: 'dc-m1',
        content: '<@999>',
        attachments: [
          {
            filename: 'voice-message.ogg',
            content_type: 'audio/ogg',
            duration_secs: 2.6,
            url: 'https://cdn.discordapp.com/attachments/1/2/voice-message.ogg',
          },
        ],
      },
      undefined,
    );
    expect(dcRes).toEqual({
      text: '',
      attachments: [
        {
          kind: 'voice',
          dataBase64: OGG_OPUS_SAMPLE.toString('base64'),
          playtimeMs: 2600,
        },
      ],
    });
  });

  test('DingTalk, WeCom, Feishu, QQ, Telegram, and Discord download direct/quoted/file images without [图片] placeholders', async () => {
    const { DingTalkChannelDriver } = await import(DINGTALK_DRIVER_PATH);
    const { WeComChannelDriver } = await import(WECOM_DRIVER_PATH);
    const { FeishuChannelDriver } = await import(FEISHU_DRIVER_PATH);
    const { QQChannelDriver } = await import(QQ_DRIVER_PATH);
    const { TelegramChannelDriver } = await import(TELEGRAM_DRIVER_PATH);
    const { DiscordChannelDriver } = await import(DISCORD_DRIVER_PATH);

    // 1. DingTalk: replying to a picture downloads the original image and omits [引用: [图片]] placeholder
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === 'https://cdn.dingtalk.test/quoted.png') {
          return new Response(new Uint8Array(PNG_MAGIC), { status: 200, headers: { 'content-type': 'image/png' } });
        }
        throw new Error(`Unexpected DingTalk URL: ${url}`);
      }),
    );
    const dtDriver = new DingTalkChannelDriver({
      instanceId: 'dt-2',
      config: { clientId: 'app', clientSecret: 'sec' },
      onInbound: async () => {},
    });
    const dtQuotedRes = await dtDriver.extractInboundPayload(
      {
        msgtype: 'text',
        msgId: 'dt-q1',
        text: {
          content: '帮我看这张图',
          isReplyMsg: true,
          repliedMsg: {
            msgType: 'picture',
            content: { pictureUrl: 'https://cdn.dingtalk.test/quoted.png' },
          },
        },
      },
      undefined,
    );
    expect(dtQuotedRes.text).toBe('帮我看这张图');
    expect(dtQuotedRes.text).not.toContain('[图片]');
    expect(dtQuotedRes.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        dataBase64: PNG_MAGIC.toString('base64'),
        sizeBytes: PNG_MAGIC.byteLength,
        name: 'dingtalk-image-dt-q1.png',
      },
    ]);

    // 2. WeCom: quoting an encrypted image downloads/decrypts original image and omits [引用: [图片]]
    const aesKey = Buffer.alloc(32, 0x3b);
    const iv = aesKey.subarray(0, 16);
    const padLen = 32 - (PNG_MAGIC.length % 32);
    const padded = Buffer.concat([PNG_MAGIC, Buffer.alloc(padLen, padLen)]);
    const cipher = createCipheriv('aes-256-cbc', aesKey, iv);
    cipher.setAutoPadding(false);
    const encryptedImg = Buffer.concat([cipher.update(padded), cipher.final()]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(encryptedImg), { status: 200 })),
    );
    const wcDriver = new WeComChannelDriver({
      instanceId: 'wc-2',
      config: { botId: 'bot', secret: 'sec' },
      onInbound: async () => {},
    });
    const wcQuotedRes = await wcDriver.extractWsInbound(
      {
        body: {
          msgid: 'wc-q1',
          msgtype: 'text',
          text: { content: '解释一下图里内容' },
          quote: {
            msgtype: 'image',
            image: { url: 'https://wecom.cdn.test/q.bin', aeskey: aesKey.toString('base64') },
          },
        },
      },
      undefined,
    );
    expect(wcQuotedRes.text).toBe('解释一下图里内容');
    expect(wcQuotedRes.text).not.toContain('[图片]');
    expect(wcQuotedRes.attachments).toHaveLength(1);
    expect(wcQuotedRes.attachments[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      dataBase64: PNG_MAGIC.toString('base64'),
    });

    // 3. Feishu: replying to a parent image message fetches parent and downloads original image
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tok-fs', expire: 7200 }), { status: 200 });
        }
        if (url === 'https://open.feishu.cn/open-apis/im/v1/messages/om_parent_img') {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                items: [
                  {
                    message_id: 'om_parent_img',
                    msg_type: 'image',
                    body: { content: JSON.stringify({ image_key: 'img_key_parent' }) },
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        if (url === 'https://open.feishu.cn/open-apis/im/v1/messages/om_parent_img/resources/img_key_parent?type=image') {
          return new Response(new Uint8Array(PNG_MAGIC), { status: 200 });
        }
        throw new Error(`Unexpected Feishu URL: ${url}`);
      }),
    );
    const fsReceived: Array<Record<string, unknown>> = [];
    const fsDriver = new FeishuChannelDriver({
      instanceId: 'fs-2',
      config: { appId: 'cli_a', appSecret: 'sec_b' },
      onInbound: async (msg: Record<string, unknown>) => {
        fsReceived.push(msg);
      },
    });
    await fsDriver.handleFeishuEventPayload(
      {
        header: { event_type: 'im.message.receive_v1' },
        event: {
          sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
          message: {
            message_id: 'om_reply_1',
            parent_id: 'om_parent_img',
            chat_id: 'oc_1',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: '这是啥图' }),
          },
        },
      },
      undefined,
    );
    expect(fsReceived).toHaveLength(1);
    expect(fsReceived[0]).toMatchObject({
      text: '这是啥图',
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          dataBase64: PNG_MAGIC.toString('base64'),
          name: 'feishu-image-om_parent_img.png',
        },
      ],
    });

    // 4. QQ: attachment with content_type='image' (no slash) is recognized and downloaded
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(PNG_MAGIC), { status: 200 })),
    );
    const qqDriver = new QQChannelDriver({
      instanceId: 'qq-2',
      config: { appId: '1', clientSecret: 'sec' },
      onInbound: async () => {},
    });
    const qqImgRes = await qqDriver.extractInboundPayload(
      {
        id: 'qq-img-1',
        content: '',
        attachments: [{ content_type: 'image', url: '//qq.cdn.test/original' }],
      },
      undefined,
    );
    expect(qqImgRes.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        dataBase64: PNG_MAGIC.toString('base64'),
        sizeBytes: PNG_MAGIC.byteLength,
        name: 'qq-image-qq-img-1-1.png',
      },
    ]);

    // 5. Telegram: replying to a photo downloads the largest original photo from reply_to_message
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === 'https://api.telegram.org/bottest-tg/getFile') {
          expect(JSON.parse(String(init?.body))).toEqual({ file_id: 'photo-hd' });
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/hd.png' } }), { status: 200 });
        }
        if (url === 'https://api.telegram.org/file/bottest-tg/photos/hd.png') {
          return new Response(new Uint8Array(PNG_MAGIC), { status: 200 });
        }
        throw new Error(`Unexpected Telegram URL: ${url}`);
      }),
    );
    const tgDriver = new TelegramChannelDriver({
      instanceId: 'tg-2',
      config: { botToken: 'test-tg' },
      onInbound: async () => {},
    });
    const tgQuotedRes = await tgDriver.extractInboundPayload(
      {
        message_id: 22,
        text: 'What is in this photo?',
        reply_to_message: {
          photo: [
            { file_id: 'photo-hd', width: 1280, height: 960, file_size: 200_000 },
            { file_id: 'photo-thumb', width: 90, height: 67, file_size: 2_000 },
          ],
        },
      },
      undefined,
    );
    expect(tgQuotedRes).toEqual({
      text: 'What is in this photo?',
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          dataBase64: PNG_MAGIC.toString('base64'),
          sizeBytes: PNG_MAGIC.byteLength,
          name: 'telegram-image-22.png',
        },
      ],
    });

    // 6. Discord: replying to a message with image attachments downloads the original image
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(PNG_MAGIC), { status: 200, headers: { 'content-type': 'image/png' } })),
    );
    const dcDriver = new DiscordChannelDriver({
      instanceId: 'dc-2',
      config: { botToken: 'test-dc' },
      onInbound: async () => {},
    });
    const dcQuotedRes = await dcDriver.extractInboundPayload(
      {
        id: 'dc-q1',
        content: 'check this',
        attachments: [],
        referenced_message: {
          content: '',
          attachments: [
            {
              filename: 'screenshot.png',
              content_type: 'image/png',
              url: 'https://cdn.discordapp.com/attachments/1/2/screenshot.png',
            },
          ],
        },
      },
      undefined,
    );
    expect(dcQuotedRes).toEqual({
      text: 'check this',
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          dataBase64: PNG_MAGIC.toString('base64'),
          sizeBytes: PNG_MAGIC.byteLength,
          name: 'screenshot.png',
        },
      ],
    });
  });

  test('validateMediaDownloadUrl and fetchBinaryWithLimit block SSRF targets and unsafe redirects', async () => {
    const { fetchBinaryWithLimit, validateMediaDownloadUrl } = await import(MEDIA_UTILS_PATH);

    expect(validateMediaDownloadUrl('//qq.cdn.test/voice.wav?sig=abc%2B1')).toBe(
      'https://qq.cdn.test/voice.wav?sig=abc%2B1',
    );
    expect(validateMediaDownloadUrl('https://cdn.discordapp.com:443/attachments/1/2/photo%20[1].png')).toBe(
      'https://cdn.discordapp.com/attachments/1/2/photo%20[1].png',
    );

    for (const blockedUrl of [
      'file:///etc/passwd',
      'data:image/png;base64,AAAA',
      'https://user:pass@cdn.example.com/a.png',
      'http://localhost/secret',
      'http://sub.localhost:8080/secret',
      'http://service.internal/meta',
      'http://printer.local/status',
      'http://127.0.0.1:9000/api/lobsterai/ops',
      'http://0x7f000001/secret',
      'http://10.0.0.1/internal',
      'http://172.16.5.4/internal',
      'http://192.168.1.1/router',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]:8080/secret',
      'http://[::ffff:127.0.0.1]/secret',
      'https://cdn.example.com/a/%2e%2e/secret',
    ]) {
      expect(() => validateMediaDownloadUrl(blockedUrl), blockedUrl).toThrow();
    }

    // Follows a safe redirect and strips Authorization on cross-origin redirect
    const fetchCalls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        fetchCalls.push({ url, auth: headers.get('authorization') });
        if (url === 'https://cdn-a.example.test/start.png') {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://cdn-b.example.test/final.png' },
          });
        }
        if (url === 'https://cdn-b.example.test/final.png') {
          return new Response(new Uint8Array(PNG_MAGIC), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }
        if (url === 'https://cdn-a.example.test/evil-redirect') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1:8080/api/lobsterai/ops' },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const ok = await fetchBinaryWithLimit('https://cdn-a.example.test/start.png', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(ok.buffer.equals(PNG_MAGIC)).toBe(true);
    expect(fetchCalls).toEqual([
      { url: 'https://cdn-a.example.test/start.png', auth: 'Bearer secret-token' },
      { url: 'https://cdn-b.example.test/final.png', auth: null },
    ]);

    await expect(fetchBinaryWithLimit('https://cdn-a.example.test/evil-redirect')).rejects.toThrow(
      /not allowed/i,
    );
  });

  test('DiscordChannelDriver and QQChannelDriver clamp out-of-range heartbeat intervals', async () => {
    const { DiscordChannelDriver } = await import(DISCORD_DRIVER_PATH);
    const { QQChannelDriver } = await import(QQ_DRIVER_PATH);

    const intervals: number[] = [];
    const realSetInterval = globalThis.setInterval;
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((fn: TimerHandler, ms?: number) => {
        intervals.push(Number(ms));
        return realSetInterval(fn, 60_000);
      }) as typeof globalThis.setInterval);

    class FakeWebSocket extends EventTarget {
      readyState = 1;
      sent: string[] = [];
      send(data: string) {
        this.sent.push(data);
      }
      close() {
        this.readyState = 3;
        this.dispatchEvent(new Event('close'));
      }
    }

    const sockets: FakeWebSocket[] = [];
    vi.stubGlobal(
      'WebSocket',
      class extends FakeWebSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      },
    );

    const discord = new DiscordChannelDriver({
      instanceId: 'dc-hb',
      config: { botToken: 'tok' },
      onInbound: async () => {},
    });
    const dcAbort = new AbortController();
    const dcLoop = discord.runGateway('wss://gateway.discord.gg/?v=10&encoding=json', { id: '1', username: 'b' }, dcAbort.signal);
    const dcWs = sockets[0];
    dcWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 1 } }) }));
    dcWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 9_999_999 } }) }));
    dcWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }) }));
    dcAbort.abort();
    await dcLoop;

    const qq = new QQChannelDriver({
      instanceId: 'qq-hb',
      config: { appId: '1', clientSecret: 'sec' },
      onInbound: async () => {},
    });
    qq.accessToken = 'qq-tok';
    qq.tokenExpiresAt = Date.now() + 600_000;
    const qqAbort = new AbortController();
    const qqLoop = qq.runGateway('wss://api.sgroup.qq.com/websocket', qqAbort.signal);
    await Promise.resolve();
    const qqWs = sockets[1];
    qqWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 10 } }) }));
    qqWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 35_000 } }) }));
    qqAbort.abort();
    await qqLoop;

    setIntervalSpy.mockRestore();
    expect(intervals).toEqual([41_250, 41_250, 45_000, 30_000, 35_000]);
  });
});
