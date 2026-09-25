import {
  type PaymentBridge,
  PaymentChannel,
  PaymentErrorCode,
  PaymentOrderStatus,
  type PaymentOrderView,
  PaymentProduct,
  PaymentReplacementStatus,
  type PaymentTarget,
} from '@shared/payment/constants';

export const PAYMENT_POLL_INTERVAL_MS = 3_000;
/** Orders without expiry fields fall back to the Portal's legacy five-minute window. */
const LEGACY_ORDER_LIFETIME_MS = 5 * 60_000;
const MAX_STATUS_FAILURES = 5;
const MAX_SELECTION_ATTEMPTS = 4;
const MIN_REUSABLE_LIFETIME_MS = 60_000;
// -1 is how the payment controllers answer a request without a signed-in user.
const LOGIN_REQUIRED_CODES: readonly number[] = [-1, 401, 40100, 40101];
const OFFER_REJECTED_CODES: readonly number[] = [
  PaymentErrorCode.OfferInvalid,
  PaymentErrorCode.OfferAccountMismatch,
  PaymentErrorCode.OfferUnavailable,
  PaymentErrorCode.OfferProductNotEligible,
];

export const PaymentPhase = {
  Creating: 'creating',
  Replacing: 'replacing',
  Waiting: 'waiting',
  Processing: 'processing',
  StatusUnavailable: 'status_unavailable',
  Expired: 'expired',
  Paid: 'paid',
  Review: 'review',
  Failed: 'failed',
} as const;
export type PaymentPhase = typeof PaymentPhase[keyof typeof PaymentPhase];

export const PaymentFailureKind = {
  CreateFailed: 'create_failed',
  LoginRequired: 'login_required',
  OfferUnavailable: 'offer_unavailable',
  OldOrderPaid: 'old_order_paid',
  PaymentFailed: 'payment_failed',
  Refunded: 'refunded',
} as const;
export type PaymentFailureKind = typeof PaymentFailureKind[keyof typeof PaymentFailureKind];

export interface PaymentSessionState {
  phase: PaymentPhase;
  order: PaymentOrderView | null;
  channel: PaymentChannel;
  /** Content of the QR code for the selected channel, when one can be shown. */
  qr: string | null;
  /** The Alipay code is being created on demand. */
  channelLoading: boolean;
  remainingSeconds: number;
  failure: PaymentFailureKind | null;
}

export const INITIAL_PAYMENT_SESSION_STATE: PaymentSessionState = {
  phase: PaymentPhase.Creating,
  order: null,
  channel: PaymentChannel.Wechat,
  qr: null,
  channelLoading: false,
  remainingSeconds: 0,
  failure: null,
};

export type PaymentSessionGateway = Pick<
  PaymentBridge,
  'createOrder' | 'replaceOrder' | 'getReplacement' | 'initAlipayQr' | 'getOrderStatus'
>;

export interface PaymentSessionOptions {
  target: PaymentTarget;
  offerToken?: string;
  /** A pending order for the same product from an earlier checkout, reused while still payable. */
  reusableOrder?: PaymentOrderView | null;
  gateway: PaymentSessionGateway;
  onChange: (state: PaymentSessionState) => void;
  onOrderReady?: (order: PaymentOrderView) => void;
  /** A payment settled, including an earlier order found paid during a replacement. */
  onEntitlementsChanged?: () => void;
  /** Monotonic milliseconds; defaults to performance.now(). */
  now?: () => number;
}

const RETRY_SELECTION = Symbol('retry-selection');
const POLLING_PHASES: readonly PaymentPhase[] = [
  PaymentPhase.Waiting,
  PaymentPhase.Processing,
  PaymentPhase.StatusUnavailable,
  PaymentPhase.Expired,
];
const SETTLED_PHASES: readonly PaymentPhase[] = [PaymentPhase.Paid, PaymentPhase.Review, PaymentPhase.Failed];

export const failureKindFor = (code?: number): PaymentFailureKind => {
  if (code !== undefined && LOGIN_REQUIRED_CODES.includes(code)) return PaymentFailureKind.LoginRequired;
  if (code !== undefined && OFFER_REJECTED_CODES.includes(code)) return PaymentFailureKind.OfferUnavailable;
  return PaymentFailureKind.CreateFailed;
};

