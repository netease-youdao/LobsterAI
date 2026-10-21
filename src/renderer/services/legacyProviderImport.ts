import { decryptSecret, decryptWithPassword } from './encryption';
import { decodeProviderTransferBytes } from './providerTransferCrypto';
import {
  isTransferRecord,
  ProviderTransferError,
  ProviderTransferErrorCode,
  ProviderTransferVersion,
  requireTransfer,
} from './providerTransferTypes';

// Public historical password. Read-only compatibility; never use for new exports.
const LEGACY_V2_PASSWORD = 'lobsterai-APP';

export const decryptLegacyProviderKey = async (
  entry: Record<string, unknown>,
  version: number,
): Promise<string | undefined> => {
  if (typeof entry.apiKey === 'string') return entry.apiKey;
  let payload = entry.apiKey;
  if (payload === undefined && (entry.apiKeyEncrypted !== undefined || entry.apiKeyIv !== undefined)) {
    requireTransfer(version === ProviderTransferVersion.LocalKey);
    payload = { encrypted: entry.apiKeyEncrypted, iv: entry.apiKeyIv };
  }
  if (payload === undefined) return undefined;
  requireTransfer(isTransferRecord(payload));
  requireTransfer(decodeProviderTransferBytes(payload.encrypted).length >= 16);
  decodeProviderTransferBytes(payload.iv, 12);
  const encrypted = payload.encrypted as string;
  const iv = payload.iv as string;
  try {
    if (version === ProviderTransferVersion.LegacyPassword) {
      decodeProviderTransferBytes(payload.salt, 16);
      return await decryptWithPassword({ encrypted, iv, salt: payload.salt as string }, LEGACY_V2_PASSWORD);
    }
    return await decryptSecret({ encrypted, iv });
  } catch (error) {
    if (error instanceof ProviderTransferError) throw error;
    throw new ProviderTransferError(version === ProviderTransferVersion.LocalKey
      ? ProviderTransferErrorCode.LegacyDecryptFailed : ProviderTransferErrorCode.DecryptFailed);
  }
};
