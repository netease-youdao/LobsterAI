import { app } from 'electron';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

import {
  OPENCLAW_XAI_AUTH_STORE_ENTRY,
  type OpenClawXaiAuthStore,
  XaiAuthStoreErrorCode,
} from '../../shared/openclawEngine/xaiAuthStore';
import { t } from '../i18n';

const runtimeRequire = createRequire(__filename);

export function getOpenClawXaiAuthStore(): OpenClawXaiAuthStore {
  const roots = app.isPackaged
    ? [path.join(process.resourcesPath, 'cfmind')]
    : [app.getAppPath(), process.cwd()].map(root => path.join(root, 'vendor', 'openclaw-runtime', 'current'));
  const entry = roots.map(root => path.join(root, OPENCLAW_XAI_AUTH_STORE_ENTRY)).find(file => fs.existsSync(file));
  if (!entry) throw new Error(t('openClawRuntimeFilesMissing'));
  // Electron's pinned Node supports synchronous ESM loading. The owner has no
  // top-level await; require caches its schema/module graph, not login status.
  const owner = runtimeRequire(entry) as OpenClawXaiAuthStore;
  const run = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      if ((error as { code?: string }).code === XaiAuthStoreErrorCode.MigrationPending) {
        throw new Error(t('xaiAuthMigrationPending'));
      }
      console.error('[XaiAuth] canonical auth store operation failed:', error);
      throw new Error(t('xaiAuthStoreFailed'));
    }
  };
  return {
    readStatus: stateDir => run(() => owner.readStatus(stateDir)),
    replaceCredential: (stateDir, profileId, credential) => run(() => owner.replaceCredential(stateDir, profileId, credential)),
    logout: stateDir => run(() => owner.logout(stateDir)),
  };
}

export function getOpenClawXaiStateDir(): string {
  return path.join(app.getPath('userData'), 'openclaw', 'state');
}
