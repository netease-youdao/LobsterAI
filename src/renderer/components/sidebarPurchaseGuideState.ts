import { isPurchaseOfferActive } from '../services/lowCreditPurchaseOffer';
import type { LowCreditPurchaseOffer } from '../store/slices/authSlice';

export const SidebarPurchaseGuideVariant = {
  First: 'first',
  Returning: 'returning',
  Normal: 'normal',
} as const;
export type SidebarPurchaseGuideVariant = typeof SidebarPurchaseGuideVariant[keyof typeof SidebarPurchaseGuideVariant];

const NormalGuideStage = {
  Low: 'low',
  Exhausted: 'exhausted',
} as const;
type NormalGuideStage = typeof NormalGuideStage[keyof typeof NormalGuideStage];

const NORMAL_GUIDE_THRESHOLD = 500;

export interface SidebarPurchaseGuideDismissState {
  round: number;
  recoveredAbove500: boolean;
  dismissedNormalStages: NormalGuideStage[];
  dismissedOfferWindows: string[];
}

export interface SidebarPurchaseGuideCandidate {
  key: string;
  offer: LowCreditPurchaseOffer;
  variant: SidebarPurchaseGuideVariant;
}

export const getSidebarPurchaseGuideStorageKey = (ownerAccountKey: string): string => (
  `sidebar_purchase_guide.v1.${ownerAccountKey}`
);

export const normalizeSidebarPurchaseGuideDismissState = (
  value: Partial<SidebarPurchaseGuideDismissState> | null,
): SidebarPurchaseGuideDismissState => ({
  round: Number.isSafeInteger(value?.round) && (value?.round ?? 0) > 0 ? value!.round! : 1,
  recoveredAbove500: value?.recoveredAbove500 === true,
  dismissedNormalStages: Array.isArray(value?.dismissedNormalStages)
    ? value.dismissedNormalStages.filter(stage => Object.values(NormalGuideStage).includes(stage))
    : [],
  dismissedOfferWindows: Array.isArray(value?.dismissedOfferWindows)
    ? value.dismissedOfferWindows.filter(key => typeof key === 'string')
    : [],
});

const readBalance = (offer: LowCreditPurchaseOffer | null): number | null => (
  typeof offer?.creditsRemaining === 'number' && Number.isFinite(offer.creditsRemaining)
    ? Math.max(0, offer.creditsRemaining)
    : null
);

export const observeSidebarPurchaseGuideBalance = (
  state: SidebarPurchaseGuideDismissState,
  offer: LowCreditPurchaseOffer | null,
): SidebarPurchaseGuideDismissState => {
  const balance = readBalance(offer);
  if (balance === null) return state;
  if (balance > NORMAL_GUIDE_THRESHOLD) {
    return state.recoveredAbove500 ? state : { ...state, recoveredAbove500: true };
  }
  return state.recoveredAbove500
    ? { ...state, round: state.round + 1, recoveredAbove500: false, dismissedNormalStages: [] }
    : state;
};

const getNormalStage = (balance: number): NormalGuideStage => (
  balance === 0 ? NormalGuideStage.Exhausted : NormalGuideStage.Low
);

export const getSidebarPurchaseGuideCandidate = (
  offer: LowCreditPurchaseOffer | null,
  state: SidebarPurchaseGuideDismissState,
  now = Date.now(),
): SidebarPurchaseGuideCandidate | null => {
  const balance = readBalance(offer);
  if (!offer || balance === null) return null;
  if (isPurchaseOfferActive(offer, now)) {
    if (typeof offer.thresholdCredits !== 'number' || balance > offer.thresholdCredits) return null;
    const key = `offer:${offer.campaignCode ?? ''}:${offer.offerToken}:${offer.windowCount ?? 1}`;
    if (state.dismissedOfferWindows.includes(key)) return null;
    return {
      key,
      offer,
      variant: offer.offerType === 'first_purchase'
        ? SidebarPurchaseGuideVariant.First
        : SidebarPurchaseGuideVariant.Returning,
    };
  }
  if (offer.hasEverPaidPersonalOrder !== true || balance > NORMAL_GUIDE_THRESHOLD) return null;
  const stage = getNormalStage(balance);
  if (state.dismissedNormalStages.includes(stage)) return null;
  return {
    key: `normal:${state.round}:${stage}`,
    offer,
    variant: SidebarPurchaseGuideVariant.Normal,
  };
};

export const dismissSidebarPurchaseGuide = (
  state: SidebarPurchaseGuideDismissState,
  candidate: SidebarPurchaseGuideCandidate,
): SidebarPurchaseGuideDismissState => ({
  ...state,
  dismissedNormalStages: Array.from(new Set([
    ...state.dismissedNormalStages,
    getNormalStage(readBalance(candidate.offer) ?? 0),
  ])),
  dismissedOfferWindows: candidate.variant === SidebarPurchaseGuideVariant.Normal
    ? state.dismissedOfferWindows
    : Array.from(new Set([...state.dismissedOfferWindows, candidate.key])),
});
