/**
 * @lobsterai/dsh-channels — Cordis Channels Service Plugin
 *
 * Mounts `ChannelManager` onto DSH and exposes the owner-only authenticated
 * Fetch route `POST /api/lobsterai/channels` via `ctx.connection.fetch.register`.
 */

import { ChannelManager, RETAINED_IM_PLATFORMS } from './channel-registry.mjs';
import { WeixinChannelDriver } from './drivers/weixin.mjs';

export const name = 'lobster-channels-service';
export const inject = ['connection'];

const CHANNELS_ROUTE_PATH = '/api/lobsterai/channels';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function notifyElectronBridge(payload) {
  const bridgeUrl = (process.env.LOBSTERAI_DSH_BRIDGE_URL || '').replace(/\/+$/, '');
  const bridgeSecret = process.env.LOBSTERAI_DSH_BRIDGE_SECRET || '';
  if (!bridgeUrl) return null;
  try {
    const res = await fetch(`${bridgeUrl}/dsh-bridge/channel-event`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(bridgeSecret ? { authorization: `Bearer ${bridgeSecret}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return await res.json().catch(() => ({ ok: true }));
  } catch {
    // Best-effort telemetry/event bridge; never fail IM receive loop.
    return null;
  }
}

export function apply(ctx) {
  const manager = new ChannelManager({
    ctx,
    bridgeNotify: notifyElectronBridge,
  });

  ctx.connection.fetch.register({
    path: CHANNELS_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'Request body must be valid JSON' }, 400);
      }

      const action = body && typeof body === 'object' ? body.action : undefined;
      const payload = body && typeof body === 'object' ? body.payload : undefined;

      try {
        switch (action) {
          case 'listStatus':
            return jsonResponse({
              ok: true,
              result: {
                supportedPlatforms: [...RETAINED_IM_PLATFORMS],
                statuses: manager.listStatus(),
              },
            });

          case 'syncInstances': {
            const list = payload && typeof payload === 'object' && Array.isArray(payload.instances)
              ? payload.instances
              : [];
            const result = await manager.syncInstances(list);
            return jsonResponse({ ok: true, result });
          }

          case 'send': {
            const p = payload && typeof payload === 'object' ? payload : {};
            const result = await manager.send({
              platform: p.platform,
              instanceId: p.instanceId,
              chatId: p.chatId,
              text: p.text,
              replyContext: p.replyContext,
            });
            return jsonResponse({ ok: true, result });
          }

          case 'weixinQrStart': {
            const p = payload && typeof payload === 'object' ? payload : {};
            const result = await WeixinChannelDriver.startQrLogin({
              baseUrl: p.baseUrl,
              botType: p.botType,
              localTokenList: p.localTokenList,
              timeoutMs: p.timeoutMs,
              signal: request.signal,
            });
            return jsonResponse({ ok: true, result });
          }

          case 'weixinQrPoll': {
            const p = payload && typeof payload === 'object' ? payload : {};
            const result = await WeixinChannelDriver.pollQrLogin(p.qrcode, {
              baseUrl: p.baseUrl,
              timeoutMs: p.timeoutMs,
              verifyCode: p.verifyCode,
              signal: request.signal,
            });
            return jsonResponse({ ok: true, result });
          }

          default:
            return jsonResponse({ ok: false, error: `Unknown channels action: ${String(action)}` }, 400);
        }
      } catch (error) {
        return jsonResponse(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          500,
        );
      }
    },
  });

  ctx.effect(() => async () => {
    await manager.dispose();
  }, 'lobster-channels-service cleanup');
}