const orderLifetimeMs = (order: PaymentOrderView): number | null => (
  order.orderExpiresAtEpochMs !== null && order.serverTimeEpochMs !== null
    ? Math.max(0, order.orderExpiresAtEpochMs - order.serverTimeEpochMs)
    : null
);

/** Status responses omit the subscription signing code, so keep the codes issued earlier. */
export const mergeOrder = (previous: PaymentOrderView, next: PaymentOrderView): PaymentOrderView => ({
  ...next,
  wechatQr: next.wechatQr ?? previous.wechatQr,
  alipayQr: next.alipayQr ?? previous.alipayQr,
});

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One checkout: create or reuse the order, show the QR code for the chosen channel, poll every
 * three seconds and settle on paid, review, failure or expiry. Follows the Portal payment modal.
 */
export class PaymentSession {
  private state = INITIAL_PAYMENT_SESSION_STATE;
  private revision = 0;
  private disposed = false;
  private deadline = 0;
  private statusFailures = 0;
  private pollInFlight = false;
  private alipayUnavailableFor: string | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: PaymentSessionOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  getState(): PaymentSessionState {
    return this.state;
  }

  start(): void {
    void this.run(++this.revision, this.options.reusableOrder ?? null);
  }

  /** Creates a fresh order after expiry or failure. */
  regenerate(): void {
    this.stopTimers();
    this.update({ phase: PaymentPhase.Creating, order: null, qr: null, channelLoading: false, failure: null });
    void this.run(++this.revision, null);
  }

  switchChannel(channel: PaymentChannel): void {
    if (this.options.target.product === PaymentProduct.Subscription || channel === this.state.channel) return;
    this.alipayUnavailableFor = null;
    this.update({ channel });
    const { order, phase } = this.state;
    if (order && (phase === PaymentPhase.Waiting || phase === PaymentPhase.StatusUnavailable)) {
      this.presentPending(this.revision, order);
    }
  }

  /** Checks the order at once, for "I have paid" after status checks kept failing. */
  recheck(): void {
    void this.poll(this.revision);
  }

  dispose(): void {
    this.disposed = true;
    this.revision += 1;
    this.stopTimers();
  }

  private isCurrent(revision: number): boolean {
    return !this.disposed && revision === this.revision;
  }

  private update(patch: Partial<PaymentSessionState>): void {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.options.onChange(this.state);
  }

  private async run(revision: number, reusable: PaymentOrderView | null): Promise<void> {
    try {
      let order = reusable ? await this.reuse(reusable) : null;
      if (!this.isCurrent(revision)) return;
      if (!order) order = await this.create(revision);
      if (!order || !this.isCurrent(revision)) return;
      this.options.onOrderReady?.(order);
      this.show(revision, order);
    } catch (error) {
      console.warn('[Payment] checkout could not start:', error instanceof Error ? error.message : error);
      if (this.isCurrent(revision)) this.fail(PaymentFailureKind.CreateFailed);
    }
  }

  private async reuse(order: PaymentOrderView): Promise<PaymentOrderView | null> {
    const result = await this.options.gateway.getOrderStatus({ orderNo: order.orderNo });
    if (!result.success || result.data.status !== PaymentOrderStatus.Pending) return null;
    const latest = mergeOrder(order, result.data);
    return (orderLifetimeMs(latest) ?? 0) > MIN_REUSABLE_LIFETIME_MS ? latest : null;
  }

  private async create(revision: number): Promise<PaymentOrderView | null> {
    const { target, offerToken, gateway } = this.options;
    for (let attempt = 0; attempt < MAX_SELECTION_ATTEMPTS; attempt += 1) {
      if (!this.isCurrent(revision)) return null;
      this.update({ phase: PaymentPhase.Creating });
      const created = await gateway.createOrder({ target, offerToken });
      if (!this.isCurrent(revision)) return null;
      if (created.success) return created.data;
      if (created.code !== PaymentErrorCode.OfferOrderLocked || !created.currentOrderNo || !offerToken) {
        this.fail(failureKindFor(created.code));
        return null;
      }
      const replaced = await this.replace(revision, created.currentOrderNo, offerToken);
      if (replaced !== RETRY_SELECTION) return replaced;
    }
    if (this.isCurrent(revision)) this.fail(PaymentFailureKind.OfferUnavailable);
    return null;
  }

