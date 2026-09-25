import { ArrowLeftIcon, CheckCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { AuthLoginFailureReason } from '@shared/auth/constants';
import { PaymentChannel, PaymentProduct } from '@shared/payment/constants';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect } from 'react';

import { authService, getLoginFailureMessage } from '../../../services/auth';
import { i18nService } from '../../../services/i18n';
import { PaymentFailureKind, PaymentPhase } from '../paymentSession';
import { InAppPurchaseStep, reportInAppPurchase } from '../purchaseAnalytics';
import { formatCredits, formatYuan } from '../purchaseCatalog';
import { type CheckoutRequest, usePaymentSession } from '../usePaymentSession';

const PAID_SERVICE_AGREEMENT_URL = 'https://c.youdao.com/dict/hardware/lobsterai/lobster_service_agreement.html';

const t = (key: string): string => i18nService.t(key);

const formatCountdown = (seconds: number): string => (
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
);

const FAILURE_MESSAGE_KEYS: Record<PaymentFailureKind, string> = {
  [PaymentFailureKind.CreateFailed]: 'paymentCreateFailed',
  [PaymentFailureKind.LoginRequired]: 'paymentLoginRequired',
  [PaymentFailureKind.OfferUnavailable]: 'paymentOfferUnavailable',
  [PaymentFailureKind.OldOrderPaid]: 'paymentOldOrderPaid',
  [PaymentFailureKind.PaymentFailed]: 'paymentFailed',
  [PaymentFailureKind.Refunded]: 'paymentRefunded',
};

interface PanelAction {
  label: string;
  onClick: () => void;
}

const StatusPanel: React.FC<{ message: string; busy?: boolean; action?: PanelAction }> = ({
  message,
  busy = false,
  action,
}) => (
  <div className="flex flex-col items-center gap-3 px-4 py-6 text-center">
    {busy && (
      <span
        className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
        aria-hidden="true"
      />
    )}
    <p className="text-sm leading-6 text-secondary">{message}</p>
    {action && (
      <button
        type="button"
        onClick={action.onClick}
        className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
      >
        {action.label}
      </button>
    )}
  </div>
);

interface PaymentCheckoutProps {
  request: CheckoutRequest;
  onBack: () => void;
  onClose: () => void;
}

