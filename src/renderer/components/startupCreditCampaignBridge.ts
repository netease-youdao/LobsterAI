import { useSyncExternalStore } from 'react';

import {
  StartupCreditCampaignSource,
  type StartupCreditCampaignSource as StartupCreditCampaignSourceType,
} from './startupCreditCampaignAnalytics';

export const STARTUP_CREDIT_OPEN_EVENT = 'lobster:startup-credit-campaign-open';

export interface StartupCreditCampaignEntry {
  resolved: boolean;
  available: boolean;
  label: string;
}

type StartupCreditCampaignEntryUpdate = Omit<
  StartupCreditCampaignEntry,
  'resolved'
>;

const unresolvedEntry: StartupCreditCampaignEntry = {
  resolved: false,
  available: false,
  label: '',
};

const unavailableEntry: StartupCreditCampaignEntry = {
  resolved: true,
  available: false,
  label: '',
};

let entrySnapshot = unresolvedEntry;
const listeners = new Set<() => void>();

export function setStartupCreditCampaignEntry(
  entry: StartupCreditCampaignEntryUpdate | null,
): void {
  const next = entry
    ? { ...entry, resolved: true }
    : unavailableEntry;
  if (entrySnapshot.resolved === next.resolved
      && entrySnapshot.available === next.available
      && entrySnapshot.label === next.label) {
    return;
  }
  entrySnapshot = next;
  listeners.forEach(listener => listener());
}

export function resetStartupCreditCampaignEntry(): void {
  if (!entrySnapshot.resolved) return;
  entrySnapshot = unresolvedEntry;
  listeners.forEach(listener => listener());
}

export function openStartupCreditCampaign(
  source: StartupCreditCampaignSourceType = StartupCreditCampaignSource.HomeNewConversation,
): void {
  window.dispatchEvent(new CustomEvent(STARTUP_CREDIT_OPEN_EVENT, {
    detail: { source },
  }));
}

export function useStartupCreditCampaignEntry(): StartupCreditCampaignEntry {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => entrySnapshot,
    () => unresolvedEntry,
  );
}
