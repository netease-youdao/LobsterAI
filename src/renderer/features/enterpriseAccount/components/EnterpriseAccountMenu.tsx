import {
  ArrowRightStartOnRectangleIcon,
  BuildingOffice2Icon,
  ChartBarIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import {
  type FocusEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';

import { EnterpriseMemberRole } from '../../../../shared/enterpriseAccount/constants';
import type {
  EnterpriseAccountContext,
  EnterpriseAccountIdentity,
} from '../../../../shared/enterpriseAccount/types';
import { getAccountMenuDisplayName } from '../../../components/accountMenuState';
import { authService } from '../../../services/auth';
import {
  getEnterpriseMemberProfileUrl,
  getEnterpriseOverviewUrl,
} from '../../../services/endpoints';
import { i18nService } from '../../../services/i18n';
import type { RootState } from '../../../store';
import { resolveEnterpriseAdminIdentities } from '../administrativeIdentities';
import { logEnterpriseAccountDiagnostic } from '../diagnostics';
import { resolveEnterpriseMenuFlyoutPosition } from '../enterpriseMenuPosition';

interface EnterpriseAccountMenuProps {
  context: EnterpriseAccountContext;
  onClose: () => void;
}

interface MenuActionProps {
  icon: ReactNode;
  label: string;
  onClick: () => void | Promise<void>;
}

const MenuAction = ({ icon, label, onClick }: MenuActionProps) => (
  <button
    type="button"
    onClick={() => void onClick()}
    className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-raised"
  >
    {icon}
    <span>{label}</span>
  </button>
);

const actionIconClassName = 'h-4 w-4 shrink-0 text-secondary';
const enterpriseFlyoutCloseDelayMs = 120;

const formatCredits = (credits: number): string => (
  Number.isInteger(credits) ? String(credits) : credits.toFixed(2)
);

export const EnterpriseAccountMenu = ({
  context,
  onClose,
}: EnterpriseAccountMenuProps) => {
  const user = useSelector((state: RootState) => state.auth.user);
  const isSuperAdmin = context.role === EnterpriseMemberRole.SuperAdmin;
  const accountName = getAccountMenuDisplayName({
    fallback: context.enterpriseName,
    userNickname: user?.nickname,
    userPhone: user?.phone,
  });
  const [identities, setIdentities] = useState<EnterpriseAccountIdentity[]>([]);
  const [showEnterpriseFlyout, setShowEnterpriseFlyout] = useState(false);
  const [enterpriseFlyoutPosition, setEnterpriseFlyoutPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const enterpriseManagementButtonRef = useRef<HTMLButtonElement>(null);
  const enterpriseFlyoutRef = useRef<HTMLDivElement>(null);
  const enterpriseFlyoutCloseTimerRef = useRef<number | null>(null);
  const enterpriseFlyoutPositionFrameRef = useRef<number | null>(null);
  const enterpriseIdentityScope = [
    user?.id,
    user?.userId,
    user?.yid,
    context.enterpriseId,
    context.enterpriseName,
    context.permissions.manageEnterprise,
    context.role,
  ].join('|');
  const previousEnterpriseIdentityScopeRef = useRef(enterpriseIdentityScope);
  const adminIdentities = useMemo(
    () => resolveEnterpriseAdminIdentities(context, identities),
    [context, identities],
  );

  useLayoutEffect(() => {
    if (previousEnterpriseIdentityScopeRef.current === enterpriseIdentityScope) return;
    previousEnterpriseIdentityScopeRef.current = enterpriseIdentityScope;
    setIdentities([]);
  }, [enterpriseIdentityScope]);

  useEffect(() => {
    let active = true;
    const contextSnapshot = {
      enterpriseId: context.enterpriseId,
      enterpriseName: context.enterpriseName,
      permissions: {
        manageEnterprise: context.permissions.manageEnterprise,
      },
      role: context.role,
    } as const;
    logEnterpriseAccountDiagnostic(
      'debug',
      `requesting enterprise identities for account menu (enterprise=${context.enterpriseId}, role=${context.role})`,
    );
    void window.electron.enterpriseAccount.getIdentities().then(result => {
      if (!active) return;
      if (result.success) {
        const administratorCount = resolveEnterpriseAdminIdentities(
          contextSnapshot,
          result.identities,
        ).length;
        logEnterpriseAccountDiagnostic(
          'debug',
          `loaded enterprise identities for account menu (total=${result.identities.length}, administrators=${administratorCount})`,
        );
        setIdentities(result.identities);
      } else {
        logEnterpriseAccountDiagnostic(
          'warn',
          'enterprise identity list request returned an error',
          result.error,
        );
      }
    }).catch(error => {
      logEnterpriseAccountDiagnostic('warn', 'enterprise identity list request failed', error);
    });
    return () => {
      active = false;
    };
  }, [
    context.enterpriseId,
    context.enterpriseName,
    context.permissions.manageEnterprise,
    context.role,
    enterpriseIdentityScope,
  ]);

  const clearEnterpriseFlyoutCloseTimer = useCallback(() => {
    if (enterpriseFlyoutCloseTimerRef.current === null) return;
    window.clearTimeout(enterpriseFlyoutCloseTimerRef.current);
    enterpriseFlyoutCloseTimerRef.current = null;
  }, []);

  const cancelEnterpriseFlyoutPositionFrame = useCallback(() => {
    if (enterpriseFlyoutPositionFrameRef.current === null) return;
    window.cancelAnimationFrame(enterpriseFlyoutPositionFrameRef.current);
    enterpriseFlyoutPositionFrameRef.current = null;
  }, []);

  const openEnterpriseFlyout = useCallback(() => {
    clearEnterpriseFlyoutCloseTimer();
    setShowEnterpriseFlyout(true);
  }, [clearEnterpriseFlyoutCloseTimer]);

  const closeEnterpriseFlyout = useCallback(() => {
    clearEnterpriseFlyoutCloseTimer();
    setShowEnterpriseFlyout(false);
    setEnterpriseFlyoutPosition(null);
  }, [clearEnterpriseFlyoutCloseTimer]);

  const scheduleEnterpriseFlyoutClose = useCallback(() => {
    clearEnterpriseFlyoutCloseTimer();
    enterpriseFlyoutCloseTimerRef.current = window.setTimeout(() => {
      setShowEnterpriseFlyout(false);
      setEnterpriseFlyoutPosition(null);
      enterpriseFlyoutCloseTimerRef.current = null;
    }, enterpriseFlyoutCloseDelayMs);
  }, [clearEnterpriseFlyoutCloseTimer]);

  useLayoutEffect(() => {
    if (adminIdentities.length > 0 || !showEnterpriseFlyout) return;
    closeEnterpriseFlyout();
  }, [adminIdentities.length, closeEnterpriseFlyout, showEnterpriseFlyout]);

  const updateEnterpriseFlyoutPosition = useCallback(() => {
    const trigger = enterpriseManagementButtonRef.current;
    const flyout = enterpriseFlyoutRef.current;
    if (!trigger || !flyout) return;

    const triggerRect = trigger.getBoundingClientRect();
    const flyoutRect = flyout.getBoundingClientRect();
    const nextPosition = resolveEnterpriseMenuFlyoutPosition(
      triggerRect,
      flyoutRect,
      {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    );

    setEnterpriseFlyoutPosition(previousPosition => (
      previousPosition?.left === nextPosition.left
      && previousPosition.top === nextPosition.top
        ? previousPosition
        : nextPosition
    ));
  }, []);

  const scheduleEnterpriseFlyoutPositionUpdate = useCallback(() => {
    if (enterpriseFlyoutPositionFrameRef.current !== null) return;
    enterpriseFlyoutPositionFrameRef.current = window.requestAnimationFrame(() => {
      enterpriseFlyoutPositionFrameRef.current = null;
      updateEnterpriseFlyoutPosition();
    });
  }, [updateEnterpriseFlyoutPosition]);

  useLayoutEffect(() => {
    if (!showEnterpriseFlyout) return;
    updateEnterpriseFlyoutPosition();
  }, [adminIdentities.length, showEnterpriseFlyout, updateEnterpriseFlyoutPosition]);

  useEffect(() => {
    if (!showEnterpriseFlyout) return;
    window.addEventListener('resize', scheduleEnterpriseFlyoutPositionUpdate);
    window.addEventListener('scroll', scheduleEnterpriseFlyoutPositionUpdate, true);
    return () => {
      window.removeEventListener('resize', scheduleEnterpriseFlyoutPositionUpdate);
      window.removeEventListener('scroll', scheduleEnterpriseFlyoutPositionUpdate, true);
      cancelEnterpriseFlyoutPositionFrame();
    };
  }, [
    cancelEnterpriseFlyoutPositionFrame,
    scheduleEnterpriseFlyoutPositionUpdate,
    showEnterpriseFlyout,
  ]);

  useEffect(() => () => {
    clearEnterpriseFlyoutCloseTimer();
    cancelEnterpriseFlyoutPositionFrame();
  }, [cancelEnterpriseFlyoutPositionFrame, clearEnterpriseFlyoutCloseTimer]);

  const openPortalUrl = async (url: string, action: string) => {
    logEnterpriseAccountDiagnostic('debug', action);
    try {
      await window.electron.shell.openExternal(url);
      onClose();
    } catch (error) {
      logEnterpriseAccountDiagnostic('warn', `${action} failed`, error);
    }
  };

  const handleLogout = async () => {
    logEnterpriseAccountDiagnostic('debug', 'logging out from enterprise account menu');
    try {
      await authService.logout();
      onClose();
    } catch (error) {
      logEnterpriseAccountDiagnostic('warn', 'enterprise account logout failed', error);
    }
  };

  const openEnterpriseIdentity = async (identity: EnterpriseAccountIdentity) => {
    await openPortalUrl(
      getEnterpriseOverviewUrl(identity.enterpriseId),
      `opening enterprise ${identity.enterpriseId} from administrator identity list`,
    );
  };

  const handleEnterpriseManagementBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextFocusedElement = event.relatedTarget;
    if (
      nextFocusedElement instanceof Node
      && (
        event.currentTarget.contains(nextFocusedElement)
        || enterpriseFlyoutRef.current?.contains(nextFocusedElement)
      )
    ) {
      return;
    }
    scheduleEnterpriseFlyoutClose();
  };

  const enterpriseFlyout = showEnterpriseFlyout && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={enterpriseFlyoutRef}
        data-enterprise-account-flyout="true"
        role="menu"
        aria-label={i18nService.t('enterpriseAccountChooseEnterprise')}
        onMouseEnter={openEnterpriseFlyout}
        onMouseLeave={scheduleEnterpriseFlyoutClose}
        onFocus={openEnterpriseFlyout}
        onBlur={handleEnterpriseManagementBlur}
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          closeEnterpriseFlyout();
          enterpriseManagementButtonRef.current?.focus();
        }}
        className="fixed z-[60] w-[15rem] max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1.5 shadow-popover popover-enter"
        style={{
          left: enterpriseFlyoutPosition?.left ?? 0,
          top: enterpriseFlyoutPosition?.top ?? 0,
          visibility: enterpriseFlyoutPosition ? 'visible' : 'hidden',
        }}
      >
        <div className="px-2.5 pb-1.5 pt-1 text-xs font-medium text-secondary">
          {i18nService.t('enterpriseAccountChooseEnterprise')}
        </div>
        <div className="max-h-[min(18rem,calc(100vh-4rem))] overflow-y-auto">
          {adminIdentities.map(identity => {
            const isCurrentEnterprise = identity.enterpriseId === context.enterpriseId;
            return (
              <button
                key={identity.enterpriseId}
                type="button"
                role="menuitem"
                onClick={() => void openEnterpriseIdentity(identity)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  isCurrentEnterprise
                    ? 'bg-surface-raised'
                    : 'hover:bg-surface-raised'
                }`}
              >
                <strong className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {identity.enterpriseName}
                </strong>
                <span className="shrink-0 text-xs font-medium text-primary">
                  {i18nService.t('enterpriseAccountEnter')}
                </span>
              </button>
            );
          })}
        </div>
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <div className="absolute bottom-full left-[-0.5rem] z-50 mb-1 max-h-[calc(100vh-3rem)] w-[15.5rem] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-surface shadow-popover popover-enter">
        <div className="border-b border-border px-4 py-3">
          <div className="truncate text-sm font-medium text-foreground">
            {accountName}
          </div>
          <div className="mt-1 break-words text-xs text-secondary">
            {i18nService.t('enterpriseAccountBelongsTo').replace('{name}', context.enterpriseName)}
          </div>
          <span className={`mt-2 inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
            isSuperAdmin
              ? 'bg-primary/10 text-primary'
              : 'bg-surface-raised text-secondary'
          }`}>
            {i18nService.t(
              isSuperAdmin
                ? 'enterpriseAccountRoleSuperAdmin'
                : 'enterpriseAccountRoleMember',
            )}
          </span>
        </div>

        <div className="border-b border-border px-4 py-2.5">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-secondary">{i18nService.t('enterpriseAccountQuota')}</span>
            <strong className="font-medium text-foreground">
              {formatCredits(context.memberQuota.remaining)}
              <span className="font-normal text-secondary">
                {' / '}{formatCredits(context.memberQuota.limit)} {i18nService.t('authCreditsUnit')}
              </span>
            </strong>
          </div>
        </div>

        <div className="py-1">
          {adminIdentities.length > 0 ? (
            <div
              onMouseEnter={openEnterpriseFlyout}
              onMouseLeave={scheduleEnterpriseFlyoutClose}
              onFocus={openEnterpriseFlyout}
              onBlur={handleEnterpriseManagementBlur}
            >
              <button
                ref={enterpriseManagementButtonRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={showEnterpriseFlyout}
                onClick={() => {
                  if (showEnterpriseFlyout) {
                    closeEnterpriseFlyout();
                  } else {
                    openEnterpriseFlyout();
                  }
                }}
                onKeyDown={event => {
                  if (event.key === 'Escape') {
                    closeEnterpriseFlyout();
                  }
                }}
                className={`flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface-raised ${
                  showEnterpriseFlyout ? 'bg-surface-raised' : ''
                }`}
              >
                <BuildingOffice2Icon className={actionIconClassName} />
                <span className="min-w-0 flex-1 truncate">
                  {i18nService.t('enterpriseAccountManagement')}
                </span>
                <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
              </button>
            </div>
          ) : null}
          <MenuAction
            icon={<ChartBarIcon className={actionIconClassName} />}
            label={i18nService.t('authUsageOverview')}
            onClick={() => openPortalUrl(
              getEnterpriseMemberProfileUrl(context.enterpriseId),
              'opening usage overview from enterprise account menu',
            )}
          />
          <MenuAction
            icon={<ArrowRightStartOnRectangleIcon className={actionIconClassName} />}
            label={i18nService.t('authLogout')}
            onClick={handleLogout}
          />
        </div>
      </div>
      {enterpriseFlyout}
    </>
  );
};
