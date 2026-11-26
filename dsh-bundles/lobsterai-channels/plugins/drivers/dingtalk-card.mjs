import { randomUUID } from 'node:crypto';

import { formatCardMarkdown } from './card-markdown.mjs';

const CARD_API = 'https://api.dingtalk.com/v1.0/card/instances';
const AI_CARD_TEMPLATE = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';

// The DSH channel receives a completed reply. Populate the legacy template in
// its finished state before delivery, so a later update cannot leave a blank card.
export async function sendDingTalkCard({ token, robotCode, target, isGroup, text }) {
  const outTrackId = randomUUID();
  const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  try {
    const created = await post(CARD_API, {
      cardTemplateId: AI_CARD_TEMPLATE,
      outTrackId,
      cardData: { cardParamMap: {
        flowStatus: '3',
        msgContent: formatCardMarkdown(text, '<br>'),
        staticMsgContent: '',
        sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
        config: JSON.stringify({ autoLayout: true }),
      } },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    });
    if (!created.ok || (await created.json()).success === false) return null;
  } catch {
    // Creating an instance does not post to the chat.
    return null;
  }
  const delivery = await post(CARD_API + '/deliver', {
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
  return { delivered: true, messageId: outTrackId };
}
