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
}

export interface CreditItem {
  type: 'subscription' | 'boost' | 'free';
  label: string;
  labelEn: string;
  creditsRemaining: number;
  expiresAt: string | null;
}

export interface ProfileSummary {
  id: number;
  nickname: string;
  avatarUrl: string | null;
  totalCreditsRemaining: number;
  creditItems: CreditItem[];
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
