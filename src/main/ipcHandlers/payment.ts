import crypto from 'crypto';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';

import {
  type PaymentAvailability,
  type PaymentCatalog,
  type PaymentFailure,
  PaymentFailureReason,
  PaymentIpc,
  PaymentProduct,
  PaymentReplacementStatus,
  type PaymentResult,
  type PaymentSubscriptionSummary,
} from '../../shared/payment/constants';
import {
  isOrderNo,
  parseOrderInput,
  parseReplaceInput,
  parseRequestInput,
  parseSelectionInput,
  PaymentInputError,
  productKey,
  toServerSelection,
} from '../libs/payment/paymentRequest';
import {
  sanitizeBoostPacks,
  sanitizeOrder,
  sanitizePlans,
  sanitizeQuote,
  sanitizeReplacement,
  sanitizeSubscription,
} from '../libs/payment/paymentResponse';

export interface PaymentIpcHandlerDeps {
  ipcMain: IpcMain;
  getMainWindow: () => BrowserWindow | null;
  getServerBaseUrl: () => string;
  getAvailabilityUrl: () => string;
  /** Scopes cached replacement requests to the signed-in account. */
  getAccountKey: () => string | null;
  hasAuthTokens: () => boolean;
  fetchPublic: (url: string, init?: RequestInit) => Promise<Response>;
  fetchWithAuth: (url: string, init?: RequestInit) => Promise<Response>;
  randomUUID?: () => string;
  now?: () => number;
}

const REQUEST_TIMEOUT_MS = 15_000;
const AVAILABILITY_TIMEOUT_MS = 3_000;
const AVAILABILITY_CACHE_MS = 5 * 60_000;
const SETTLED_REPLACEMENT_STATUSES: readonly string[] = [
  PaymentReplacementStatus.Completed,
  PaymentReplacementStatus.RetrySelection,
  PaymentReplacementStatus.OldOrderPaid,
  PaymentReplacementStatus.OfferUnavailable,
];

type ServerCall = { ok: true; data: unknown } | { ok: false; failure: PaymentFailure };

interface ServerRequest {
  method: 'GET' | 'POST';
  body?: unknown;
  /** The public catalog is read without credentials. */
  anonymous?: boolean;
}

const invalidResponse = (operation: string): PaymentFailure => {
  console.warn(`[Payment] ${operation} returned an unexpected response`);
  return { success: false, reason: PaymentFailureReason.InvalidResponse };
};

const isBusinessRejection = (failure: PaymentFailure): boolean => (
  failure.reason === PaymentFailureReason.Server
  && typeof failure.code === 'number' && failure.code >= 4000 && failure.code < 50000
);

/**
 * The renderer only chooses products and shows QR codes. Requests to the server are rebuilt here
 * from validated input, and responses are narrowed to the fields the checkout needs.
 */