  private async replace(
    revision: number,
    oldOrderNo: string,
    offerToken: string,
  ): Promise<PaymentOrderView | null | typeof RETRY_SELECTION> {
    const { target, gateway } = this.options;
    this.update({ phase: PaymentPhase.Replacing, qr: null });
    let result = await gateway.replaceOrder({ oldOrderNo, target, offerToken });
    let selectionMatches = true;
    while (this.isCurrent(revision)) {
      if (!result.success) {
        this.fail(failureKindFor(result.code));
        return null;
      }
      const replacement = result.data;
      selectionMatches = selectionMatches && replacement.selectionMatches;
      switch (replacement.status) {
        case PaymentReplacementStatus.Processing:
          await delay(PAYMENT_POLL_INTERVAL_MS);
          if (!this.isCurrent(revision)) return null;
          result = await gateway.getReplacement({ requestId: replacement.requestId });
          continue;
        case PaymentReplacementStatus.OldOrderClosing:
          if (!await this.waitForClosure(revision, replacement.oldOrderNo)) return null;
          result = await gateway.replaceOrder({ oldOrderNo, target, offerToken });
          continue;
        case PaymentReplacementStatus.RetrySelection:
          return RETRY_SELECTION;
        case PaymentReplacementStatus.OldOrderPaid:
          this.settleOldOrderPaid();
          return null;
        case PaymentReplacementStatus.OfferUnavailable:
          this.fail(PaymentFailureKind.OfferUnavailable);
          return null;
        default: {
          // Completed: continue only with an order for this selection that can still be paid.
          const order = replacement.order;
          if (!order) {
            this.fail(PaymentFailureKind.CreateFailed);
            return null;
          }
          const usable = order.status === PaymentOrderStatus.Pending || order.status === PaymentOrderStatus.Paid;
          return selectionMatches && usable ? order : RETRY_SELECTION;
        }
      }
    }
    return null;
  }

  /** True once the order holding the offer is closed; false when it was paid or the wait ended. */
  private async waitForClosure(revision: number, orderNo: string): Promise<boolean> {
    let failures = 0;
    while (this.isCurrent(revision)) {
      const result = await this.options.gateway.getOrderStatus({ orderNo });
      if (!this.isCurrent(revision)) return false;
      if (result.success) {
        failures = 0;
        const { status, paymentProcessing } = result.data;
        if (status === PaymentOrderStatus.Paid) {
          this.settleOldOrderPaid();
          return false;
        }
        if (status === PaymentOrderStatus.Failed
          || ((status === PaymentOrderStatus.Closed || status === PaymentOrderStatus.Refunded)
            && !paymentProcessing)) return true;
      } else if (++failures >= MAX_STATUS_FAILURES) {
        this.fail(PaymentFailureKind.CreateFailed);
        return false;
      }
      await delay(PAYMENT_POLL_INTERVAL_MS);
    }
    return false;
  }

  private settleOldOrderPaid(): void {
    this.fail(PaymentFailureKind.OldOrderPaid);
    this.options.onEntitlementsChanged?.();
  }

  private show(revision: number, order: PaymentOrderView): void {
    this.statusFailures = 0;
    this.alipayUnavailableFor = null;
    this.deadline = this.now() + (orderLifetimeMs(order) ?? LEGACY_ORDER_LIFETIME_MS);
    this.update({ order, failure: null });
    this.apply(revision, order);
    if (POLLING_PHASES.includes(this.state.phase)) this.startTimers(revision);
  }

  private apply(revision: number, update: PaymentOrderView): void {
    if (SETTLED_PHASES.includes(this.state.phase)) return;
    const order = this.state.order ? mergeOrder(this.state.order, update) : update;
    const lifetime = orderLifetimeMs(order);
    if (lifetime !== null) this.deadline = this.now() + lifetime;
    switch (order.status) {
      case PaymentOrderStatus.Paid:
        this.stopTimers();
        this.update({ phase: PaymentPhase.Paid, order, qr: null, channelLoading: false });
        this.options.onEntitlementsChanged?.();
        return;
      case PaymentOrderStatus.PaymentReview:
        this.stopTimers();
        this.update({ phase: PaymentPhase.Review, order, qr: null, channelLoading: false });
        return;
      case PaymentOrderStatus.Failed:
      case PaymentOrderStatus.Closed:
      case PaymentOrderStatus.Refunded:
        this.stopTimers();
        this.update({
          phase: PaymentPhase.Failed,
          order,
          qr: null,
          channelLoading: false,
          failure: order.status === PaymentOrderStatus.Refunded
            ? PaymentFailureKind.Refunded
            : PaymentFailureKind.PaymentFailed,
        });
        return;
      default:
        this.presentPending(revision, order);
    }
  }

