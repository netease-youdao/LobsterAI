import { afterEach, expect, test, vi } from 'vitest';

import { store } from '../../store';
import { setLoggedIn, setLoggedOut } from '../../store/slices/authSlice';
import { openPurchase, registerPurchaseCenter } from './purchaseEntry';

vi.mock('../../services/logReporter', () => ({ reportYdAnalyzer: vi.fn(async () => true) }));

function stubElectron(availability: boolean | Error) {
  const openExternal = vi.fn(async () => ({ success: true }));
  const getAvailability = vi.fn(async () => {
    if (availability instanceof Error) throw availability;
    return { enabled: availability };
  });
  vi.stubGlobal('window', { electron: { payment: { getAvailability }, shell: { openExternal } } });
  return { openExternal, getAvailability };
}

afterEach(() => {
  store.dispatch(setLoggedOut());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('opens the in-app purchase center when it is mounted and switched on', async () => {
  const { openExternal } = stubElectron(true);
  const present = vi.fn();
  const unregister = registerPurchaseCenter(present);

  await expect(openPurchase({ tab: 'boost', offerToken: 'offer-token-1' })).resolves.toEqual({ success: true });

  expect(present).toHaveBeenCalledWith({ tab: 'boost', offerToken: 'offer-token-1' });
  expect(openExternal).not.toHaveBeenCalled();
  unregister();
});

test('falls back to the Portal pricing page when switched off', async () => {
  const { openExternal } = stubElectron(false);
  const present = vi.fn();
  const unregister = registerPurchaseCenter(present);

  await openPurchase({ keyfrom: 'html_share', traceId: 'trace-1', tab: 'subscription' });

  expect(present).not.toHaveBeenCalled();
  expect(openExternal).toHaveBeenCalledWith(
    expect.stringMatching(/\/pricing\?keyfrom=html_share&trace_id=trace-1&tab=subscription$/),
  );
  unregister();
});

test('keeps in-app payment on when the switch cannot be read', async () => {
  stubElectron(new Error('ipc unavailable'));
  const present = vi.fn();
  const unregister = registerPurchaseCenter(present);

  await openPurchase();

  expect(present).toHaveBeenCalledTimes(1);
  unregister();
});

test('keeps enterprise accounts on the Portal', async () => {
  const { openExternal, getAvailability } = stubElectron(true);
  const present = vi.fn();
  const unregister = registerPurchaseCenter(present);
  store.dispatch(setLoggedIn({
    user: { yid: 'member', nickname: 'Member', avatarUrl: null },
    quota: null,
    ownerAccountKey: 'enterprise:7:1001',
  }));

  await openPurchase();

  expect(present).not.toHaveBeenCalled();
  expect(getAvailability).not.toHaveBeenCalled();
  expect(openExternal).toHaveBeenCalledTimes(1);
  unregister();
});

test('opens the Portal when no purchase center is mounted', async () => {
  const { openExternal } = stubElectron(true);
  await openPurchase();
  expect(openExternal).toHaveBeenCalledTimes(1);
});
