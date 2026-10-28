/**
 * True when `hostname` is `domain` itself or one of its subdomains.
 * Prefer this over substring checks such as `host.includes('github.com')`,
 * which also match hosts like `github.com.evil.example`.
 */
export function isHostnameOnDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const target = domain.toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

/**
 * True when `url` parses as an absolute URL whose hostname is `domain` or one
 * of its subdomains. A domain that only appears in the path or query string,
 * or that is followed by another host label, does not match.
 */
export function isUrlOnDomain(url: string, domain: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return isHostnameOnDomain(hostname, domain);
}
