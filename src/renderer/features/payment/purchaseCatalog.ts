import {
  CustomBoostAmount,
  type PaymentBoostPackView,
  PaymentProduct,
  type PaymentSubscriptionSummary,
  type PaymentTarget,
} from '@shared/payment/constants';

import { getPurchaseOfferDiscountRate, isPurchaseOfferActive } from '../../services/lowCreditPurchaseOffer';
import type { LowCreditPurchaseOffer } from '../../store/slices/authSlice';

/** Preset boost amounts, the same as on the Portal pricing page. */
export const BOOST_PRESET_AMOUNTS: readonly number[] = [10, 20, 50, 100, 200];
const CREDITS_PER_YUAN = 100;

export interface BoostOption {
  amount: number;
  credits: number;
  target: PaymentTarget;
}

/** A listed pack is bought by id so its own credits apply; other amounts are custom purchases. */
export function boostOptionFor(amount: number, packs: readonly PaymentBoostPackView[]): BoostOption {
  const pack = packs.find(item => item.price === amount);
  return pack
    ? { amount, credits: pack.credits, target: { product: PaymentProduct.BoostPack, boostPackId: pack.id } }
    : { amount, credits: amount * CREDITS_PER_YUAN, target: { product: PaymentProduct.BoostPack, amount } };
}

export function parseCustomBoostAmount(input: string): number | null {
  if (!/^\d{1,4}$/.test(input)) return null;
  const amount = Number(input);
  return amount >= CustomBoostAmount.Min && amount <= CustomBoostAmount.Max ? amount : null;
}

export const SubscriptionCheckout = {
  InApp: 'in_app',
  Portal: 'portal',
} as const;
export type SubscriptionCheckout = typeof SubscriptionCheckout[keyof typeof SubscriptionCheckout];

/** Plan changes and trial upgrades stay on the Portal; only new subscriptions are bought here. */
export function subscriptionCheckoutFor(summary: PaymentSubscriptionSummary | null): SubscriptionCheckout {
  return summary && (summary.trialActive || summary.status === 'active')
    ? SubscriptionCheckout.Portal
    : SubscriptionCheckout.InApp;
}

/** Sends the offer token only for products the offer still discounts. */
export function offerTokenFor(
  offer: LowCreditPurchaseOffer | null | undefined,
  requestedToken: string | undefined,
  product: PaymentProduct,
  now = Date.now(),
): string | undefined {
  if (!requestedToken || !offer || offer.offerToken !== requestedToken || !isPurchaseOfferActive(offer, now)) {
    return undefined;
  }
  return getPurchaseOfferDiscountRate(offer, product) === null ? undefined : requestedToken;
}

export function productKeyOf(target: PaymentTarget): string {
  if (target.product === PaymentProduct.Subscription) return `subscription:${target.planId}`;
  return 'boostPackId' in target ? `boost_pack:${target.boostPackId}` : `boost_custom:${target.amount}`;
}

const yuanFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const creditsFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export const formatYuan = (value: number): string => `¥${yuanFormat.format(value)}`;
export const formatCredits = (value: number): string => creditsFormat.format(value);
