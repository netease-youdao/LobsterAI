import { beforeEach, describe, expect, test } from 'vitest';

import {
  __fakeIpNetworkTestUtils,
  hasFakeIpInterface,
  isFakeIpNetworkActive,
  isRfc2544BenchmarkAddress,
  refreshFakeIpNetworkState,
} from './fakeIpNetwork';

const noInterfaces = () => [];

describe('fake-IP network detection', () => {
  beforeEach(() => {
    __fakeIpNetworkTestUtils.reset();
  });

  test('matches only the 198.18.0.0/15 benchmark range', () => {
    expect(isRfc2544BenchmarkAddress('198.18.0.81')).toBe(true);
    expect(isRfc2544BenchmarkAddress('198.19.255.254')).toBe(true);
    expect(isRfc2544BenchmarkAddress('198.17.0.1')).toBe(false);
    expect(isRfc2544BenchmarkAddress('198.20.0.1')).toBe(false);
    expect(isRfc2544BenchmarkAddress('192.168.1.1')).toBe(false);
    expect(isRfc2544BenchmarkAddress('10.0.0.1')).toBe(false);
    expect(isRfc2544BenchmarkAddress('fe80::1')).toBe(false);
  });

  test('detects a TUN interface holding a benchmark-range address', () => {
    expect(hasFakeIpInterface(() => ['127.0.0.1', '192.168.1.5', '198.18.0.1'])).toBe(true);
    expect(hasFakeIpInterface(() => ['127.0.0.1', '192.168.1.5'])).toBe(false);
    expect(hasFakeIpInterface(() => { throw new Error('unavailable'); })).toBe(false);
  });

  test('detects fake-IP DNS and clears the state once DNS is normal again', async () => {
    expect(isFakeIpNetworkActive(noInterfaces)).toBe(false);

    await expect(refreshFakeIpNetworkState(async () => '198.18.4.51')).resolves.toBe(true);
    expect(isFakeIpNetworkActive(noInterfaces)).toBe(true);

    await expect(refreshFakeIpNetworkState(async () => '93.184.216.34')).resolves.toBe(false);
    expect(isFakeIpNetworkActive(noInterfaces)).toBe(false);
  });

  test('treats failed lookups as not fake-IP', async () => {
    await expect(refreshFakeIpNetworkState(async () => { throw new Error('ENOTFOUND'); }))
      .resolves.toBe(false);
    expect(isFakeIpNetworkActive(noInterfaces)).toBe(false);
  });
});
