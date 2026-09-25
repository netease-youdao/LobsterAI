import {
  type PaymentBoostPackView,
  PaymentOrderStatus,
  type PaymentOrderView,
  type PaymentPlanView,
  type PaymentQuoteView,
  PaymentReplacementStatus,
  type PaymentReplacementView,
  type PaymentSubscriptionSummary,
} from '../../../shared/payment/constants';
import { PortalLoginOrigin } from '../embeddedLogin/loginUrlPolicy';
import { isOrderNo, isRequestId } from './paymentRequest';

const MAX_QR_LENGTH = 2048;
const WECHAT_NATIVE_PATTERN = /^weixin:\/\/wxpay\/bizpayurl\?[\x21-\x7e]{1,1024}$/;
const PORTAL_ORIGINS: readonly string[] = Object.values(PortalLoginOrigin);
const ORDER_STATUSES: readonly string[] = Object.values(PaymentOrderStatus);
const REPLACEMENT_STATUSES: readonly string[] = Object.values(PaymentReplacementStatus);

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null
);

const finiteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const positiveInteger = (value: unknown): number | null => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
);

const shortText = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() && value.length <= 64 ? value.trim() : null
);

const parseHttpsUrl = (value: unknown): URL | null => {
  if (typeof value !== 'string' || value.length > MAX_QR_LENGTH || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
};

/**
 * A WeChat Native pay code, or the Portal page that signs a WeChat subscription for this exact
 * order. Anything else is dropped, and the checkout shows the channel as unavailable.
 */
export function validWechatQr(value: unknown, orderNo: string): string | null {
  if (typeof value === 'string' && WECHAT_NATIVE_PATTERN.test(value)) return value;
  const url = parseHttpsUrl(value);
  if (!url || !PORTAL_ORIGINS.includes(url.origin) || url.pathname !== '/portal' || url.hash) return null;
  return url.searchParams.get('wechatSign') === '1' && url.searchParams.get('orderNo') === orderNo
    ? value as string
    : null;
}

export function validAlipayQr(value: unknown): string | null {
  const url = parseHttpsUrl(value);
  return url && url.hostname === 'qr.alipay.com' ? value as string : null;
}

export function sanitizeOrder(raw: unknown, expectedOrderNo?: string): PaymentOrderView | null {
  const data = asRecord(raw);
  if (!data || !isOrderNo(data.orderNo)) return null;
  const orderNo = data.orderNo;
  if (expectedOrderNo !== undefined && orderNo !== expectedOrderNo) return null;
  return {
    orderNo,
    status: typeof data.status === 'string' && ORDER_STATUSES.includes(data.status)
      ? data.status as PaymentOrderStatus
      : null,
    amount: finiteNumber(data.amount),
    originalAmount: finiteNumber(data.originalAmount),
    discountRate: finiteNumber(data.discountRate),
    baseCredits: finiteNumber(data.baseCredits),
    bonusCredits: finiteNumber(data.bonusCredits),
    totalCredits: finiteNumber(data.totalCredits),
    creditsEstimated: data.creditsEstimated === true,
    orderExpiresAtEpochMs: finiteNumber(data.orderExpiresAtEpochMs),
    serverTimeEpochMs: finiteNumber(data.serverTimeEpochMs),
    paymentProcessing: data.paymentProcessing === true,
    wechatQr: validWechatQr(data.wechatQrUrl, orderNo),
    alipayQr: validAlipayQr(data.alipayQrUrl),
  };
}

export function sanitizeQuote(raw: unknown): PaymentQuoteView | null {
  const data = asRecord(raw);
  const amount = finiteNumber(data?.amount);
  const originalAmount = finiteNumber(data?.originalAmount);
  const discountRate = finiteNumber(data?.discountRate);
  if (!data || amount === null || originalAmount === null || discountRate === null) return null;
  return {
    amount,
    originalAmount,
    discountRate,
    baseCredits: finiteNumber(data.baseCredits),
    bonusCredits: finiteNumber(data.bonusCredits),
    totalCredits: finiteNumber(data.totalCredits),
    creditsEstimated: data.creditsEstimated === true,
  };
}

export function sanitizeReplacement(
  raw: unknown,
  expectedOldOrderNo?: string,
): PaymentReplacementView | null {
  const data = asRecord(raw);
  if (!data || !isRequestId(data.requestId) || !isOrderNo(data.oldOrderNo)) return null;
  if (expectedOldOrderNo !== undefined && data.oldOrderNo !== expectedOldOrderNo) return null;
  if (typeof data.status !== 'string' || !REPLACEMENT_STATUSES.includes(data.status)) return null;
  const order = data.order === undefined || data.order === null ? null : sanitizeOrder(data.order);
  if (data.order && !order) return null;
  return {
    requestId: data.requestId,
    oldOrderNo: data.oldOrderNo,
    status: data.status as PaymentReplacementStatus,
    selectionMatches: data.selectionMatches !== false,
    order,
  };
}

export function sanitizePlans(raw: unknown): PaymentPlanView[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((item): PaymentPlanView[] => {
    const plan = asRecord(item);
    const id = positiveInteger(plan?.id);
    const monthlyPrice = finiteNumber(plan?.monthlyPrice);
    const monthlyCredits = finiteNumber(plan?.monthlyCredits);
    const displayName = shortText(plan?.displayName);
    // The free plan is listed too; only paid plans can be bought.
    if (!plan || id === null || monthlyPrice === null || monthlyPrice <= 0
      || monthlyCredits === null || !displayName) return [];
    return [{
      id,
      displayName,
      displayNameEn: shortText(plan.displayNameEn),
      monthlyPrice,
      monthlyCredits,
      bonusCredits: finiteNumber(plan.bonusCredits) ?? 0,
      tag: shortText(plan.tag),
      tagEn: shortText(plan.tagEn),
    }];
  });
}

export function sanitizeBoostPacks(raw: unknown): PaymentBoostPackView[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((item): PaymentBoostPackView[] => {
    const pack = asRecord(item);
    const id = positiveInteger(pack?.id);
    const price = finiteNumber(pack?.price);
    const credits = finiteNumber(pack?.credits);
    const displayName = shortText(pack?.displayName);
    if (!pack || id === null || price === null || price <= 0 || credits === null || !displayName) return [];
    return [{ id, displayName, displayNameEn: shortText(pack.displayNameEn), price, credits }];
  });
}

export function sanitizeSubscription(raw: unknown): PaymentSubscriptionSummary | null {
  const data = asRecord(raw);
  const status = shortText(data?.subscriptionStatus);
  if (!data || !status) return null;
  return {
    status,
    planId: positiveInteger(data.planId),
    trialActive: asRecord(data.trial)?.active === true,
  };
}