const PaymentCheckout: React.FC<PaymentCheckoutProps> = ({ request, onBack, onClose }) => {
  const product = request.target.product;
  const isSubscription = product === PaymentProduct.Subscription;
  const { state, session } = usePaymentSession(request, {
    onOrderReady: () => reportInAppPurchase(InAppPurchaseStep.OrderCreated, {
      product,
      offerTokenAttached: Boolean(request.offerToken),
    }),
    onEntitlementsChanged: () => {
      void authService.checkQuota();
    },
  });
  const { order, phase } = state;

  useEffect(() => {
    if (phase === PaymentPhase.Paid) reportInAppPurchase(InAppPurchaseStep.Paid, { product });
    if (phase === PaymentPhase.Failed) {
      reportInAppPurchase(InAppPurchaseStep.Failed, { product, failure: state.failure });
    }
  }, [phase, state.failure, product]);

  const signInAgain = (): void => {
    void authService.login().then((result) => {
      if (result.success) {
        session?.regenerate();
      } else if (result.reason !== AuthLoginFailureReason.Cancelled) {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: getLoginFailureMessage(result.reason) }));
      }
    });
  };

  const failureAction = (): PanelAction | undefined => {
    switch (state.failure) {
      case PaymentFailureKind.CreateFailed:
      case PaymentFailureKind.PaymentFailed:
        return { label: t('paymentRegenerate'), onClick: () => session?.regenerate() };
      case PaymentFailureKind.OfferUnavailable:
      case PaymentFailureKind.OldOrderPaid:
        return { label: t('paymentBack'), onClick: onBack };
      case PaymentFailureKind.LoginRequired:
        return { label: t('purchaseLoginToBuy'), onClick: signInAgain };
      default:
        return undefined;
    }
  };

  const renderPanel = (): React.ReactNode => {
    switch (phase) {
      case PaymentPhase.Creating:
        return <StatusPanel busy message={t('paymentCreating')} />;
      case PaymentPhase.Replacing:
        return <StatusPanel busy message={t('paymentReplacing')} />;
      case PaymentPhase.Processing:
        return <StatusPanel busy message={t('paymentProcessing')} />;
      case PaymentPhase.Waiting:
        if (state.channel === PaymentChannel.Alipay && state.channelLoading) {
          return <StatusPanel busy message={t('paymentCreating')} />;
        }
        return state.qr
          ? <div className="rounded-lg bg-white p-2"><QRCodeSVG value={state.qr} size={168} /></div>
          : <StatusPanel message={t('paymentChannelUnavailable')} />;
      case PaymentPhase.StatusUnavailable:
        return (
          <StatusPanel
            message={t('paymentStatusUnavailable')}
            action={{ label: t('paymentIHavePaid'), onClick: () => session?.recheck() }}
          />
        );
      case PaymentPhase.Expired:
        return (
          <StatusPanel
            message={t('paymentExpired')}
            action={{ label: t('paymentRegenerate'), onClick: () => session?.regenerate() }}
          />
        );
      case PaymentPhase.Review:
        return <StatusPanel message={t('paymentReview')} />;
      case PaymentPhase.Paid:
        return (
          <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
            <CheckCircleIcon className="h-12 w-12 text-green-500" />
            <p className="text-base font-semibold text-foreground">{t('paymentSuccess')}</p>
            <p className="text-xs text-secondary">{t('paymentSuccessCredits')}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-2 rounded-lg bg-primary px-6 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary/90"
            >
              {t('paymentDone')}
            </button>
          </div>
        );
      case PaymentPhase.Failed:
        return (
          <StatusPanel
            message={t(FAILURE_MESSAGE_KEYS[state.failure ?? PaymentFailureKind.CreateFailed])}
            action={failureAction()}
          />
        );
      default:
        return null;
    }
  };

  const scanHint = isSubscription
    ? t('paymentScanWechatSign')
    : t(state.channel === PaymentChannel.Wechat ? 'paymentScanWechat' : 'paymentScanAlipay');
  const credits = order?.totalCredits ?? order?.baseCredits ?? null;

  return (
    <>
      <div className="flex items-center gap-2 px-5 pt-5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('paymentBack')}
          className="-ml-1 rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">{request.title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="-mr-1 rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>
      <div className="flex flex-col items-center px-5 pb-6 pt-4">
        {order?.amount != null && (
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-foreground">{formatYuan(order.amount)}</span>
            {order.originalAmount != null && order.originalAmount > order.amount && (
              <span className="text-sm text-secondary line-through">{formatYuan(order.originalAmount)}</span>
            )}
          </div>
        )}
        {credits !== null && (
          <p className="mt-1 text-xs text-secondary">
            {t('paymentCreditsTotal').replace('{credits}', formatCredits(credits))}
            {order?.creditsEstimated ? t('paymentCreditsEstimated') : ''}
          </p>
        )}
        {!isSubscription && phase === PaymentPhase.Waiting && (
          <div className="mt-4 grid w-full max-w-[280px] grid-cols-2 gap-1 rounded-lg bg-surface-raised p-1 text-sm" role="tablist">
            {[PaymentChannel.Wechat, PaymentChannel.Alipay].map(channel => (
              <button
                key={channel}
                type="button"
                role="tab"
                aria-selected={state.channel === channel}
                onClick={() => session?.switchChannel(channel)}
                className={`rounded-md py-1.5 font-medium transition-colors ${
                  state.channel === channel
                    ? 'bg-surface text-foreground shadow-sm'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                {t(channel === PaymentChannel.Wechat ? 'paymentChannelWechat' : 'paymentChannelAlipay')}
              </button>
            ))}
          </div>
        )}
        <div className="mt-4 flex min-h-[200px] w-full max-w-[280px] items-center justify-center rounded-xl border border-border">
          {renderPanel()}
        </div>
        {phase === PaymentPhase.Waiting && state.qr && (
          <p className="mt-3 text-sm text-foreground">{scanHint}</p>
        )}
        {(phase === PaymentPhase.Waiting || phase === PaymentPhase.Processing) && (
          <p className="mt-1 text-xs tabular-nums text-secondary">
            {t('paymentCountdown').replace('{time}', formatCountdown(state.remainingSeconds))}
          </p>
        )}
        {isSubscription && request.renewalPrice !== undefined && phase !== PaymentPhase.Paid && (
          <p className="mt-4 text-center text-xs leading-5 text-secondary">
            {t('paymentRenewalNotice').replace('{price}', formatYuan(request.renewalPrice))}
            <button
              type="button"
              onClick={() => { void window.electron.shell.openExternal(PAID_SERVICE_AGREEMENT_URL); }}
              className="text-primary hover:underline"
            >
              {t('purchasePaidServiceAgreement')}
            </button>
          </p>
        )}
      </div>
    </>
  );
};

export default PaymentCheckout;
