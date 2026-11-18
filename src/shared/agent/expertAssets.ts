// Public CDN origins used by the expert configuration publisher (Luna NOS).
const EXPERT_CDN_HOSTS = new Set(['shared.ydstatic.com', 'ydhardwarecommon.nosdn.127.net']);

export function isExpertAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && EXPERT_CDN_HOSTS.has(url.hostname)
      && !url.port && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
