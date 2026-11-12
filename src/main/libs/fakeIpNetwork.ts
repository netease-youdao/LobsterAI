import { lookup } from 'dns/promises';
import os from 'os';

/**
 * Detects fake-IP proxy stacks (Clash TUN, Surge enhanced mode, sing-box).
 * They answer every DNS query with an address in 198.18.0.0/15, the RFC 2544
 * benchmark range, which OpenClaw's SSRF guard treats as special-use and
 * blocks. On such a network `web_fetch` fails for every public site unless
 * that one range is allowed.
 */

/** Public names that never legitimately resolve into the benchmark range. */
const PROBE_HOSTNAMES = ['www.example.com', 'www.microsoft.com'] as const;
const PROBE_TIMEOUT_MS = 1000;

type LookupAddress = (hostname: string) => Promise<string>;
type ListInterfaceAddresses = () => string[];

let fakeIpDnsDetected = false;

/** True for IPv4 addresses in 198.18.0.0/15. */
export const isRfc2544BenchmarkAddress = (address: string): boolean => {
  const match = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address.trim());
  if (!match) return false;
  return Number(match[1]) === 198 && (Number(match[2]) === 18 || Number(match[2]) === 19);
};

const listInterfaceAddresses: ListInterfaceAddresses = () => (
  Object.values(os.networkInterfaces())
    .flatMap(entries => entries ?? [])
    .map(entry => entry.address)
);

const lookupIpv4: LookupAddress = async hostname => (await lookup(hostname, { family: 4 })).address;

/**
 * TUN-mode proxies give their virtual interface an address in the benchmark
 * range, so this notices a proxy switched on after the last DNS probe.
 */
export const hasFakeIpInterface = (
  listAddresses: ListInterfaceAddresses = listInterfaceAddresses,
): boolean => {
  try {
    return listAddresses().some(isRfc2544BenchmarkAddress);
  } catch {
    return false;
  }
};

/** Resolve the probe names and remember whether DNS answers with fake IPs. */
export const refreshFakeIpNetworkState = async (
  lookupAddress: LookupAddress = lookupIpv4,
): Promise<boolean> => {
  const probes = PROBE_HOSTNAMES.map(async hostname => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const address = await Promise.race([
        lookupAddress(hostname),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('DNS probe timed out')), PROBE_TIMEOUT_MS);
        }),
      ]);
      return isRfc2544BenchmarkAddress(address);
    } catch {
      // Offline or filtered DNS says nothing about fake IPs.
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  const detected = (await Promise.all(probes)).some(Boolean);
  if (detected !== fakeIpDnsDetected) {
    console.log(`[FakeIpNetwork] Fake-IP DNS ${detected ? 'detected' : 'no longer detected'}.`);
  }
  fakeIpDnsDetected = detected;
  return detected;
};

export const isFakeIpNetworkActive = (
  listAddresses?: ListInterfaceAddresses,
): boolean => fakeIpDnsDetected || hasFakeIpInterface(listAddresses);

export const __fakeIpNetworkTestUtils = {
  reset: (): void => {
    fakeIpDnsDetected = false;
  },
};
