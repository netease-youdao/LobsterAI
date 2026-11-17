import { CheckIcon, ExclamationTriangleIcon, GlobeAltIcon, XMarkIcon } from '@heroicons/react/24/outline';
import React from 'react';

import {
  type BrowserLoginSessionState,
  BrowserLoginStatus,
} from '../../services/browserLoginSession';
import { i18nService } from '../../services/i18n';
import { useCopyLoginLink } from './useBrowserLoginSession';

interface BrowserLoginStatusCardProps {
  session: BrowserLoginSessionState;
  onRetry: () => void;
  onDismiss: () => void;
}

const Spinner: React.FC<{ className?: string }> = ({ className = 'h-3.5 w-3.5' }) => (
  <span
    className={`${className} inline-block shrink-0 rounded-full border-2 border-border border-t-foreground animate-spin motion-reduce:animate-none`}
    aria-hidden="true"
  />
);

const TEXT_ACTION_CLASS_NAME = 'inline-flex items-center gap-1 font-medium text-foreground/80 transition-colors hover:text-foreground disabled:cursor-default disabled:text-secondary';

/**
 * Keeps an in-flight browser login visible next to the account button: the
 * login happens in another app, so without this the click looks like it did
 * nothing. Quiet while waiting; the copy-link escape hatch becomes the
 * primary action only when the browser could not be opened at all.
 */
const BrowserLoginStatusCard: React.FC<BrowserLoginStatusCardProps> = ({
  session,
  onRetry,
  onDismiss,
}) => {
  const { copied, copy } = useCopyLoginLink('account_button');
  const failed = session.status === BrowserLoginStatus.OpenFailed;
  const expired = session.status === BrowserLoginStatus.Expired;
  const rejected = session.status === BrowserLoginStatus.Failed;
  const verifying = session.status === BrowserLoginStatus.Verifying;
  const reopening = session.status === BrowserLoginStatus.Opening || verifying;
  const title = expired ? 'firstRunExpiredTitle' : rejected ? 'firstRunFailedTitle'
    : failed ? 'browserLoginOpenFailedTitle' : verifying ? 'firstRunVerifyingTitle' : 'browserLoginWaitingTitle';
  const hint = expired ? 'firstRunExpiredHint' : rejected ? 'firstRunFailedHint'
    : failed ? 'firstRunOpenFailedHint' : verifying ? 'firstRunVerifyingHint' : 'browserLoginWaitingHint';
  const url = session.url;

  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute bottom-full left-0 z-40 mb-2.5 w-[15rem] rounded-2xl border border-border bg-surface p-3 shadow-popover"
    >
      <div className="flex items-start gap-2.5">
        {/* The account button already spins, so the card stays calm. */}
        <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center">
          {failed || expired || rejected
            ? <ExclamationTriangleIcon className="h-4 w-4 text-warning" aria-hidden="true" />
            : <GlobeAltIcon className="h-4 w-4 text-secondary" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium leading-[18px] text-foreground">
            {i18nService.t(title)}
          </p>
          <p className="mt-0.5 text-xs leading-[17px] text-secondary">
            {i18nService.t(hint)}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={i18nService.t('browserLoginDismiss')}
          title={i18nService.t('browserLoginDismiss')}
          className="-mr-1 -mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {failed && url ? (
        <div className="mt-3 flex items-center gap-2 pl-[1.625rem]">
          <button
            type="button"
            onClick={() => void copy(url)}
            className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-lg bg-foreground px-2.5 text-xs font-medium text-surface transition-opacity hover:opacity-90"
          >
            {copied && <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />}
            {i18nService.t(copied ? 'copied' : 'browserLoginCopyLoginLink')}
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-7 items-center rounded-lg border border-border px-2.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-surface-raised hover:text-foreground"
          >
            {i18nService.t('browserLoginRetry')}
          </button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2 pl-[1.625rem] text-xs">
          <button type="button" onClick={onRetry} disabled={reopening} className={TEXT_ACTION_CLASS_NAME}>
            {reopening && <Spinner className="h-3 w-3" />}
            {i18nService.t(expired || rejected ? 'firstRunLoginRetry' : 'browserLoginReopen')}
          </button>
          {url && (
            <>
              <span className="text-secondary/50" aria-hidden="true">·</span>
              <button type="button" onClick={() => void copy(url)} className={TEXT_ACTION_CLASS_NAME}>
                {copied && <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />}
                {i18nService.t(copied ? 'copied' : 'browserLoginCopyLink')}
              </button>
            </>
          )}
        </div>
      )}

      <span
        className="absolute -bottom-[6px] left-[2.625rem] h-2.5 w-2.5 rotate-45 rounded-[2px] border-b border-r border-border bg-surface"
        aria-hidden="true"
      />
    </div>
  );
};

export default BrowserLoginStatusCard;
