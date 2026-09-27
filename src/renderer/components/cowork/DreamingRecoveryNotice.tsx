import { useState } from 'react';

import type { OpenClawDreamingRecoverySummary } from '../../../shared/openclawEngine/dreamingRecovery';
import { i18nService } from '../../services/i18n';

export default function DreamingRecoveryNotice({ summary }: { summary: OpenClawDreamingRecoverySummary }) {
  const [error, setError] = useState<string | null>(null);
  const revealBackup = async () => {
    setError(null);
    try {
      const result = await window.electron.shell.showItemInFolder(summary.manifestPath);
      if (!result?.success) setError(result?.error || i18nService.t('showInFolderFailed'));
    } catch (revealError) {
      setError(revealError instanceof Error ? revealError.message : i18nService.t('showInFolderFailed'));
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface p-4 text-sm" aria-label={i18nService.t('openClawDreamingRecoveryTitle')}>
      <h4 className="font-medium text-foreground">{i18nService.t('openClawDreamingRecoveryTitle')}</h4>
      <p className="mt-2 text-secondary">
        {i18nService.t('openClawDreamingRecoverySummary')
          .replace('{workspaces}', String(summary.affectedWorkspaceCount))
          .replace('{files}', String(summary.quarantinedFileCount))}
      </p>
      {summary.quarantinedFileCount > 0 && (
        <p className="mt-1 text-secondary">{i18nService.t('openClawDreamingRecoveryImpact')}</p>
      )}
      {summary.pendingFileCount > 0 && (
        <p className="mt-1 text-secondary">
          {i18nService.t('openClawDreamingRecoveryPending').replace('{files}', String(summary.pendingFileCount))}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-secondary">
          {summary.recordedAt && !Number.isNaN(Date.parse(summary.recordedAt))
            ? new Date(summary.recordedAt).toLocaleString() : ''}
        </span>
        <button type="button" onClick={() => { void revealBackup(); }}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
        >
          {i18nService.t('openClawDreamingRecoveryBackup')}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-error">{error}</p>}
    </section>
  );
}
