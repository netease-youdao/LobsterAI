import { XMarkIcon } from '@heroicons/react/24/outline';
import { AuthLoginFailureReason } from '@shared/auth/constants';
import {
  CustomBoostAmount,
  type PaymentCatalog,
  type PaymentPlanView,
  PaymentProduct,
  type PaymentQuoteView,
  type PaymentTarget,
} from '@shared/payment/constants';
import React, { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import Modal from '../../../components/common/Modal';
import PurchaseOfferCountdown from '../../../components/PurchaseOfferCountdown';
import { authService, getLoginFailureMessage } from '../../../services/auth';
import { getPortalPricingUrl } from '../../../services/endpoints';
import { i18nService } from '../../../services/i18n';
import {
  formatPurchaseOfferDiscount,
  getPurchaseOfferDiscountRate,
} from '../../../services/lowCreditPurchaseOffer';
import type { RootState } from '../../../store';
import {
  BOOST_PRESET_AMOUNTS,
  boostOptionFor,
  formatCredits,
  formatYuan,
  offerTokenFor,
  parseCustomBoostAmount,
  productKeyOf,
  SubscriptionCheckout,
  subscriptionCheckoutFor,
} from '../purchaseCatalog';
import type { PurchaseEntryOptions } from '../purchaseEntry';
import type { CheckoutRequest } from '../usePaymentSession';
import PaymentCheckout from './PaymentCheckout';

const SUBSCRIPTION_AGREEMENT_URL = 'https://c.youdao.com/dict/hardware/lobsterai/subscription.html';
const BOOST_AGREEMENT_URL = 'https://c.youdao.com/dict/hardware/lobsterai/dataPackageServe.html';
const QUOTE_DEBOUNCE_MS = 250;
const DEFAULT_BOOST_AMOUNT = 50;

type PurchaseTab = 'subscription' | 'boost';
type Loadable<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error' };

const t = (key: string): string => i18nService.t(key);
const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};
const isEnglish = (): boolean => i18nService.getLanguage() === 'en';
const planName = (plan: PaymentPlanView): string => (isEnglish() && plan.displayNameEn) || plan.displayName;
const planTag = (plan: PaymentPlanView): string | null => (isEnglish() ? plan.tagEn : plan.tag);
const selectedClass = (selected: boolean): string => (
  selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
);

interface PurchaseDialogProps {
  options: PurchaseEntryOptions;
  onClose: () => void;
}

