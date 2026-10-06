import path from 'path';

import { APP_UPDATE_URL_UNTRUSTED_ERROR } from '../../shared/appUpdate/constants';

export const WindowsInstallerUrlPolicyFailure = {
  InvalidUrl: 'invalid-url',
  InsecureProtocol: 'insecure-protocol',
  CredentialsPresent: 'credentials-present',
  FragmentPresent: 'fragment-present',
  UnapprovedPort: 'unapproved-port',
  InvalidExtension: 'invalid-extension',
} as const;

export type WindowsInstallerUrlPolicyFailure =
  typeof WindowsInstallerUrlPolicyFailure[keyof typeof WindowsInstallerUrlPolicyFailure];

export type WindowsInstallerUrlPolicyResult =
  | { trusted: true; url: URL }
  | { trusted: false; reason: WindowsInstallerUrlPolicyFailure };

export const WINDOWS_INSTALLER_URL_POLICY_VERSION = 2 as const;

export interface WindowsInstallerUrlPolicyReceipt {
  policyVersion: typeof WINDOWS_INSTALLER_URL_POLICY_VERSION;
  /**
   * Transport provenance for a request that disallows HTTP redirects.
   * `finalOrigin` is retained for persisted-record compatibility and must equal
   * `inputOrigin`; neither value proves publisher authenticity.
   */
  inputOrigin: string;
  finalOrigin: string;
}

/**
 * Enforce the transport-level policy that is stable across CDN changes.
 * This deliberately does not authenticate the publisher or pin an origin;
 * signed release metadata and Authenticode verification are separate work.
 */
export function validateWindowsInstallerUrl(
  rawUrl: string,
): WindowsInstallerUrlPolicyResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.InvalidUrl };
  }

  if (url.protocol !== 'https:') {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.InsecureProtocol };
  }
  if (url.username || url.password) {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.CredentialsPresent };
  }
  if (url.hash) {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.FragmentPresent };
  }

  // WHATWG URL normalizes an explicit :443 to the default empty port.
  if (url.port) {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.UnapprovedPort };
  }
  if (path.posix.extname(url.pathname).toLowerCase() !== '.exe') {
    return { trusted: false, reason: WindowsInstallerUrlPolicyFailure.InvalidExtension };
  }

  return { trusted: true, url };
}

/** Validate a canonical origin previously emitted by URL.origin. */
export function isSecureWindowsInstallerOrigin(rawOrigin: string): boolean {
  try {
    const url = new URL(rawOrigin);
    return (
      url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && url.pathname === '/'
      && url.origin === rawOrigin
    );
  } catch {
    return false;
  }
}

export class AppUpdateUrlUntrustedError extends Error {
  readonly reason: WindowsInstallerUrlPolicyFailure;

  constructor(reason: WindowsInstallerUrlPolicyFailure) {
    super(APP_UPDATE_URL_UNTRUSTED_ERROR);
    this.name = 'AppUpdateUrlUntrustedError';
    this.reason = reason;
  }
}

export function assertTrustedWindowsInstallerUrl(
  rawUrl: string,
): URL {
  const result = validateWindowsInstallerUrl(rawUrl);
  if ('reason' in result) {
    throw new AppUpdateUrlUntrustedError(result.reason);
  }
  return result.url;
}
