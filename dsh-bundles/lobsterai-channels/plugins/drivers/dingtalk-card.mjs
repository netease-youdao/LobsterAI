import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { formatCardMarkdown } from './card-markdown.mjs';

const CARD_API = 'https://api.dingtalk.com/v1.0/card';
const AI_CARD_TEMPLATE = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';
const FlowStatus = { Inputting: '2', Finished: '3' };
const CONTENT_KEY = 'msgContent';

export async function sendDingTalkCard({ token, robotCode, target, isGroup, text }) {
  const outTrackId = randomUUID();
  const config = JSON.stringify({ autoLayout: true });
  const request = (method, path, body) => fetch(CARD_API + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  try {
    const created = await request('POST', '/instances', {
      cardTemplateId: AI_CARD_TEMPLATE,
      outTrackId,
      cardData: { cardParamMap: { config } },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    });
    if (!created.ok || (await created.json()).success === false) return null;
  } catch {
    // Creating an instance does not post to the chat.
    return null;
  }
  const delivery = await request('POST', '/instances/deliver', {
    outTrackId,
    userIdType: 1,
    ...(isGroup ? {
      openSpaceId: 'dtv1.card//IM_GROUP.' + target,
      imGroupOpenDeliverModel: { robotCode },
    } : {
      openSpaceId: 'dtv1.card//IM_ROBOT.' + target,
      imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode, extension: { dynamicSummary: 'true' } },
    }),
  });
  if ([400, 403, 404].includes(delivery.status)) return null;
  if (!delivery.ok) throw new Error('DingTalk card delivery failed (HTTP ' + delivery.status + ')');
  const receipt = await delivery.json();
  if (receipt.success === false || receipt.result?.some((item) => item.success === false)) return null;
  if (!receipt.result?.some((item) => item.success === true)) {
    throw new Error('DingTalk did not acknowledge card delivery');
  }

  // The AI template renders msgContent through a stream opened after delivery.
  // Apply all updates to the delivered card so failures cannot post a second message.
  const update = async (path, body) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      let response;
      try {
        response = await request('PUT', path, body);
      } catch (error) {
        if (attempt === 2) throw error;
      }
      if (response) {
        const result = await response.json().catch(() => null);
        if (response.ok && result?.success === true) return;
        const code = result?.code ?? 'unacknowledged';
        const retryable = response.status >= 500 || response.status === 429
          || (response.status === 403 && String(code).includes('QpsLimit'));
        if (!retryable || attempt === 2) {
          throw new Error(`DingTalk card update ${path} failed (HTTP ${response.status}, ${code})`);
        }
      }
      await delay(2_000);
    }
  };
  const content = formatCardMarkdown(text, '<br>');
  const setStatus = (flowStatus) => update('/instances', {
    outTrackId,
    cardData: { cardParamMap: {
      flowStatus,
      [CONTENT_KEY]: content,
      staticMsgContent: '',
      sys_full_json_obj: JSON.stringify({ order: [CONTENT_KEY] }),
      config,
    } },
    ...(flowStatus === FlowStatus.Finished && { cardUpdateOptions: { updateCardDataByKey: true } }),
  });
  await setStatus(FlowStatus.Inputting);
  await update('/streaming', {
    outTrackId, guid: randomUUID(), key: CONTENT_KEY, content,
    isFull: true, isFinalize: true, isError: false,
  });
  await setStatus(FlowStatus.Finished);
  return { delivered: true, messageId: outTrackId };
}
