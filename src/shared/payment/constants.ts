export const PaymentIpc = {
  GetAvailability: 'payment:getAvailability',
  GetCatalog: 'payment:getCatalog',
  Quote: 'payment:quote',
  CreateOrder: 'payment:createOrder',
  ReplaceOrder: 'payment:replaceOrder',
  GetReplacement: 'payment:getReplacement',
  InitAlipayQr: 'payment:initAlipayQr',
  GetOrderStatus: 'payment:getOrderStatus',
} as const;

export const PaymentProduct = {
  Subscription: 'subscription',
  BoostPack: 'boost_pack',
} as const;
export type PaymentProduct = typeof PaymentProduct[keyof typeof PaymentProduct];

export type PaymentTarget =
  | { product: typeof PaymentProduct.Subscription; planId: number }
  | { product: typeof PaymentProduct.BoostPack; boostPackId: number }
  | { product: typeof PaymentProduct.BoostPack; amount: number };

export const PaymentChannel = {
  Wechat: 'wechat',
  Alipay: 'alipay',
} as const;
export type PaymentChannel = typeof PaymentChannel[keyof typeof PaymentChannel];

/** Whole-yuan range the client accepts for a custom boost amount. */
export const CustomBoostAmount = {
  Min: 10,
  Max: 5000,
} as const;

export const PaymentOrderStatus = {
  Pending: 'pending',
  Paid: 'paid',
  Failed: 'failed',
  Refunded: 'refunded',
  Closed: 'closed',
  PaymentReview: 'payment_review',
} as const;
export type PaymentOrderStatus = typeof PaymentOrderStatus[keyof typeof PaymentOrderStatus];

export const PaymentReplacementStatus = {
  Processing: 'processing',
  Completed: 'completed',
  OldOrderPaid: 'old_order_paid',
  OfferUnavailable: 'offer_unavailable',
  OldOrderClosing: 'old_order_closing',
  RetrySelection: 'retry_selection',
} as const;
export type PaymentReplacementStatus =
  typeof PaymentReplacementStatus[keyof typeof PaymentReplacementStatus];

/** Server business codes the client reacts to. */
export const PaymentErrorCode = {
  OfferInvalid: 42300,
  OfferAccountMismatch: 42301,
  OfferUnavailable: 42302,
  OfferProductNotEligible: 42303,
  OfferOrderLocked: 42304,
} as const;

export const PaymentFailureReason = {
  InvalidInput: 'invalid_input',
  Network: 'network',
  InvalidResponse: 'invalid_response',
  Server: 'server',
} as const;
export type PaymentFailureReason = typeof PaymentFailureReason[keyof typeof PaymentFailureReason];

export interface PaymentFailure {
  success: false;
  reason: PaymentFailureReason;
  /** Server business code, or the HTTP status when the body carried none. */
  code?: number;
  /** The order that holds the offer, sent with 42304. */
  currentOrderNo?: string;
}

export type PaymentResult<T> = { success: true; data: T } | PaymentFailure;

export interface PaymentOrderView {
  orderNo: string;
  status: PaymentOrderStatus | null;
  amount: number | null;
  originalAmount: number | null;
  discountRate: number | null;
  baseCredits: number | null;
  bonusCredits: number | null;
  totalCredits: number | null;
  creditsEstimated: boolean;
  orderExpiresAtEpochMs: number | null;
  serverTimeEpochMs: number | null;
  paymentProcessing: boolean;
  /** WeChat Native pay code, or the Portal page that signs a WeChat subscription. */
  wechatQr: string | null;
  alipayQr: string | null;
}

export interface PaymentQuoteView {
  amount: number;
  originalAmount: number;
  discountRate: number;
  baseCredits: number | null;
  bonusCredits: number | null;
  totalCredits: number | null;
  creditsEstimated: boolean;
}

export interface PaymentReplacementView {
  requestId: string;
  oldOrderNo: string;
  status: PaymentReplacementStatus;
  selectionMatches: boolean;
  order: PaymentOrderView | null;
}

export interface PaymentPlanView {
  id: number;
  displayName: string;
  displayNameEn: string | null;
  monthlyPrice: number;
  monthlyCredits: number;
  bonusCredits: number;
  tag: string | null;
  tagEn: string | null;
}

export interface PaymentBoostPackView {
  id: number;
  displayName: string;
  displayNameEn: string | null;
  price: number;
  credits: number;
}

export interface PaymentSubscriptionSummary {
  status: string;
  planId: number | null;
  trialActive: boolean;
}

export interface PaymentCatalog {
  plans: PaymentPlanView[];
  boostPacks: PaymentBoostPackView[];
  /** Null when signed out. */
  subscription: PaymentSubscriptionSummary | null;
}

export interface PaymentAvailability {
  enabled: boolean;
}

export interface PaymentSelectionInput {
  target: PaymentTarget;
  offerToken?: string;
}

export interface PaymentBridge {
  getAvailability: () => Promise<PaymentAvailability>;
  getCatalog: () => Promise<PaymentResult<PaymentCatalog>>;
  quote: (input: PaymentSelectionInput) => Promise<PaymentResult<PaymentQuoteView>>;
  createOrder: (input: PaymentSelectionInput) => Promise<PaymentResult<PaymentOrderView>>;
  replaceOrder: (input: {
    oldOrderNo: string;
    target: PaymentTarget;
    offerToken: string;
  }) => Promise<PaymentResult<PaymentReplacementView>>;
  getReplacement: (input: { requestId: string }) => Promise<PaymentResult<PaymentReplacementView>>;
  initAlipayQr: (input: { orderNo: string }) => Promise<PaymentResult<PaymentOrderView>>;
  getOrderStatus: (input: { orderNo: string }) => Promise<PaymentResult<PaymentOrderView>>;
}
