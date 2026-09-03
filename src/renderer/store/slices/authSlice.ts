import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import {
  AuthSessionStatus,
  type AuthSessionStatus as AuthSessionStatusValue,
} from '@shared/auth/constants';

export interface UserProfile {
  yid: string;
  nickname: string;
  avatarUrl: string | null;
  phone?: string | null;   // exchange endpoint only, always null currently
  userId?: string;         // exchange endpoint only (string "6")
  id?: number;             // profile endpoint only (number 6)
  status?: number;         // profile endpoint only
  accountMode?: 'personal' | 'enterprise';
}

export interface UserQuota {
  planName: string;           // "免费", "标准", "进阶", "专业"
  subscriptionStatus: string; // "free" | "active" | "enterprise"
  creditsLimit: number;       // total credits limit
  creditsUsed: number;        // credits used
  creditsRemaining: number;   // credits remaining
  hasPaidCredits?: boolean;   // true if user has subscription, boost, or invitation credits
  mediaGenerationEntitled?: boolean; // explicit server-computed media entitlement
  shareEntitled?: boolean;    // explicit server-computed sharing entitlement
  deploymentEntitled?: boolean; // explicit server-computed deployment entitlement
  accountMode?: 'personal' | 'enterprise';
  enterpriseId?: number;
}

export interface LowCreditPurchaseOffer {
  status: 'active' | 'expired' | 'redeemed' | 'ineligible' | 'disabled';
  reason?: string | null;
  offerToken?: string | null;
  offerType?: 'first_purchase' | 'returning_purchase' | null;
  campaignCode?: string | null;
  discountRate?: number | null;
  eligibleProducts?: Array<'subscription' | 'boost_pack'>;
  defaultTab?: 'subscription' | 'boost_pack' | null;
  creditsRemaining?: number | null;
  thresholdCredits?: number | null;
  triggerStage?: 'low_balance' | 'exhausted' | null;
  windowCount?: 1 | 2 | null;
  serverTimeEpochMs: number;
  startsAtEpochMs?: number | null;
  expiresAtEpochMs?: number | null;
  receivedAtEpochMs: number;
}

export interface CreditItem {
  type: 'subscription' | 'boost' | 'free' | 'bonus' | 'invitation' | 'campaign';
  label: string;
  labelEn: string;
  creditsRemaining: number;
  expiresAt: string | null;
}

export interface CreditsResetCampaignStatus {
  enabled: boolean;
  active: boolean;
  registeredEligible: boolean;
  participated: boolean;
  participationType: string | null;
  identity: 'subscription' | 'free';
  availableResetCount: number;
  availablePromoSubscriptionCount: number;
  promoPlanId: number;
  promoAmount: number;
  campaignCode: string;
  startAt: string;
  endAt: string;
  registeredBefore: string;
  reason: string;
  resetEntitlements: CreditsResetEntitlement[];
  availableFreeCreditsRewardCount: number;
  freeCreditsReward: FreeCreditsReward | null;
  freeCreditsRewards?: FreeCreditsReward[];
}

export interface CreditsResetEntitlement {
  campaignCode: string;
  expiresAt: string;
}

export interface FreeCreditsReward {
  campaignCode: string;
  credits: number;
  claimDeadline: string;
  validityDays: number;
  presentation?: CampaignPresentation | null;
}

export interface CampaignPresentation {
  titleZh?: string | null;
  titleEn?: string | null;
  actionTextZh?: string | null;
  actionTextEn?: string | null;
  posterUrl?: string | null;
  iconUrl?: string | null;
}

export interface ProfileSummary {
  id: number;
  nickname: string;
  avatarUrl: string | null;
  totalCreditsRemaining: number;
  creditItems: CreditItem[];
  availableResetCount?: number;
  availablePromoSubscriptionCount?: number;
  creditsResetCampaign?: CreditsResetCampaignStatus;
}

interface AuthState {
  isLoggedIn: boolean;
  isLoading: boolean;
  sessionStatus: AuthSessionStatusValue;
  user: UserProfile | null;
  quota: UserQuota | null;
  purchaseOffer: LowCreditPurchaseOffer | null;
  profileSummary: ProfileSummary | null;
  ownerAccountKey: string | null;
  accountGeneration: number;
}

const initialState: AuthState = {
  isLoggedIn: false,
  isLoading: true,
  sessionStatus: AuthSessionStatus.Unauthenticated,
  user: null,
  quota: null,
  purchaseOffer: null,
  profileSummary: null,
  ownerAccountKey: null,
  accountGeneration: 0,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setAuthLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
    setLoggedIn(state, action: PayloadAction<{
      user: UserProfile;
      quota: UserQuota | null;
      purchaseOffer?: LowCreditPurchaseOffer | null;
      ownerAccountKey: string;
    }>) {
      if (state.ownerAccountKey !== action.payload.ownerAccountKey) {
        state.accountGeneration += 1;
        state.profileSummary = null;
        state.purchaseOffer = null;
      }
      state.isLoggedIn = true;
      state.isLoading = false;
      state.sessionStatus = AuthSessionStatus.Authenticated;
      state.user = action.payload.user;
      state.quota = action.payload.quota;
      if (action.payload.purchaseOffer !== undefined) {
        state.purchaseOffer = action.payload.purchaseOffer;
      }
      state.ownerAccountKey = action.payload.ownerAccountKey;
    },
    setLoggedOut(state) {
      if (state.ownerAccountKey !== null) {
        state.accountGeneration += 1;
      }
      state.isLoggedIn = false;
      state.isLoading = false;
      state.sessionStatus = AuthSessionStatus.Unauthenticated;
      state.user = null;
      state.quota = null;
      state.purchaseOffer = null;
      state.profileSummary = null;
      state.ownerAccountKey = null;
    },
    invalidateAuthAccountContext(state) {
      state.accountGeneration += 1;
      state.quota = null;
      state.purchaseOffer = null;
      state.profileSummary = null;
    },
    setAuthExpired(state) {
      if (state.ownerAccountKey !== null) {
        state.accountGeneration += 1;
      }
      state.isLoggedIn = false;
      state.isLoading = false;
      state.sessionStatus = AuthSessionStatus.Expired;
      state.user = null;
      state.quota = null;
      state.purchaseOffer = null;
      state.profileSummary = null;
      state.ownerAccountKey = null;
    },
    setAuthTemporarilyUnavailable(
      state,
      action: PayloadAction<{
        hasCredentials: boolean;
        cachedUser?: UserProfile | null;
      }>,
    ) {
      state.isLoading = false;
      state.sessionStatus = AuthSessionStatus.TemporarilyUnavailable;
      if (action.payload.hasCredentials) {
        state.isLoggedIn = true;
      }
      if (action.payload.cachedUser) {
        state.user = action.payload.cachedUser;
      }
    },
    updateQuota(state, action: PayloadAction<UserQuota>) {
      state.quota = action.payload;
    },
    updatePurchaseOffer(state, action: PayloadAction<LowCreditPurchaseOffer | null>) {
      state.purchaseOffer = action.payload;
    },
    setProfileSummary(state, action: PayloadAction<ProfileSummary>) {
      state.profileSummary = action.payload;
    },
    clearProfileSummary(state) {
      state.profileSummary = null;
    },
  },
});

export const {
  clearProfileSummary,
  setAuthExpired,
  invalidateAuthAccountContext,
  setAuthLoading,
  setAuthTemporarilyUnavailable,
  setLoggedIn,
  setLoggedOut,
  setProfileSummary,
  updateQuota,
  updatePurchaseOffer,
} = authSlice.actions;
export default authSlice.reducer;
