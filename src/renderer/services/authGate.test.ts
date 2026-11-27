import {
  AuthAccessPolicy,
  AuthGateReason,
  AuthSessionStatus,
} from '@shared/auth/constants';
import { describe, expect, test } from 'vitest';

import {
  RendererAuthGateMode,
  resolveRendererAuthGateState,
} from './authGate';

describe('resolveRendererAuthGateState', () => {
  test('stays in loading state until accessState is loaded', () => {
    expect(resolveRendererAuthGateState({
      accessState: null,
      authIsLoading: false,
      authIsLoggedIn: false,
      authHasUser: false,
      authSessionStatus: AuthSessionStatus.Unauthenticated,
      enterpriseLoginHidden: false,
      privacyAgreed: false,
      isNewUserOnboardingDismissed: false,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: false,
      mode: RendererAuthGateMode.Loading,
      reason: null,
    });
  });

  test('waits in loading state while auth hydration is pending for login_required users', () => {
    expect(resolveRendererAuthGateState({
      accessState: {
        policy: AuthAccessPolicy.LoginRequired,
        loginRequired: true,
        blocked: false,
        reason: null,
      },
      authIsLoading: true,
      authIsLoggedIn: false,
      authHasUser: false,
      authSessionStatus: AuthSessionStatus.Unauthenticated,
      enterpriseLoginHidden: false,
      privacyAgreed: true,
      isNewUserOnboardingDismissed: false,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: true,
      mode: RendererAuthGateMode.Loading,
      reason: null,
    });
  });

  test('blocks unauthenticated login_required users on first run, logout, and session expiry', () => {
    expect(resolveRendererAuthGateState({
      accessState: {
        policy: AuthAccessPolicy.LoginRequired,
        loginRequired: true,
        blocked: true,
        reason: AuthGateReason.FirstRun,
      },
      authIsLoading: false,
      authIsLoggedIn: false,
      authHasUser: false,
      authSessionStatus: AuthSessionStatus.Unauthenticated,
      enterpriseLoginHidden: false,
      privacyAgreed: false,
      isNewUserOnboardingDismissed: false,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: true,
      mode: RendererAuthGateMode.ForcedLogin,
      reason: AuthGateReason.FirstRun,
    });

    expect(resolveRendererAuthGateState({
      accessState: {
        policy: AuthAccessPolicy.LoginRequired,
        loginRequired: true,
        blocked: true,
        reason: AuthGateReason.LoggedOut,
      },
      authIsLoading: false,
      authIsLoggedIn: false,
      authHasUser: false,
      authSessionStatus: AuthSessionStatus.Unauthenticated,
      enterpriseLoginHidden: false,
      privacyAgreed: true,
      isNewUserOnboardingDismissed: true,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: true,
      mode: RendererAuthGateMode.ForcedLogin,
      reason: AuthGateReason.LoggedOut,
    });

    expect(resolveRendererAuthGateState({
      accessState: {
        policy: AuthAccessPolicy.LoginRequired,
        loginRequired: true,
        blocked: true,
        reason: AuthGateReason.SessionExpired,
      },
      authIsLoading: false,
      authIsLoggedIn: false,
      authHasUser: false,
      authSessionStatus: AuthSessionStatus.Expired,
      enterpriseLoginHidden: false,
      privacyAgreed: true,
      isNewUserOnboardingDismissed: true,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: true,
      mode: RendererAuthGateMode.ForcedLogin,
      reason: AuthGateReason.SessionExpired,
    });
  });

  test('never locks out login_required users during offline TemporarilyUnavailable with credentials', () => {
    expect(resolveRendererAuthGateState({
      accessState: {
        policy: AuthAccessPolicy.LoginRequired,
        loginRequired: true,
        blocked: false,
        reason: null,
      },
      authIsLoading: false,
      authIsLoggedIn: true,
      authHasUser: true,
      authSessionStatus: AuthSessionStatus.TemporarilyUnavailable,
      enterpriseLoginHidden: false,
      privacyAgreed: true,
      isNewUserOnboardingDismissed: true,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: true,
      mode: RendererAuthGateMode.Open,
      reason: null,
    });
  });

  test('exempts enterprise packages that hide login', () => {
    expect(resolveRendererAuthGateState({
      accessState: {
        policy: AuthAccessPolicy.LoginRequired,
        loginRequired: false,
        blocked: false,
        reason: null,
      },
      authIsLoading: false,
      authIsLoggedIn: false,
      authHasUser: false,
      authSessionStatus: AuthSessionStatus.Unauthenticated,
      enterpriseLoginHidden: true,
      privacyAgreed: true,
      isNewUserOnboardingDismissed: false,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: false,
      mode: RendererAuthGateMode.Open,
      reason: null,
    });
  });

  test('preserves legacy_optional behavior for existing installations', () => {
    expect(resolveRendererAuthGateState({
      accessState: {
        policy: AuthAccessPolicy.LegacyOptional,
        loginRequired: false,
        blocked: false,
        reason: null,
      },
      authIsLoading: false,
      authIsLoggedIn: false,
      authHasUser: false,
      authSessionStatus: AuthSessionStatus.Unauthenticated,
      enterpriseLoginHidden: false,
      privacyAgreed: true,
      isNewUserOnboardingDismissed: false,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: false,
      mode: RendererAuthGateMode.Open,
      reason: null,
    });

    expect(resolveRendererAuthGateState({
      accessState: {
        policy: AuthAccessPolicy.LegacyOptional,
        loginRequired: false,
        blocked: false,
        reason: null,
      },
      authIsLoading: false,
      authIsLoggedIn: false,
      authHasUser: false,
      authSessionStatus: AuthSessionStatus.Unauthenticated,
      enterpriseLoginHidden: false,
      privacyAgreed: false,
      isNewUserOnboardingDismissed: false,
      isUpdateInteractionBlocked: false,
    })).toEqual({
      isLoginRequired: false,
      mode: RendererAuthGateMode.LegacyFirstRun,
      reason: AuthGateReason.FirstRun,
    });
  });
});
