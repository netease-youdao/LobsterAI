import {
  CustomBoostAmount,
  PaymentProduct,
  type PaymentSelectionInput,
  type PaymentTarget,
} from '../../../shared/payment/constants';

const ORDER_NO_PATTERN = /^LB\d{20}$/;
// Same shape the server accepts for replacement request ids.
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const OFFER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export class PaymentInputError extends Error {
  constructor(field: string) {
    super(`Invalid payment input: ${field}`);
    this.name = 'PaymentInputError';
  }
}

const asRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PaymentInputError(field);
  }
  return value as Record<string, unknown>;
};

const isPositiveInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
);

export const isOrderNo = (value: unknown): value is string => (
  typeof value === 'string' && ORDER_NO_PATTERN.test(value)
);

export const isRequestId = (value: unknown): value is string => (
  typeof value === 'string' && REQUEST_ID_PATTERN.test(value)
);

export function parsePaymentTarget(input: unknown): PaymentTarget {
  const target = asRecord(input, 'target');
  if (target.product === PaymentProduct.Subscription) {
    if (!isPositiveInteger(target.planId)) throw new PaymentInputError('planId');
    return { product: PaymentProduct.Subscription, planId: target.planId };
  }
  if (target.product !== PaymentProduct.BoostPack) throw new PaymentInputError('product');
  if (target.boostPackId !== undefined) {
    if (!isPositiveInteger(target.boostPackId) || target.amount !== undefined) {
      throw new PaymentInputError('boostPackId');
    }
    return { product: PaymentProduct.BoostPack, boostPackId: target.boostPackId };
  }
  const { amount } = target;
  if (!isPositiveInteger(amount) || amount < CustomBoostAmount.Min || amount > CustomBoostAmount.Max) {
    throw new PaymentInputError('amount');
  }
  return { product: PaymentProduct.BoostPack, amount };
}

export function parseOrderNo(value: unknown): string {
  if (!isOrderNo(value)) throw new PaymentInputError('orderNo');
  return value;
}

export function parseRequestId(value: unknown): string {
  if (!isRequestId(value)) throw new PaymentInputError('requestId');
  return value;
}

export function parseOfferToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !OFFER_TOKEN_PATTERN.test(value)) {
    throw new PaymentInputError('offerToken');
  }
  return value;
}

export function parseSelectionInput(input: unknown): PaymentSelectionInput {
  const record = asRecord(input, 'input');
  return {
    target: parsePaymentTarget(record.target),
    offerToken: parseOfferToken(record.offerToken),
  };
}

export function parseReplaceInput(input: unknown): {
  oldOrderNo: string;
  target: PaymentTarget;
  offerToken: string;
} {
  const record = asRecord(input, 'input');
  const offerToken = parseOfferToken(record.offerToken);
  if (!offerToken) throw new PaymentInputError('offerToken');
  return {
    oldOrderNo: parseOrderNo(record.oldOrderNo),
    target: parsePaymentTarget(record.target),
    offerToken,
  };
}

export function parseOrderInput(input: unknown): { orderNo: string } {
  return { orderNo: parseOrderNo(asRecord(input, 'input').orderNo) };
}

export function parseRequestInput(input: unknown): { requestId: string } {
  return { requestId: parseRequestId(asRecord(input, 'input').requestId) };
}

/** Body of the server's PaymentSelection. */
export function toServerSelection(target: PaymentTarget): Record<string, unknown> {
  if (target.product === PaymentProduct.Subscription) {
    return { orderType: 'subscription', planId: target.planId };
  }
  return 'boostPackId' in target
    ? { orderType: 'boost_pack', boostPackId: target.boostPackId }
    : { orderType: 'boost_pack', amount: target.amount };
}

/** Identifies one purchasable product, matching the server's offer product keys. */
export function productKey(target: PaymentTarget): string {
  if (target.product === PaymentProduct.Subscription) return `subscription:${target.planId}`;
  return 'boostPackId' in target ? `boost_pack:${target.boostPackId}` : `boost_custom:${target.amount}`;
}
