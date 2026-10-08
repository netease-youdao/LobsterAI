export interface PublishingRecoveryFooterActionsInput {
  showRecovery: boolean;
  canCopy: boolean;
  showCopyInStandardFooter: boolean;
}

export interface PublishingRecoveryFooterActions {
  showStandardActions: boolean;
  showCopy: boolean;
  isCopyDisabled: boolean;
  showRecovery: boolean;
}

export function getPublishingRecoveryFooterActions({
  showRecovery,
  canCopy,
  showCopyInStandardFooter,
}: PublishingRecoveryFooterActionsInput): PublishingRecoveryFooterActions {
  return {
    showStandardActions: !showRecovery,
    showCopy: showRecovery || showCopyInStandardFooter,
    isCopyDisabled: !canCopy,
    showRecovery,
  };
}
