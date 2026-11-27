import type {
  CleanupActionMode,
  CleanupCapabilityKind,
  CleanupDependencyKind,
} from './constants';

export interface ContextCleanupDependency {
  kind: CleanupDependencyKind;
  label?: string;
}

export interface ContextCleanupCandidate {
  kind: CleanupCapabilityKind;
  id: string;
  name: string;
  description: string;
  estimatedTokens: number;
  estimatedTokensUnknown?: boolean;
  lastUsedAt: number | null;
  idleDays: number | null;
  enabledDays: number;
  dependencies: ContextCleanupDependency[];
  defaultSelected: boolean;
  actionMode: CleanupActionMode;
}

export interface ContextCleanupScanResult {
  scannedAt: number;
  idleDaysThreshold: number;
  gracePeriodDays: number;
  promptSavingsThresholdTokens: number;
  candidates: ContextCleanupCandidate[];
  totalSavableTokens: number;
  recommendedSavableTokens: number;
  shouldPromptInPopover: boolean;
  shouldShowBanner: boolean;
  dismissedAt: number | null;
}

export interface ContextCleanupTargetItem {
  kind: CleanupCapabilityKind;
  id: string;
}

export interface ContextCleanupApplyResult {
  success: boolean;
  closedCount: number;
  savedTokens: number;
  undoToken: string | null;
  failedItems: Array<{ kind: CleanupCapabilityKind; id: string; reason: string }>;
  error?: string;
}

export interface ContextCleanupUndoResult {
  success: boolean;
  restoredCount: number;
  error?: string;
}

export interface ContextCleanupDismissResult {
  success: boolean;
  dismissedAt: number;
}