const PurchaseDialog: React.FC<PurchaseDialogProps> = ({ options, onClose }) => {
  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const ownerAccountKey = useSelector((state: RootState) => state.auth.ownerAccountKey);
  const purchaseOffer = useSelector((state: RootState) => state.auth.purchaseOffer);
  const [tab, setTab] = useState<PurchaseTab>(options.tab ?? 'subscription');
  const [catalog, setCatalog] = useState<Loadable<PaymentCatalog>>({ status: 'loading' });
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [planId, setPlanId] = useState<number | null>(null);
  const [presetAmount, setPresetAmount] = useState(DEFAULT_BOOST_AMOUNT);
  const [customSelected, setCustomSelected] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [quote, setQuote] = useState<Loadable<PaymentQuoteView> | null>(null);
  const [checkout, setCheckout] = useState<CheckoutRequest | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCatalog({ status: 'loading' });
    window.electron.payment.getCatalog()
      .then((result) => {
        if (!cancelled) setCatalog(result.success ? { status: 'ready', data: result.data } : { status: 'error' });
      })
      .catch(() => {
        if (!cancelled) setCatalog({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, catalogAttempt]);

  const ready = catalog.status === 'ready' ? catalog.data : null;
  const subscriptionInApp = subscriptionCheckoutFor(ready?.subscription ?? null) === SubscriptionCheckout.InApp;
  const selectedPlan = ready?.plans.find(plan => plan.id === planId) ?? ready?.plans[0] ?? null;
  const customAmount = parseCustomBoostAmount(customInput);
  const boostOption = useMemo(() => {
    if (!ready) return null;
    if (!customSelected) return boostOptionFor(presetAmount, ready.boostPacks);
    return customAmount === null ? null : boostOptionFor(customAmount, ready.boostPacks);
  }, [ready, customSelected, presetAmount, customAmount]);
  const target = useMemo<PaymentTarget | null>(() => {
    if (tab === 'boost') return boostOption?.target ?? null;
    return selectedPlan && subscriptionInApp
      ? { product: PaymentProduct.Subscription, planId: selectedPlan.id }
      : null;
  }, [tab, boostOption, selectedPlan, subscriptionInApp]);
  const product = tab === 'subscription' ? PaymentProduct.Subscription : PaymentProduct.BoostPack;
  const offerToken = offerTokenFor(purchaseOffer, options.offerToken, product);
  const offerRate = offerToken && purchaseOffer ? getPurchaseOfferDiscountRate(purchaseOffer, product) : null;

  useEffect(() => {
    setQuote(null);
    if (!isLoggedIn || !target) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setQuote({ status: 'loading' });
      window.electron.payment.quote({ target, offerToken })
        .then((result) => {
          if (!cancelled) setQuote(result.success ? { status: 'ready', data: result.data } : { status: 'error' });
        })
        .catch(() => {
          if (!cancelled) setQuote({ status: 'error' });
        });
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isLoggedIn, target, offerToken]);

  const quoted = quote?.status === 'ready' ? quote.data : null;
  const listPrice = tab === 'subscription' ? selectedPlan?.monthlyPrice ?? null : boostOption?.amount ?? null;
  const payable = quoted?.amount ?? listPrice;
  const originalPrice = quoted && quoted.originalAmount > quoted.amount ? quoted.originalAmount : null;
  const credits = quoted?.totalCredits ?? (tab === 'subscription'
    ? (selectedPlan ? selectedPlan.monthlyCredits + selectedPlan.bonusCredits : null)
    : boostOption?.credits ?? null);
  const quoteBlocking = quote?.status === 'loading' || quote?.status === 'error';
  const offerLabel = offerRate !== null
    ? t('lowCreditOfferLimitedDiscount').replace('{discount}', formatPurchaseOfferDiscount(offerRate))
    : null;

  const openPortal = (): void => {
    void window.electron.shell.openExternal(getPortalPricingUrl(options.keyfrom, {
      traceId: options.traceId,
      offerToken: options.offerToken,
      tab,
    }));
    onClose();
  };

  const handleBuy = async (): Promise<void> => {
    if (!isLoggedIn) {
      setSigningIn(true);
      const result = await authService.login();
      setSigningIn(false);
      if (!result.success && result.reason !== AuthLoginFailureReason.Cancelled) {
        showToast(getLoginFailureMessage(result.reason));
      }
      return;
    }
    if (!target || payable === null || quoteBlocking) return;
    if (!agreed) {
      showToast(t('purchaseAgreementRequired'));
      return;
    }
    setCheckout({
      target,
      offerToken,
      reuseKey: [ownerAccountKey ?? '', productKeyOf(target), offerToken ?? ''].join('|'),
      title: tab === 'subscription' && selectedPlan
        ? t('paymentCheckoutSubscriptionTitle').replace('{plan}', planName(selectedPlan))
        : t('paymentCheckoutBoostTitle'),
      renewalPrice: tab === 'subscription' ? selectedPlan?.monthlyPrice : undefined,
    });
  };

  const renderSubscription = (data: PaymentCatalog): React.ReactNode => {
    if (!subscriptionInApp) {
      const currentPlan = data.plans.find(plan => plan.id === data.subscription?.planId);
      const message = data.subscription?.trialActive
        ? t('purchaseTrialOnPortal')
        : t('purchaseManageOnPortal').replace('{plan}', currentPlan ? planName(currentPlan) : '');
      return (
        <div className="rounded-xl border border-border bg-surface-raised px-4 py-5 text-center">
          <p className="text-sm leading-6 text-foreground">{message}</p>
          <button
            type="button"
            onClick={openPortal}
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary/90"
          >
            {t('purchaseOpenPortal')}
          </button>
        </div>
      );
    }
    return (
      <div className="space-y-2" role="radiogroup" aria-label={t('purchaseTabSubscription')}>
        {data.plans.map((plan) => {
          const selected = plan.id === selectedPlan?.id;
          const tag = planTag(plan);
          return (
            <button
              key={plan.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPlanId(plan.id)}
              className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${selectedClass(selected)}`}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {planName(plan)}
                  {tag && (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      {tag}
                    </span>
                  )}
                </span>
                <span className="mt-1 block text-xs text-secondary">
                  {t('purchaseMonthlyCredits').replace('{credits}', formatCredits(plan.monthlyCredits))}
                  {plan.bonusCredits > 0
                    && ` · ${t('purchaseBonusCredits').replace('{credits}', formatCredits(plan.bonusCredits))}`}
                </span>
              </span>
              <span className="shrink-0 text-base font-semibold text-foreground">
                {formatYuan(plan.monthlyPrice)}
                <span className="text-xs font-normal text-secondary">{t('purchasePerMonth')}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  const renderBoost = (data: PaymentCatalog): React.ReactNode => (
    <>
      <div className="grid grid-cols-3 gap-2">
        {BOOST_PRESET_AMOUNTS.map((amount) => {
          const option = boostOptionFor(amount, data.boostPacks);
          const selected = !customSelected && presetAmount === amount;
          return (
            <button
              key={amount}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setCustomSelected(false);
                setPresetAmount(amount);
              }}
              className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${selectedClass(selected)}`}
            >
              <span className="block text-base font-semibold text-foreground">{formatYuan(amount)}</span>
              <span className="mt-0.5 block text-xs text-secondary">
                {t('purchaseCredits').replace('{credits}', formatCredits(option.credits))}
              </span>
            </button>
          );
        })}
        <label className={`flex cursor-text flex-col justify-center rounded-xl border px-3 py-2 transition-colors ${selectedClass(customSelected)}`}>
          <span className="text-xs text-secondary">{t('purchaseCustomAmount')}</span>
          <input
            type="text"
            inputMode="numeric"
            value={customInput}
            placeholder={`${CustomBoostAmount.Min}-${CustomBoostAmount.Max}`}
            onFocus={() => setCustomSelected(true)}
            onChange={(event) => {
              setCustomSelected(true);
              setCustomInput(event.target.value.replace(/\D/g, '').slice(0, 4));
            }}
            className="mt-0.5 w-full min-w-0 bg-transparent text-base font-semibold text-foreground outline-none placeholder:text-sm placeholder:font-normal placeholder:text-secondary"
          />
        </label>
      </div>
      {customSelected && customInput !== '' && customAmount === null && (
        <p className="mt-2 text-xs text-red-500">{t('purchaseCustomAmountHint')}</p>
      )}
    </>
  );

  const showFooter = ready !== null && (tab === 'boost' || subscriptionInApp);
  const ctaText = !isLoggedIn
    ? t('purchaseLoginToBuy')
    : t(tab === 'subscription' ? 'purchaseSubscribeNow' : 'purchaseBuyNow')
      .replace('{price}', payable === null ? '' : formatYuan(payable));

  return (
    <Modal
      onClose={onClose}
      onEscape={onClose}
      overlayClassName="fixed inset-0 z-[10050] flex items-center justify-center modal-backdrop px-4"
      className="modal-content flex max-h-[90vh] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-modal"
    >
      {checkout ? (
        <PaymentCheckout request={checkout} onBack={() => setCheckout(null)} onClose={onClose} />
      ) : (
        <>
          <div className="flex items-center justify-between px-5 pt-5">
            <h2 className="text-base font-semibold text-foreground">{t('purchaseCenterTitle')}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('close')}
              className="-mr-1 rounded-lg p-1 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
          <div className="mx-5 mt-4 grid grid-cols-2 gap-1 rounded-lg bg-surface-raised p-1 text-sm" role="tablist">
            {(['subscription', 'boost'] as const).map(value => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                onClick={() => setTab(value)}
                className={`rounded-md py-1.5 font-medium transition-colors ${
                  tab === value ? 'bg-surface text-foreground shadow-sm' : 'text-secondary hover:text-foreground'
                }`}
              >
                {t(value === 'subscription' ? 'purchaseTabSubscription' : 'purchaseTabBoost')}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {catalog.status === 'loading' && (
              <p className="py-10 text-center text-sm text-secondary">{t('purchaseLoading')}</p>
            )}
            {catalog.status === 'error' && (
              <div className="py-10 text-center text-sm text-secondary">
                <p>{t('purchaseLoadFailed')}</p>
                <button
                  type="button"
                  onClick={() => setCatalogAttempt(value => value + 1)}
                  className="mt-3 text-primary hover:underline"
                >
                  {t('purchaseRetry')}
                </button>
              </div>
            )}
            {ready && (tab === 'subscription' ? renderSubscription(ready) : renderBoost(ready))}
            <button
              type="button"
              onClick={openPortal}
              className="mt-4 block w-full text-center text-xs text-secondary transition-colors hover:text-foreground"
            >
              {t('purchaseMoreOnPortal')}
            </button>
          </div>
          {showFooter && (
            <div className="border-t border-border px-5 py-4">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs text-secondary">{t('paymentAmount')}</div>
                  <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xl font-semibold text-foreground">
                      {payable === null ? '--' : formatYuan(payable)}
                    </span>
                    {originalPrice !== null && (
                      <span className="text-xs text-secondary line-through">{formatYuan(originalPrice)}</span>
                    )}
                    {offerLabel && <span className="text-xs font-medium text-[#ff563f]">{offerLabel}</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs text-secondary">
                  {credits !== null && (
                    <div>{t('paymentCreditsTotal').replace('{credits}', formatCredits(credits))}</div>
                  )}
                  {quote?.status === 'loading' && <div>{t('purchaseQuoteLoading')}</div>}
                  {quote?.status === 'error' && <div className="text-red-500">{t('purchaseQuoteFailed')}</div>}
                </div>
              </div>
              {offerLabel && purchaseOffer?.expiresAtEpochMs != null && (
                <div className="mt-1 text-xs"><PurchaseOfferCountdown offer={purchaseOffer} /></div>
              )}
              <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-secondary">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={event => setAgreed(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  {t('purchaseAgreementPrefix')}
                  <button
                    type="button"
                    onClick={() => {
                      void window.electron.shell.openExternal(
                        tab === 'subscription' ? SUBSCRIPTION_AGREEMENT_URL : BOOST_AGREEMENT_URL,
                      );
                    }}
                    className="text-primary hover:underline"
                  >
                    {t(tab === 'subscription' ? 'purchaseSubscriptionAgreement' : 'purchaseBoostAgreement')}
                  </button>
                </span>
              </label>
              <button
                type="button"
                disabled={signingIn || (isLoggedIn && (!target || quoteBlocking))}
                onClick={() => { void handleBuy(); }}
                className="mt-3 w-full rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {ctaText}
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
};

export default PurchaseDialog;
