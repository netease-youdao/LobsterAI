import React, { useEffect, useState } from 'react';

import { type PurchaseEntryOptions, registerPurchaseCenter } from '../purchaseEntry';
import PurchaseDialog from './PurchaseDialog';

interface PurchaseRequest {
  id: number;
  options: PurchaseEntryOptions;
}

/** Mounted once; purchase entries anywhere in the app open the dialog through openPurchase(). */
const PurchaseCenter: React.FC = () => {
  const [request, setRequest] = useState<PurchaseRequest | null>(null);

  useEffect(() => registerPurchaseCenter((options) => {
    setRequest(current => ({ id: (current?.id ?? 0) + 1, options }));
  }), []);

  if (!request) return null;
  return <PurchaseDialog key={request.id} options={request.options} onClose={() => setRequest(null)} />;
};

export default PurchaseCenter;
