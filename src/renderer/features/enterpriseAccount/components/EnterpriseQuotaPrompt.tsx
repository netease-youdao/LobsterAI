import {
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import {
  EnterpriseMemberRole,
  EnterpriseQuotaReason,
  EnterpriseQuotaRequestType,
} from '../../../../shared/enterpriseAccount/constants';
import { authService } from '../../../services/auth';
import {
  getEnterpriseRechargeUrl,
  getEnterpriseUsageUrl,
} from '../../../services/endpoints';
import { i18nService } from '../../../services/i18n';
import { logEnterpriseAccountDiagnostic } from '../diagnostics';
import type { EnterpriseQuotaSignal } from '../quotaPromptState';
import { selectEnterpriseAccountContext } from '../selectors';

interface EnterpriseQuotaPromptProps {
  signal?: EnterpriseQuotaSignal | null;
  reason?: EnterpriseQuotaReason | null;
  surface: 'home' | 'task';
}

type RequestState = 'idle' | 'submitting' | 'submitted';

export const EnterpriseQuotaPrompt = ({
  signal = null,
  reason = null,
  surface,
}: EnterpriseQuotaPromptProps) => {
  const context = useSelector(selectEnterpriseAccountContext);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [isCheckingQuota, setIsCheckingQuota] = useState(false);
  const quotaCheckInFlightRef = useRef(false);
  const autoCheckedSignalKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const quotaReason = signal?.reason ?? reason;
  const enterpriseId = context?.enterpriseId;
  const enterpriseIdRef = useRef(enterpriseId);
  enterpriseIdRef.current = enterpriseId;
  const signalMessageId = signal?.messageId;

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  useEffect(() => {
    setRequestState('idle');
  }, [context?.enterpriseId, quotaReason]);

  const checkQuota = useCallback(async (showResultToast: boolean) => {
    if (quotaCheckInFlightRef.current) return;
    quotaCheckInFlightRef.current = true;
    setIsCheckingQuota(true);
    logEnterpriseAccountDiagnostic(
      'debug',
      `${showResultToast ? 'manual' : 'automatic'} quota check started`,
    );
    try {
      const result = await authService.checkQuota();
      logEnterpriseAccountDiagnostic(
        'debug',
        `quota check completed (success: ${result.success}, available: ${result.enterpriseQuotaAvailable})`,
      );
      if (mountedRef.current && showResultToast) {
        const toastKey = !result.success
          ? 'enterpriseQuotaCheckFailed'
          : result.enterpriseQuotaAvailable
            ? 'enterpriseQuotaCheckRestored'
            : 'enterpriseQuotaCheckUnavailable';
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t(toastKey),
        }));
      }
    } catch (error) {
      logEnterpriseAccountDiagnostic('warn', 'quota check failed unexpectedly', error);
      if (mountedRef.current && showResultToast) {
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('enterpriseQuotaCheckFailed'),
        }));
      }
    } finally {
      quotaCheckInFlightRef.current = false;
      if (mountedRef.current) {
        setIsCheckingQuota(false);
      }
    }
  }, []);

  useEffect(() => {
    if (enterpriseId === undefined || !signalMessageId) {
      autoCheckedSignalKeyRef.current = null;
      return;
    }
    const signalKey = `${enterpriseId}:${signalMessageId}`;
    if (autoCheckedSignalKeyRef.current === signalKey) return;
    autoCheckedSignalKeyRef.current = signalKey;
    void checkQuota(false);
  }, [checkQuota, enterpriseId, signalMessageId]);

  const presentation = useMemo(() => {
    if (!context || !quotaReason) return null;
    const isSuperAdmin = context.role === EnterpriseMemberRole.SuperAdmin;
    const poolBlocked = quotaReason === EnterpriseQuotaReason.EnterprisePoolExhausted
      || quotaReason === EnterpriseQuotaReason.EnterpriseCreditBatchesExpired;
    if (poolBlocked) {
      const creditBatchesExpired = quotaReason
        === EnterpriseQuotaReason.EnterpriseCreditBatchesExpired;
      return {
        title: i18nService.t(
          creditBatchesExpired ? 'enterpriseQuotaExpiredTitle' : 'enterpriseQuotaPoolTitle',
        ),
        description: i18nService.t(
          creditBatchesExpired
            ? isSuperAdmin
              ? 'enterpriseQuotaExpiredAdminDesc'
              : 'enterpriseQuotaExpiredMemberDesc'
            : isSuperAdmin
              ? 'enterpriseQuotaPoolAdminDesc'
              : 'enterpriseQuotaPoolMemberDesc',
        ),
        interrupt: i18nService.t('enterpriseQuotaPoolInterrupt'),
        button: i18nService.t(
          isSuperAdmin ? 'enterpriseQuotaPurchaseCredits' : 'enterpriseQuotaNotifyAdmin',
        ),
        requestType: EnterpriseQuotaRequestType.EnterprisePool,
        portalUrl: isSuperAdmin && context.permissions.rechargeEnterprise
          ? getEnterpriseRechargeUrl(context.enterpriseId)
          : null,
      };
    }
    return {
      title: i18nService.t('enterpriseQuotaMemberTitle'),
      description: i18nService.t(
        isSuperAdmin ? 'enterpriseQuotaMemberAdminDesc' : 'enterpriseQuotaMemberMemberDesc',
      ),
      interrupt: i18nService.t(
        isSuperAdmin ? 'enterpriseQuotaMemberAdminInterrupt' : 'enterpriseQuotaMemberInterrupt',
      ),
      button: i18nService.t(
        isSuperAdmin ? 'enterpriseAccountAdjustQuota' : 'enterpriseQuotaRequestIncrease',
      ),
      requestType: EnterpriseQuotaRequestType.MemberQuota,
      portalUrl: isSuperAdmin && context.permissions.adjustMemberQuota
        ? `${getEnterpriseUsageUrl(context.enterpriseId)}?memberId=${context.memberId}`
        : null,
    };
  }, [context, quotaReason]);

  if (!context || !quotaReason || !presentation) {
    return null;
  }

  const isSuperAdmin = context.role === EnterpriseMemberRole.SuperAdmin;

  const handleAction = async () => {
    const actionEnterpriseId = context.enterpriseId;
    if (presentation.portalUrl) {
      logEnterpriseAccountDiagnostic('debug', `opening quota action for ${quotaReason}`);
      try {
        await window.electron.shell.openExternal(presentation.portalUrl);
      } catch (error) {
        logEnterpriseAccountDiagnostic('warn', 'quota portal action failed', error);
      }
      return;
    }
    if (isSuperAdmin || requestState !== 'idle') return;

    setRequestState('submitting');
    logEnterpriseAccountDiagnostic(
      'debug',
      `submitting ${presentation.requestType} request for enterprise ${context.enterpriseId}`,
    );
    try {
      const result = await window.electron.enterpriseAccount.requestQuotaIncrease(
        actionEnterpriseId,
        presentation.requestType,
      );
      if (!mountedRef.current || enterpriseIdRef.current !== actionEnterpriseId) {
        logEnterpriseAccountDiagnostic('debug', 'discarded quota request response after account changed');
        return;
      }
      if (!result.success) {
        logEnterpriseAccountDiagnostic('warn', 'quota request returned an error', result.error);
        setRequestState('idle');
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('enterpriseQuotaRequestFailed'),
        }));
        return;
      }
      logEnterpriseAccountDiagnostic(
        'debug',
        `quota request accepted (request ${result.requestId ?? 'unknown'}, created ${result.created === true})`,
      );
      setRequestState('submitted');
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: result.created
          ? i18nService.t('enterpriseQuotaRequestSubmitted')
          : i18nService.t('enterpriseQuotaRequestAlreadyPending'),
      }));
    } catch (error) {
      logEnterpriseAccountDiagnostic('warn', 'quota request IPC failed', error);
      if (!mountedRef.current || enterpriseIdRef.current !== actionEnterpriseId) return;
      setRequestState('idle');
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('enterpriseQuotaRequestFailed'),
      }));
    }
  };

  const actionLabel = requestState === 'submitted'
    ? i18nService.t('enterpriseQuotaRequestSubmittedButton')
    : requestState === 'submitting'
      ? i18nService.t('enterpriseQuotaRequestSubmitting')
      : presentation.button;

  return (
    <div className={surface === 'task' ? 'mb-3' : 'mt-4'} role="alert" aria-live="assertive">
      {surface === 'task' ? (
        <div className="mb-3 flex items-center gap-3 px-1 text-xs text-secondary">
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
          <span className="flex items-center gap-1.5">
            <ExclamationCircleIcon className="h-4 w-4" aria-hidden="true" />
            {presentation.interrupt}
          </span>
          <span className="h-px flex-1 bg-border" aria-hidden="true" />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 shadow-subtle">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-raised text-foreground">
          <ExclamationCircleIcon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="text-sm font-semibold text-foreground">{presentation.title}</div>
          <div className="mt-0.5 text-xs leading-5 text-secondary">{presentation.description}</div>
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void checkQuota(true)}
            disabled={isCheckingQuota}
            className="inline-flex max-w-full shrink-0 items-center justify-center whitespace-normal rounded-full border border-border bg-background px-3.5 py-2 text-center text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:cursor-default disabled:opacity-60"
          >
            {i18nService.t(isCheckingQuota
              ? 'enterpriseQuotaChecking'
              : 'enterpriseQuotaCheckAction')}
          </button>
          <button
            type="button"
            onClick={() => void handleAction()}
            disabled={requestState !== 'idle'}
            className="inline-flex max-w-full shrink-0 items-center justify-center gap-1.5 whitespace-normal rounded-full bg-neutral-950 px-3.5 py-2 text-center text-xs font-medium text-white transition-opacity hover:opacity-80 disabled:cursor-default disabled:opacity-60 dark:bg-white dark:text-neutral-950"
          >
            {requestState === 'submitted' ? (
              <CheckCircleIcon className="h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
            {actionLabel}
            {presentation.portalUrl && requestState === 'idle' ? (
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
          </button>
        </div>
      </div>
    </div>
  );
};