  private presentPending(revision: number, order: PaymentOrderView): void {
    const remainingSeconds = this.secondsLeft();
    if (order.paymentProcessing) {
      this.update({ phase: PaymentPhase.Processing, order, qr: null, remainingSeconds });
      return;
    }
    if (remainingSeconds <= 0) {
      this.update({ phase: PaymentPhase.Expired, order, qr: null, remainingSeconds: 0 });
      return;
    }
    if (this.statusFailures >= MAX_STATUS_FAILURES) {
      this.update({ phase: PaymentPhase.StatusUnavailable, order, qr: null, remainingSeconds });
      return;
    }
    const alipay = this.state.channel === PaymentChannel.Alipay;
    const qr = alipay ? order.alipayQr : order.wechatQr;
    this.update({
      phase: PaymentPhase.Waiting,
      order,
      qr: alipay && this.state.channelLoading ? null : qr,
      remainingSeconds,
    });
    if (alipay && !qr && !this.state.channelLoading && this.alipayUnavailableFor !== order.orderNo) {
      void this.loadAlipayQr(revision, order.orderNo);
    }
  }

  private async loadAlipayQr(revision: number, orderNo: string): Promise<void> {
    const { gateway } = this.options;
    this.update({ channelLoading: true, qr: null });
    try {
      let result = await gateway.initAlipayQr({ orderNo });
      if (!result.success && this.isCurrent(revision)) result = await gateway.getOrderStatus({ orderNo });
      if (!this.isCurrent(revision) || this.state.order?.orderNo !== orderNo) return;
      if (!result.success || !result.data.alipayQr) this.alipayUnavailableFor = orderNo;
      this.update({ channelLoading: false });
      if (result.success) this.apply(revision, result.data);
    } catch {
      if (!this.isCurrent(revision)) return;
      this.alipayUnavailableFor = orderNo;
      this.update({ channelLoading: false });
    }
  }

  private startTimers(revision: number): void {
    this.stopTimers();
    this.tickTimer = setInterval(() => this.tick(), 1_000);
    this.schedulePoll(revision);
  }

  private schedulePoll(revision: number): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll(revision).finally(() => {
        if (this.isCurrent(revision) && POLLING_PHASES.includes(this.state.phase)) this.schedulePoll(revision);
      });
    }, PAYMENT_POLL_INTERVAL_MS);
  }

  private async poll(revision: number): Promise<void> {
    const orderNo = this.state.order?.orderNo;
    if (!orderNo || this.pollInFlight || !POLLING_PHASES.includes(this.state.phase)) return;
    this.pollInFlight = true;
    try {
      const result = await this.options.gateway.getOrderStatus({ orderNo });
      if (!this.isCurrent(revision) || this.state.order?.orderNo !== orderNo) return;
      if (result.success) {
        this.statusFailures = 0;
        this.apply(revision, result.data);
      } else {
        this.noteStatusFailure();
      }
    } catch {
      if (this.isCurrent(revision)) this.noteStatusFailure();
    } finally {
      this.pollInFlight = false;
    }
  }

  private noteStatusFailure(): void {
    this.statusFailures += 1;
    const { phase } = this.state;
    if (this.statusFailures >= MAX_STATUS_FAILURES
      && (phase === PaymentPhase.Waiting || phase === PaymentPhase.Processing)) {
      this.update({ phase: PaymentPhase.StatusUnavailable, qr: null });
    }
  }

  private tick(): void {
    const remainingSeconds = this.secondsLeft();
    const { phase } = this.state;
    if (remainingSeconds <= 0 && (phase === PaymentPhase.Waiting || phase === PaymentPhase.StatusUnavailable)) {
      this.update({ phase: PaymentPhase.Expired, qr: null, remainingSeconds: 0 });
    } else if (remainingSeconds !== this.state.remainingSeconds) {
      this.update({ remainingSeconds });
    }
  }

  private secondsLeft(): number {
    return Math.max(0, Math.ceil((this.deadline - this.now()) / 1000));
  }

  private stopTimers(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.pollTimer = null;
    this.tickTimer = null;
  }

  private fail(failure: PaymentFailureKind): void {
    this.stopTimers();
    this.update({ phase: PaymentPhase.Failed, qr: null, channelLoading: false, failure });
  }
}
