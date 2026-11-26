import type { RemoteOwner } from '../../shared/remote/constants';

/** Interpret the last desktop preference without opening secure storage or starting a worker. */
export function mobileRemoteStartupEnabled(owner: RemoteOwner | null, savedSettings: unknown): boolean {
  if (!owner) return false;
  if (savedSettings === null) return true;
  if (typeof savedSettings !== 'object' || Array.isArray(savedSettings)) return false;
  const { enabled } = savedSettings as { enabled?: unknown };
  return enabled === undefined || enabled === true;
}
