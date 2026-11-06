import path from 'node:path';

import { NeteaseMailAuth, NeteaseMailAuthStoreOperation } from '../../shared/neteaseMail/constants';
import { getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';
import { clearNeteaseMailAuthorization, readNeteaseMailAuthorization, saveNeteaseMailAuthorization } from './neteaseMailAuthorizationState';
import type { NeteaseMailCredential } from './neteaseMailOAuth';

interface ProfileStore { profiles: Record<string, NeteaseMailCredential>; usageStats?: Record<string, unknown> }
interface AuthSdk {
  ensureAuthProfileStore: (agentDir: undefined, options: object) => ProfileStore;
  upsertAuthProfileWithLock: (params: object) => Promise<ProfileStore | null>;
  updateAuthProfileStoreWithLock: (params: { stateDir: string; sharedStoreWrite: true; updater: (store: ProfileStore) => boolean }) => Promise<ProfileStore | null>;
}

// Run in a short-lived Electron Node child: OpenClaw's ambient environment and
// SQLite snapshots must never leak into the Electron process or another profile.
async function run(): Promise<void> {
  const sdk = require(path.join(process.argv[2], 'dist', 'plugin-sdk', 'provider-auth.js')) as AuthSdk;
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 128_000) throw new Error('Invalid auth store request');
  }
  const request = JSON.parse(input) as { operation: string; credential?: NeteaseMailCredential };
  const stateDir = process.env.OPENCLAW_STATE_DIR!;
  if (request.operation === NeteaseMailAuthStoreOperation.Initialize) {
    // Select the canonical shared store before the gateway pins its owner. The
    // SDK preserves existing legacy stores; this must not replace any profiles.
    const result = await sdk.updateAuthProfileStoreWithLock({
      stateDir, sharedStoreWrite: true, updater: () => false,
    });
    if (!result) throw new Error('Auth store initialization failed');
  } else if (request.operation === NeteaseMailAuthStoreOperation.Save) {
    const credential = request.credential;
    if (credential?.type !== NeteaseMailAuth.CredentialType || credential.provider !== NeteaseMailAuth.Provider
      || !credential.access || !credential.refresh || !Number.isFinite(credential.expires)) throw new Error('Invalid credential');
    // Invalidate old confirmations before changing account credentials. A failed
    // write must never leave an old grant attached to a new account.
    clearNeteaseMailAuthorization(stateDir);
    const result = await sdk.upsertAuthProfileWithLock({ stateDir, profileId: NeteaseMailAuth.ProfileId, credential });
    if (!result) throw new Error('Auth store update failed');
    saveNeteaseMailAuthorization(stateDir, credential);
  } else if (request.operation === NeteaseMailAuthStoreOperation.Remove) {
    clearNeteaseMailAuthorization(stateDir);
    const result = await sdk.updateAuthProfileStoreWithLock({
      stateDir, sharedStoreWrite: true,
      updater: store => {
        delete store.profiles[NeteaseMailAuth.ProfileId];
        if (store.usageStats) delete store.usageStats[NeteaseMailAuth.ProfileId];
        return true;
      },
    });
    if (!result) throw new Error('Auth store update failed');
  } else if (request.operation !== NeteaseMailAuthStoreOperation.Status) throw new Error('Invalid operation');
  const store = sdk.ensureAuthProfileStore(undefined, { readOnly: true, syncExternalCli: false, externalCliProviderIds: [] });
  const credential = store.profiles[NeteaseMailAuth.ProfileId];
  const connected = credential?.provider === NeteaseMailAuth.Provider && credential.type === NeteaseMailAuth.CredentialType
    && Boolean(credential.access && credential.refresh);
  // Only this deliberately small status crosses back to Electron. No tokens/logged errors.
  const authorization = credential && readNeteaseMailAuthorization(stateDir, credential.clientId);
  process.stdout.write(`\nNETEASE_MAIL_STATUS:${JSON.stringify({ connected,
    ...(connected ? { expiresAt: credential.expires, scopes: authorization?.scopes ?? getNeteaseMailScopes() } : {}) })}\n`);
}

if (require.main === module) {
  void run().then(() => process.exit(0), () => process.exit(1));
}
