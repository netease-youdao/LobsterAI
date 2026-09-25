import type { PaymentOrderView, PaymentTarget } from '@shared/payment/constants';
import { useEffect, useRef, useState } from 'react';

import {
  INITIAL_PAYMENT_SESSION_STATE,
  PaymentSession,
  type PaymentSessionState,
} from './paymentSession';

export interface CheckoutRequest {
  target: PaymentTarget;
  offerToken?: string;
  /** Account, product and offer; a later checkout with the same key reuses the pending order. */
  reuseKey: string;
  title: string;
  /** Monthly price the subscription renews at. */
  renewalPrice?: number;
}

interface CheckoutCallbacks {
  onOrderReady?: (order: PaymentOrderView) => void;
  onEntitlementsChanged?: () => void;
}

// Orders by reuse key, so closing and reopening checkout shows the same QR code.
const pendingOrders = new Map<string, PaymentOrderView>();

export function usePaymentSession(
  request: CheckoutRequest,
  callbacks: CheckoutCallbacks,
): { state: PaymentSessionState; session: PaymentSession | null } {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [session, setSession] = useState<PaymentSession | null>(null);
  const [state, setState] = useState<PaymentSessionState>(INITIAL_PAYMENT_SESSION_STATE);

  useEffect(() => {
    const next = new PaymentSession({
      target: request.target,
      offerToken: request.offerToken,
      reusableOrder: pendingOrders.get(request.reuseKey) ?? null,
      gateway: window.electron.payment,
      onChange: setState,
      onOrderReady: (order) => {
        pendingOrders.set(request.reuseKey, order);
        callbacksRef.current.onOrderReady?.(order);
      },
      onEntitlementsChanged: () => {
        pendingOrders.delete(request.reuseKey);
        callbacksRef.current.onEntitlementsChanged?.();
      },
    });
    setSession(next);
    setState(next.getState());
    // Start on the next tick: StrictMode runs this effect twice in development, and the first
    // session must not place an order before it is disposed.
    const timer = window.setTimeout(() => next.start(), 0);
    return () => {
      window.clearTimeout(timer);
      next.dispose();
    };
  }, [request]);

  return { state, session };
}
