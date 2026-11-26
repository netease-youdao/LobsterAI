import type { MigrationV2Report } from '@shared/migration/constants';
import React, { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { migrationV2Service } from '@/services/migrationV2';

export const MigrationReportModal: React.FC = () => {
  const t = (key: string) => i18nService.t(key);
  const [report, setReport] = useState<MigrationV2Report | null>(null);

  useEffect(() => {
    let active = true;
    void migrationV2Service.getPendingReport().then((pending) => {
      if (active && pending) setReport(pending);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  if (!report) return null;

  const handleDismiss = async () => {
    await migrationV2Service.dismissReport();
    setReport(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl border bg-white p-6 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
        <h2 className="text-lg font-semibold">{t('migrationV2Title')}</h2>
        <p className="mt-1.5 text-xs opacity-75">{t('migrationV2Subtitle')}</p>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <div className="rounded-lg border p-2.5 text-center dark:border-neutral-700">
            <div className="text-lg font-semibold">{report.summary.workspacesMigrated}</div>
            <div className="text-[11px] opacity-70">{t('migrationV2SummaryWorkspaces')}</div>
          </div>
          <div className="rounded-lg border p-2.5 text-center dark:border-neutral-700">
            <div className="text-lg font-semibold">{report.summary.scheduledTasksMigrated}</div>
            <div className="text-[11px] opacity-70">{t('migrationV2SummaryTasks')}</div>
          </div>
          <div className="rounded-lg border p-2.5 text-center dark:border-neutral-700">
            <div className="text-lg font-semibold">
              {(report.summary.sessionsPreSeeded ?? 0) + report.summary.sessionsPreservedForLazyBridge}
            </div>
            <div className="text-[11px] opacity-70">{t('migrationV2SummarySessions')}</div>
          </div>
        </div>

        {report.archivedModules.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-medium opacity-75">{t('migrationV2ArchivedTitle')}</h3>
            <ul className="mt-1.5 space-y-1 rounded-lg border p-2.5 text-xs dark:border-neutral-700">
              {report.archivedModules.map((item, idx) => (
                <li key={`${item.category}-${idx}`} className="flex items-center justify-between gap-2">
                  <span>{item.label}</span>
                  {item.count !== undefined && (
                    <span className="font-mono opacity-60">×{item.count}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {report.reauthRequired.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-medium text-amber-600 dark:text-amber-400">
              {t('migrationV2ReauthTitle')}
            </h3>
            <ul className="mt-1.5 space-y-1 rounded-lg border border-amber-300/60 bg-amber-50/50 p-2.5 text-xs dark:border-amber-800 dark:bg-amber-950/30">
              {report.reauthRequired.map((item) => (
                <li key={`${item.kind}-${item.id}`}>{item.label}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void migrationV2Service.openBackupDir()}
            className="rounded-lg border px-3.5 py-2 text-xs font-medium hover:bg-black/5 dark:border-neutral-700 dark:hover:bg-white/10"
          >
            {t('migrationV2OpenBackupBtn')}
          </button>
          <button
            type="button"
            onClick={() => void handleDismiss()}
            className="rounded-lg bg-action px-4 py-2 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
          >
            {t('migrationV2ConfirmBtn')}
          </button>
        </div>
      </div>
    </div>
  );
};
