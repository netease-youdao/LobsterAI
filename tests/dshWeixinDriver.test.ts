import { createCipheriv } from 'node:crypto';

import { afterEach, describe, expect, test, vi } from 'vitest';

const DRIVER_PATH = '../dsh-bundles/lobsterai-channels/plugins/drivers/weixin.mjs';

function encryptAesEcb(plaintext: Buffer, key16: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key16, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DSH WeixinChannelDriver iLink protocol', () => {
  test('startQrLogin sends POST get_bot_qrcode with iLink headers and local_token_list', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.AuthorizationType).toBe('ilink_bot_token');
      expect(headers['iLink-App-Id']).toBe('bot');
      expect(Number(headers['iLink-App-ClientVersion'])).toBeGreaterThan(0);
      expect(headers['X-WECHAT-UIN']).toBeTruthy();
      expect(JSON.parse(String(init?.body))).toEqual({ local_token_list: ['prev-tok'] });

      return new Response(
        JSON.stringify({
          qrcode: 'qr-xyz',
          qrcode_img_content: 'https://liteapp.weixin.qq.com/q/xyz',
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { WeixinChannelDriver } = await import(DRIVER_PATH);
    const result = await WeixinChannelDriver.startQrLogin({
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      localTokenList: ['prev-tok'],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3',
      expect.any(Object),
    );
    expect(result).toEqual({
      qrcode: 'qr-xyz',
      qrcode_img_content: 'https://liteapp.weixin.qq.com/q/xyz',
      qrDataUrl: 'https://liteapp.weixin.qq.com/q/xyz',
    });
  });

  test('pollQrLogin sends iLink headers and maps timeout or 524 gateway timeout to wait', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('gateway timeout', { status: 524 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'confirmed',
            bot_token: 'new-bot-token',
            ilink_bot_id: 'bot@im.bot',
            baseurl: 'https://sz.ilinkai.weixin.qq.com',
            ilink_user_id: 'user@im.wechat',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { WeixinChannelDriver } = await import(DRIVER_PATH);
    const first = await WeixinChannelDriver.pollQrLogin('qr-xyz');
    expect(first).toEqual({ status: 'wait' });

    const second = await WeixinChannelDriver.pollQrLogin('qr-xyz', {
      baseUrl: 'https://sz.ilinkai.weixin.qq.com',
    });
    expect(second).toMatchObject({
      status: 'confirmed',
      bot_token: 'new-bot-token',
      ilink_bot_id: 'bot@im.bot',
    });

    const callInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = callInit.headers as Record<string, string>;
    expect(headers['iLink-App-Id']).toBe('bot');
    expect(Number(headers['iLink-App-ClientVersion'])).toBeGreaterThan(0);
  });

  test('connect fails with not configured when token is missing', async () => {
    const { WeixinChannelDriver } = await import(DRIVER_PATH);
    const driver = new WeixinChannelDriver({
      instanceId: 'default',
      config: { accountId: '91fcaf18cb3a@im.bot' },
      onInbound: async () => {},
    });

    await expect(driver.start()).rejects.toThrow(/not configured/i);
    expect(driver.getStatus().state).toBe('error');
  });

  test('sendMessage posts full iLink envelope with base_info and validates business receipt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: 0 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ret: 0, errcode: -14 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const { WeixinChannelDriver } = await import(DRIVER_PATH);
    const driver = new WeixinChannelDriver({
      instanceId: 'default',
      config: {
        accountId: 'bot@im.bot',
        botToken: 'live-token',
        baseUrl: 'https://sz.ilinkai.weixin.qq.com',
      },
      onInbound: async () => {},
    });

    const ok = await driver.sendMessage({
      chatId: 'user@im.wechat',
      text: 'hello',
      replyContext: { contextToken: 'ctx-1' },
    });
    expect(ok.delivered).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://sz.ilinkai.weixin.qq.com/ilink/bot/sendmessage');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer live-token');
    expect(headers.AuthorizationType).toBe('ilink_bot_token');
    expect(headers['iLink-App-Id']).toBe('bot');
    const body = JSON.parse(String(init.body)) as {
      msg: Record<string, unknown>;
      base_info: Record<string, unknown>;
    };
    expect(body.msg).toMatchObject({
      from_user_id: '',
      to_user_id: 'user@im.wechat',
      message_type: 2,
      message_state: 2,
      context_token: 'ctx-1',
      item_list: [{ type: 1, text_item: { text: 'hello' } }],
    });
    expect(body.base_info).toMatchObject({
      channel_version: '2.4.3',
    });

    await expect(
      driver.sendMessage({ chatId: 'user@im.wechat', text: 'second' }),
    ).rejects.toThrow('WEIXIN_ACCOUNT_EXPIRED ret=0 errcode=-14');
  });

  test('pollLoop downloads and AES-decrypts Weixin voice, image, voice_item.text, and quoted text', async () => {
    const voiceKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const voicePlain = Buffer.from('\x02#!SILK_V3fake-silk-audio-payload', 'binary');
    const voiceCipher = encryptAesEcb(voicePlain, voiceKey);
    // Voice media uses base64(32-char ASCII hex) encoding
    const voiceAesKeyBase64 = Buffer.from(voiceKey.toString('hex'), 'ascii').toString('base64');

    const imgKeyHex = 'ffeeddccbbaa99887766554433221100';
    const pngPlain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
    const imgCipher = encryptAesEcb(pngPlain, Buffer.from(imgKeyHex, 'hex'));

    const received: Array<Record<string, unknown>> = [];
    let getUpdatesCount = 0;

    const { WeixinChannelDriver } = await import(DRIVER_PATH);
    let driverRef: InstanceType<typeof WeixinChannelDriver> | null = null;

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/ilink/bot/msg/notifystart') || url.endsWith('/ilink/bot/msg/notifystop')) {
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      if (url.endsWith('/ilink/bot/getupdates')) {
        getUpdatesCount += 1;
        if (getUpdatesCount === 1) {
          return new Response(
            JSON.stringify({
              ret: 0,
              get_updates_buf: 'cursor-2',
              msgs: [
                {
                  message_id: 101,
                  from_user_id: 'wx_user@im.wechat',
                  message_type: 1,
                  context_token: 'ctx-voice-cdn',
                  item_list: [
                    {
                      type: 3,
                      voice_item: {
                        encode_type: 6,
                        sample_rate: 24000,
                        playtime: 4100,
                        media: {
                          encrypt_query_param: 'enc_voice_param_1',
                          aes_key: voiceAesKeyBase64,
                        },
                      },
                    },
                  ],
                },
                {
                  message_id: 102,
                  from_user_id: 'wx_user@im.wechat',
                  message_type: 1,
                  context_token: 'ctx-voice-text',
                  item_list: [
                    {
                      type: 3,
                      voice_item: {
                        text: '服务器已经转写好的语音',
                        media: {
                          encrypt_query_param: 'should_not_be_fetched',
                          aes_key: voiceAesKeyBase64,
                        },
                      },
                    },
                  ],
                },
                {
                  message_id: 103,
                  from_user_id: 'wx_user@im.wechat',
                  message_type: 1,
                  context_token: 'ctx-quoted',
                  item_list: [
                    {
                      type: 1,
                      text_item: { text: '这个怎么改？' },
                      ref_msg: {
                        title: '原始消息',
                        message_item: { type: 1, text_item: { text: '报错了' } },
                      },
                    },
                  ],
                },
                {
                  message_id: 104,
                  from_user_id: 'wx_user@im.wechat',
                  message_type: 1,
                  context_token: 'ctx-img',
                  item_list: [
                    {
                      type: 2,
                      image_item: {
                        aeskey: imgKeyHex,
                        media: {
                          full_url: 'https://cdn.example.test/encrypted-img',
                        },
                      },
                    },
                  ],
                },
              ],
            }),
            { status: 200 },
          );
        }
        // Stop polling after first batch is processed
        await driverRef?.stop();
        return new Response(JSON.stringify({ ret: 0, msgs: [] }), { status: 200 });
      }
      if (url === 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=enc_voice_param_1') {
        return new Response(new Uint8Array(voiceCipher), { status: 200 });
      }
      if (url === 'https://cdn.example.test/encrypted-img') {
        return new Response(new Uint8Array(imgCipher), { status: 200 });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const driver = new WeixinChannelDriver({
      instanceId: 'default',
      config: {
        accountId: 'bot@im.bot',
        botToken: 'live-token',
        baseUrl: 'https://sz.ilinkai.weixin.qq.com',
      },
      onInbound: async (msg: Record<string, unknown>) => {
        received.push(msg);
      },
    });
    driverRef = driver;

    await driver.start();
    await vi.waitFor(() => {
      expect(received).toHaveLength(4);
    });
    await driver.stop();

    // 1. Encrypted voice message -> decrypted SILK attachment
    expect(received[0]).toMatchObject({
      platform: 'weixin',
      chatId: 'wx_user@im.wechat',
      text: '',
      messageId: '101',
      replyContext: { contextToken: 'ctx-voice-cdn' },
      attachments: [
        {
          kind: 'voice',
          dataBase64: voicePlain.toString('base64'),
          encodeType: 6,
          sampleRate: 24000,
          playtimeMs: 4100,
        },
      ],
    });

    // 2. Voice with server-provided text -> text only, no CDN download
    expect(received[1]).toMatchObject({
      text: '服务器已经转写好的语音',
      messageId: '102',
    });
    expect(received[1]?.attachments).toBeUndefined();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('should_not_be_fetched'))).toBe(false);

    // 3. Quoted text message
    expect(received[2]).toMatchObject({
      text: '[引用: 原始消息 | 报错了]\n这个怎么改？',
      messageId: '103',
    });

    // 4. Encrypted image message -> PNG mime detected + decrypted bytes
    expect(received[3]).toMatchObject({
      text: '',
      messageId: '104',
      attachments: [
        {
          kind: 'image',
          mimeType: 'image/png',
          dataBase64: pngPlain.toString('base64'),
          sizeBytes: pngPlain.byteLength,
          name: 'weixin-image-104.png',
        },
      ],
    });
  });

  test('extractInboundAttachments downloads all image items when a Weixin message carries multiple images', async () => {
    const imgKeyHex = '00112233445566778899aabbccddeeff';
    const pngPlain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa]);
    const jpgPlain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const pngCipher = encryptAesEcb(pngPlain, Buffer.from(imgKeyHex, 'hex'));
    const jpgCipher = encryptAesEcb(jpgPlain, Buffer.from(imgKeyHex, 'hex'));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === 'https://cdn.example.test/img-1') {
          return new Response(new Uint8Array(pngCipher), { status: 200 });
        }
        if (url === 'https://cdn.example.test/img-2') {
          return new Response(new Uint8Array(jpgCipher), { status: 200 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );

    const { WeixinChannelDriver } = await import(DRIVER_PATH);
    const driver = new WeixinChannelDriver({
      instanceId: 'default',
      config: { accountId: 'bot@im.bot', botToken: 'live-token' },
      onInbound: async () => {},
    });

    const attachments = await driver.extractInboundAttachments(
      [
        {
          type: 2,
          image_item: { aeskey: imgKeyHex, media: { full_url: 'https://cdn.example.test/img-1' } },
        },
        {
          type: 2,
          image_item: { aeskey: imgKeyHex, media: { full_url: 'https://cdn.example.test/img-2' } },
        },
      ],
      { message_id: 205 },
      undefined,
    );

    expect(attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        dataBase64: pngPlain.toString('base64'),
        sizeBytes: pngPlain.byteLength,
        name: 'weixin-image-205-1.png',
      },
      {
        kind: 'image',
        mimeType: 'image/jpeg',
        dataBase64: jpgPlain.toString('base64'),
        sizeBytes: jpgPlain.byteLength,
        name: 'weixin-image-205-2.jpg',
      },
    ]);
  });
});
