import { getPortalPricingUrl, type PortalPricingKeyfrom } from '../../services/endpoints';
import { store } from '../../store';
import { selectIsEnterpriseAccount } from '../enterpriseAccount/selectors';
import { InAppPurchaseStep, reportInAppPurchase } from './purchaseAnalytics';

export interface PurchaseEntryOptions {
  keyfrom?: PortalPricingKeyfrom;
  traceId?: string;
  offerToken?: string;
  tab?: 'subscription' | 'boost';
}

type PurchasePresenter = (options: PurchaseEntryOptions) => void;

let presenter: PurchasePresenter | null = null;

/** The purchase center registers here once mounted; entries only call openPurchase(). */
export function registerPurchaseCenter(next: PurchasePresenter): () => void {
  presenter = next;
  return () => {
    if (presenter === next) presenter = null;
  };
}

const isInAppPaymentEnabled = async (): Promise<boolean> => {
  try {
    return (await window.electron.payment.getAvailability()).enabled;
  } catch {
    return true;
  }
};

/**
 * Opens the in-app purchase dialog, or the Portal pricing page when in-app payment is switched off,
 * the account is an enterprise account, or no purchase center is mounted. Resolves like
 * shell.openExternal so callers keep their result handling.
 */
export async function openPurchase(
  options: PurchaseEntryOptions = {},
): Promise<{ success: boolean; error?: string }> {
  const eligible = presenter !== null && !selectIsEnterpriseAccount(store.getState());
  const inApp = eligible && await isInAppPaymentEnabled();
  const present = presenter;
  reportInAppPurchase(InAppPurchaseStep.Open, {
    checkout: inApp && present ? 'in_app' : 'portal',
    keyfrom: options.keyfrom,
    traceId: options.traceId,
    tab: options.tab,
    offerTokenAttached: Boolean(options.offerToken),
  });
  if (inApp && present) {
    present(options);
    return { success: true };
  }
  return window.electron.shell.openExternal(getPortalPricingUrl(options.keyfrom, options));
}