export function registerPaymentIpcHandlers(deps: PaymentIpcHandlerDeps): void {
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const now = deps.now ?? Date.now;
  let availability: { value: PaymentAvailability; expiresAt: number } | null = null;
  // One replacement request per account, offer and product, reused until the server settles it.
  const replacements = new Map<string, { requestId: string; oldOrderNo: string }>();

  const requireMainRenderer = (event: IpcMainInvokeEvent): void => {
    const window = deps.getMainWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted payment sender');
  };

  const call = async (operation: string, path: string, request: ServerRequest): Promise<ServerCall> => {
    const fetcher = request.anonymous ? deps.fetchPublic : deps.fetchWithAuth;
    try {
      const response = await fetcher(`${deps.getServerBaseUrl()}${path}`, {
        method: request.method,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json = await response.json().catch((): null => null) as { code?: unknown; data?: unknown } | null;
      if (response.ok && json?.code === 0) return { ok: true, data: json.data };
      const code = typeof json?.code === 'number' ? json.code : response.status;
      const currentOrderNo = (json?.data as { currentOrderNo?: unknown } | null | undefined)?.currentOrderNo;
      console.warn(`[Payment] ${operation} rejected: http=${response.status} code=${code}`);
      return {
        ok: false,
        failure: {
          success: false,
          reason: PaymentFailureReason.Server,
          code,
          ...(isOrderNo(currentOrderNo) ? { currentOrderNo } : {}),
        },
      };
    } catch (error) {
      console.warn(`[Payment] ${operation} failed: ${error instanceof Error ? error.name : 'unknown'}`);
      return { ok: false, failure: { success: false, reason: PaymentFailureReason.Network } };
    }
  };

  const handle = (channel: string, run: (input: unknown) => Promise<unknown>): void => {
    deps.ipcMain.handle(channel, async (event, input: unknown) => {
      requireMainRenderer(event);
      try {
        return await run(input);
      } catch (error) {
        if (!(error instanceof PaymentInputError)) throw error;
        console.warn(`[Payment] ${channel} ignored: ${error.message}`);
        const failure: PaymentFailure = { success: false, reason: PaymentFailureReason.InvalidInput };
        return failure;
      }
    });
  };

  const forgetReplacement = (requestId: string): void => {
    for (const [key, operation] of replacements) {
      if (operation.requestId === requestId) replacements.delete(key);
    }
  };

  handle(PaymentIpc.GetAvailability, async (): Promise<PaymentAvailability> => {
    if (availability && availability.expiresAt > now()) return availability.value;
    let enabled = true;
    try {
      const response = await deps.fetchPublic(deps.getAvailabilityUrl(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
      if (response.ok) {
        const value = ((await response.json()) as { data?: { value?: unknown } } | null)?.data?.value;
        enabled = !(value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'off'));
      }
    } catch (error) {
      // The switch exists to turn the feature off; an unreachable switch keeps it on.
      console.warn(`[Payment] in-app payment switch unavailable: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    availability = { value: { enabled }, expiresAt: now() + AVAILABILITY_CACHE_MS };
    return availability.value;
  });

  handle(PaymentIpc.GetCatalog, async (): Promise<PaymentResult<PaymentCatalog>> => {
    const [plans, boostPacks, subscription] = await Promise.all([
      call('catalog.plans', '/api/plans', { method: 'GET', anonymous: true }),
      call('catalog.boostPacks', '/api/boost-packs', { method: 'GET', anonymous: true }),
      deps.hasAuthTokens() ? call('catalog.subscription', '/api/subscription', { method: 'GET' }) : null,
    ]);
    // Compared explicitly: the main-process build does not narrow unions on truthiness.
    if (plans.ok === false) return plans.failure;
    if (boostPacks.ok === false) return boostPacks.failure;
    let summary: PaymentSubscriptionSummary | null = null;
    if (subscription) {
      if (subscription.ok === false) return subscription.failure;
      summary = sanitizeSubscription(subscription.data);
      if (!summary) return invalidResponse('catalog');
    }
    const planViews = sanitizePlans(plans.data);
    const packViews = sanitizeBoostPacks(boostPacks.data);
    if (!planViews || !packViews) return invalidResponse('catalog');
    return { success: true, data: { plans: planViews, boostPacks: packViews, subscription: summary } };
  });

  handle(PaymentIpc.Quote, async (input) => {
    const { target, offerToken } = parseSelectionInput(input);
    const result = await call('quote', '/api/payment/quote', {
      method: 'POST',
      body: { target: toServerSelection(target), offerToken },
    });
    if (result.ok === false) return result.failure;
    const quote = sanitizeQuote(result.data);
    return quote ? { success: true, data: quote } : invalidResponse('quote');
  });

  handle(PaymentIpc.CreateOrder, async (input) => {
    const { target, offerToken } = parseSelectionInput(input);
    const result = target.product === PaymentProduct.Subscription
      // Subscriptions are signed through WeChat only.
      ? await call('createOrder', '/api/subscription/create', {
        method: 'POST',
        body: { planId: target.planId, paymentChannel: 'wechat', offerToken },
      })
      : await call('createOrder', '/api/boost-packs/purchase', {
        method: 'POST',
        body: {
          ...('boostPackId' in target ? { boostPackId: target.boostPackId } : { amount: target.amount }),
          paymentChannel: 'dual',
          offerToken,
        },
      });
    if (result.ok === false) return result.failure;
    const order = sanitizeOrder(result.data);
    if (!order) return invalidResponse('createOrder');
    console.log(`[Payment] order ready: orderNo=${order.orderNo}`);
    return { success: true, data: order };
  });

  handle(PaymentIpc.ReplaceOrder, async (input) => {
    const { oldOrderNo, target, offerToken } = parseReplaceInput(input);
    const key = [deps.getAccountKey() ?? '', offerToken, productKey(target)].join('|');
    const operation = replacements.get(key) ?? { requestId: randomUUID(), oldOrderNo };
    replacements.set(key, operation);
    const result = await call('replaceOrder', `/api/payment/orders/${operation.oldOrderNo}/replace`, {
      method: 'POST',
      body: { requestId: operation.requestId, target: toServerSelection(target), offerToken },
    });
    if (result.ok === false) {
      // A rejected selection was never accepted; the next attempt starts a new request.
      if (isBusinessRejection(result.failure)) replacements.delete(key);
      return result.failure;
    }
    const replacement = sanitizeReplacement(result.data, operation.oldOrderNo);
    if (!replacement) return invalidResponse('replaceOrder');
    if (SETTLED_REPLACEMENT_STATUSES.includes(replacement.status)) replacements.delete(key);
    return { success: true, data: replacement };
  });

  handle(PaymentIpc.GetReplacement, async (input) => {
    const { requestId } = parseRequestInput(input);
    const result = await call('getReplacement', `/api/payment/order-replacements/${requestId}`, { method: 'GET' });
    if (result.ok === false) return result.failure;
    const replacement = sanitizeReplacement(result.data);
    if (!replacement || replacement.requestId !== requestId) return invalidResponse('getReplacement');
    if (SETTLED_REPLACEMENT_STATUSES.includes(replacement.status)) forgetReplacement(requestId);
    return { success: true, data: replacement };
  });

  handle(PaymentIpc.InitAlipayQr, async (input) => {
    const { orderNo } = parseOrderInput(input);
    const result = await call('initAlipayQr', `/api/payment/orders/${orderNo}/alipay-qr`, {
      method: 'POST',
      body: {},
    });
    if (result.ok === false) return result.failure;
    const order = sanitizeOrder(result.data, orderNo);
    return order ? { success: true, data: order } : invalidResponse('initAlipayQr');
  });

  handle(PaymentIpc.GetOrderStatus, async (input) => {
    const { orderNo } = parseOrderInput(input);
    const result = await call('getOrderStatus', `/api/payment/orders/${orderNo}/status`, { method: 'GET' });
    if (result.ok === false) return result.failure;
    const order = sanitizeOrder(result.data, orderNo);
    return order ? { success: true, data: order } : invalidResponse('getOrderStatus');
  });
}
