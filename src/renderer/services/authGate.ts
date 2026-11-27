import {
  AuthAccessPolicy,
  type AuthAccessState,
  AuthGateReason,
  AuthSessionStatus,
} from '@shared/auth/constants';

export const RendererAuthGateMode = {
  Loading: 'loading',
  ForcedLogin: 'forced_login',
  LegacyFirstRun: 'legacy_first_run',
  Open: 'open',
} as const;

export type RendererAuthGateMode =
  typeof RendererAuthGateMode[keyof typeof RendererAuthGateMode];

export interface ResolveRendererAuthGateInput {
  accessState: AuthAccessState | null;
  authIsLoading: boolean;
  authIsLoggedIn: boolean;
  authHasUser: boolean;
  authSessionStatus: AuthSessionStatus;
  enterpriseLoginHidden: boolean;
  privacyAgreed: boolean | null;
  isNewUserOnboardingDismissed: boolean;
  isUpdateInteractionBlocked: boolean;
}

export interface RendererAuthGateResolution {
  isLoginRequired: boolean;
  mode: RendererAuthGateMode;
  reason: AuthGateReason | null;
}

/**
 * Derive the top-level authentication gate mode for the main renderer window.
 *
 * - Legacy installations (`legacy_optional`) and enterprise packages hiding
 *   login (`ui.login === 'hide'`) retain the existing soft first-run gate and
 *   allow guest usage.
 * - Fresh installations (`login_required`) block access whenever the user is
 *   signed out or expired, while keeping offline/transiently-unavailable
 *   sessions with credentials open (`authIsLoggedIn === true`).
 */
export function resolveRendererAuthGateState(
  input: ResolveRendererAuthGateInput,
): RendererAuthGateResolution {
  if (!input.accessState) {
    return {
      isLoginRequired: false,
      mode: RendererAuthGateMode.Loading,
      reason: null,
    };
  }

  const isLoginRequired = (
    input.accessState.policy === AuthAccessPolicy.LoginRequired
    && !input.enterpriseLoginHidden
    && input.accessState.loginRequired
  );

  if (isLoginRequired) {
    if (input.authIsLoading) {
      return {
        isLoginRequired: true,
        mode: RendererAuthGateMode.Loading,
        reason: null,
      };
    }

    // Authenticated and TemporarilyUnavailable(hasCredentials) both set authIsLoggedIn = true.
    if (input.authIsLoggedIn) {
      return {
        isLoginRequired: true,
        mode: RendererAuthGateMode.Open,
        reason: null,
      };
    }

    let reason: AuthGateReason;
    if (
      input.authSessionStatus === AuthSessionStatus.Expired
      || input.accessState.reason === AuthGateReason.SessionExpired
    ) {
      reason = AuthGateReason.SessionExpired;
    } else if (
      input.accessState.reason === AuthGateReason.LoggedOut
      || input.privacyAgreed === true
    ) {
      reason = AuthGateReason.LoggedOut;
    } else {
      reason = AuthGateReason.FirstRun;
    }

    return {
      isLoginRequired: true,
      mode: RendererAuthGateMode.ForcedLogin,
      reason,
    };
  }

  const shouldShowLegacyFirstRun = (
    input.privacyAgreed === false
    && !input.authHasUser
    && !input.isNewUserOnboardingDismissed
    && !input.isUpdateInteractionBlocked
  );

  return {
    isLoginRequired: false,
    mode: shouldShowLegacyFirstRun
      ? RendererAuthGateMode.LegacyFirstRun
      : RendererAuthGateMode.Open,
    reason: shouldShowLegacyFirstRun ? AuthGateReason.FirstRun : null,
  };
}
