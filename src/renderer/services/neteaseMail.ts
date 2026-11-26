import { NeteaseMailFailure } from '../../shared/neteaseMail/constants';
import type { NeteaseMailActionResult, NeteaseMailBridge } from '../../shared/neteaseMail/types';

const unavailable = (): NeteaseMailActionResult => ({ success: false, code: NeteaseMailFailure.Unavailable });

/** Explicit user actions only. Rate limits are returned to the UI, never retried. */
export const neteaseMailService: NeteaseMailBridge = {
  async getAvailability(reference) {
    if (typeof window === 'undefined' || !window.electron?.mcp?.neteaseMail) return { authorization: false, confirmation: false };
    return window.electron.mcp.neteaseMail.getAvailability(reference);
  },
  async authorize(options) {
    try {
      if (typeof window === 'undefined') return unavailable();
      return await window.electron?.mcp?.neteaseMail?.authorize(options) ?? unavailable();
    } catch {
      return unavailable();
    }
  },
  async resolveConfirmation(request) {
    try {
      if (typeof window === 'undefined') return unavailable();
      return await window.electron?.mcp?.neteaseMail?.resolveConfirmation(request) ?? unavailable();
    } catch {
      return unavailable();
    }
  },
  async cancelAuthorization() {
    try { return await window.electron?.mcp?.neteaseMail?.cancelAuthorization?.() ?? unavailable(); }
    catch { return unavailable(); }
  },
  async disconnect() {
    try { return await window.electron?.mcp?.neteaseMail?.disconnect?.() ?? unavailable(); }
    catch { return unavailable(); }
  },
};
