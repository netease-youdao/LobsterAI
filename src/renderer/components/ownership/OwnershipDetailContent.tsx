import { OwnershipSyncState, OwnershipTargetKind } from '@shared/ownership/constants';
import type { OwnershipDetail, OwnershipDisplay } from '@shared/ownership/types';
import React from 'react';

import { i18nService } from '../../services/i18n';

function ownerLabel(owner: OwnershipDisplay): string {
  if (owner.kind === 'anonymous') return i18nService.t('ownershipAnonymous');
  if (owner.kind === 'default') return i18nService.t('ownershipDefault');
  return [owner.label || i18nService.t('ownershipCurrentAccount'), owner.scopeLabel].filter(Boolean).join(' · ');
}
export function ownershipSyncLabel(state: string): string { return i18nService.t(`ownershipSync_${state}`); }

const OwnershipDetailContent: React.FC<{ detail: OwnershipDetail; compact?: boolean }> = ({ detail, compact }) => {
  if (compact && detail.kind === OwnershipTargetKind.Task) {
    const t = (key: string) => i18nService.t(key);
    const anonymous = detail.ownership.kind === 'anonymous';
    const account = [t('ownershipCurrentAccount'), detail.ownership.scopeLabel].filter(Boolean).join(' · ');
    const source = [detail.agent?.name, detail.deviceName || t('remoteThisComputer')].filter(Boolean).join(' · ');
    const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';
    const updatedAt = detail.updatedAt !== undefined ? new Date(detail.updatedAt) : null;
    const updatedLabel = updatedAt ? t('ownershipUpdatedSummary').replace('{time}', updatedAt.toLocaleString(locale, {
      ...(updatedAt.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    })) : null;
    const syncClassName = detail.syncState === OwnershipSyncState.Failed ? 'text-red-600 dark:text-red-400'
      : detail.syncState === OwnershipSyncState.Pending || detail.syncState === OwnershipSyncState.WaitingService
        ? 'text-amber-600 dark:text-amber-400' : 'text-secondary';
    const statusClassName = detail.status === 'error' ? 'text-red-600 dark:text-red-400'
      : detail.status === 'waiting_approval' ? 'text-amber-600 dark:text-amber-400'
        : detail.status === 'running' ? 'text-primary' : 'text-secondary';
    return <div className="space-y-3">
      <h3 className="line-clamp-2 break-words text-sm font-medium text-foreground" title={detail.title}>{detail.title}</h3>
      <div className="space-y-1.5 text-xs leading-5 text-secondary">
        <p className="break-words" title={anonymous ? undefined : `${ownerLabel(detail.ownership)} · ${ownershipSyncLabel(detail.syncState)}`}>
          {anonymous ? t('ownershipAnonymousSummary') : <>{account} · <span className={syncClassName}>{t(`ownershipCompactSync_${detail.syncState}`)}</span></>}
        </p>
        <p className="break-words" title={source}>{source}</p>
        {(detail.status || updatedLabel) && <p className="break-words">
          {detail.status && <span className={statusClassName}>{t(`ownershipStatus_${detail.status}`)}</span>}
          {detail.status && updatedLabel && ' · '}
          {updatedLabel && <span title={updatedAt!.toLocaleString(locale)}>{updatedLabel}</span>}
        </p>}
      </div>
    </div>;
  }
  const rows = [
    [i18nService.t(detail.kind === OwnershipTargetKind.Task ? 'ownershipTaskOwner' : 'ownershipAgentOwner'), ownerLabel(detail.ownership)],
    ...(detail.agent ? [
      [i18nService.t('ownershipAgent'), detail.agent.name],
    ] : []),
    [i18nService.t('ownershipComputer'), detail.deviceName || i18nService.t('remoteThisComputer')],
    ...(detail.visibleTaskCount !== undefined ? [[i18nService.t('ownershipVisibleTasks'), String(detail.visibleTaskCount)]] : []),
    ...(detail.latestTaskTitle ? [[i18nService.t('ownershipLatestTask'), detail.latestTaskTitle]] : []),
    ...(detail.status ? [[i18nService.t('ownershipTaskStatus'), i18nService.t(`ownershipStatus_${detail.status}`)]] : []),
    ...(detail.updatedAt ? [[i18nService.t('ownershipUpdatedAt'), new Date(detail.updatedAt).toLocaleString()]] : []),
    [i18nService.t('ownershipMobileSync'), ownershipSyncLabel(detail.syncState)],
    ...(detail.ownership.associatedAt ? [[i18nService.t('ownershipAssociatedAt'), new Date(detail.ownership.associatedAt).toLocaleString()]] : []),
  ];
  return <div className="space-y-3">
    <h3 className={`break-words font-medium text-foreground ${compact ? 'line-clamp-2 text-sm' : 'text-base'}`}>{detail.title}</h3>
    {detail.description && <p className="line-clamp-2 break-words text-xs text-secondary">{detail.description}</p>}
    <dl className="space-y-2 text-xs">
      {rows.map(([label, value]) => <div className="flex gap-3" key={label}>
        <dt className="w-20 shrink-0 text-secondary">{label}</dt>
        <dd className="min-w-0 break-words text-foreground">{value}</dd>
      </div>)}
    </dl>
  </div>;
};
export default OwnershipDetailContent;
