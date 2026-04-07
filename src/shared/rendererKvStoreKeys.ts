/**
 * KV keys the renderer may read/write via store:get / store:set / store:remove.
 * All other keys (e.g. auth_tokens, enterprise_config) are main-process only.
 */
export const RendererKvStoreKey = {
  AppConfig: 'app_config',
  ProvidersExportKey: 'providers_export_key',
  PrivacyAgreed: 'privacy_agreed',
} as const;

export type RendererKvStoreKey =
  (typeof RendererKvStoreKey)[keyof typeof RendererKvStoreKey];

const ALLOWED = new Set<string>(Object.values(RendererKvStoreKey));

export function isAllowedRendererKvStoreKey(key: unknown): key is string {
  return typeof key === 'string' && ALLOWED.has(key);
}
