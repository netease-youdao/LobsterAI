import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface UserProfile {
  yid: string;
  nickname: string;
  avatarUrl: string | null;
  phone?: string | null;   // exchange endpoint only, always null currently
  userId?: string;         // exchange endpoint only (string "6")
  id?: number;             // profile endpoint only (number 6)
  status?: number;         // profile endpoint only
}

export interface UserQuota {
  planName: string;           // "免费", "标准", "进阶", "专业"
  subscriptionStatus: string; // "free" | "active"
  creditsLimit: number;       // total credits limit
  creditsUsed: number;        // credits used
  creditsRemaining: number;   // credits remaining
  hasPaidCredits?: boolean;   // true if user has subscription, boost, or invitation credits
}

export interface CreditItem {
  type: 'subscription' | 'boost' | 'free' | 'bonus' | 'invitation';
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
  user: UserProfile | null;
  quota: UserQuota | null;
  profileSummary: ProfileSummary | null;
}

const initialState: AuthState = {
  isLoggedIn: false,
  isLoading: true,
  user: null,
  quota: null,
  profileSummary: null,
};

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    setAuthLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
    setLoggedIn(state, action: PayloadAction<{ user: UserProfile; quota: UserQuota }>) {
      state.isLoggedIn = true;
      state.isLoading = false;
      state.user = action.payload.user;
      state.quota = action.payload.quota;
    },
    setLoggedOut(state) {
      state.isLoggedIn = false;
      state.isLoading = false;
      state.user = null;
      state.quota = null;
      state.profileSummary = null;
    },
    updateQuota(state, action: PayloadAction<UserQuota>) {
      state.quota = action.payload;
    },
    setProfileSummary(state, action: PayloadAction<ProfileSummary>) {
      state.profileSummary = action.payload;
    },
  },
});

export const { setAuthLoading, setLoggedIn, setLoggedOut, updateQuota, setProfileSummary } = authSlice.actions;
export default authSlice.reducer;
