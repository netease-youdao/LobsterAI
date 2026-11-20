// Engine-independent xAI OAuth credential store persisted under userData.
// Replaces the legacy OpenClaw runtime-coupled xAI auth store so xAI OAuth
// works cleanly under DeepSeek Harness with zero OpenClaw runtime dependency.

import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import {
  type OpenClawXaiAuthStore,
  type XaiOAuthCredential,
  type XaiOAuthStatus,
} from '../../shared/openclawEngine/xaiAuthStore';

const XAI_AUTH_FILENAME = 'xai-oauth.json';

interface StoredXaiAuthPayload {
  profileId?: string;
  credential?: XaiOAuthCredential;
  updatedAt?: number;
}

function getXaiAuthFilePath(stateDir: string): string {
  return path.join(stateDir, XAI_AUTH_FILENAME);
}

function readStoredPayload(stateDir: string): StoredXaiAuthPayload | null {
  try {
    const raw = fs.readFileSync(getXaiAuthFilePath(stateDir), 'utf8');
    const parsed = JSON.parse(raw) as StoredXaiAuthPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readStoredXaiCredential(stateDir?: string): XaiOAuthCredential | null {
  const dir = stateDir ?? getOpenClawXaiStateDir();
  const payload = readStoredPayload(dir);
  const cred = payload?.credential;
  if (!cred || typeof cred.access !== 'string' || !cred.access.trim()) {
    return null;
  }
  return cred;
}

export function getOpenClawXaiAuthStore(): OpenClawXaiAuthStore {
  return {
    readStatus(stateDir: string): XaiOAuthStatus {
      const cred = readStoredXaiCredential(stateDir);
      if (!cred) {
        return { loggedIn: false };
      }
      return {
        loggedIn: true,
        email: typeof cred.email === 'string' ? cred.email : undefined,
        displayName: typeof cred.displayName === 'string' ? cred.displayName : undefined,
        expiresAt: typeof cred.expires === 'number' ? cred.expires : undefined,
      };
    },

    replaceCredential(stateDir: string, profileId: string, credential: XaiOAuthCredential): void {
      fs.mkdirSync(stateDir, { recursive: true });
      const filePath = getXaiAuthFilePath(stateDir);
      const tmpPath = `${filePath}.tmp`;
      const payload: StoredXaiAuthPayload = {
        profileId,
        credential,
        updatedAt: Date.now(),
      };
      fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmpPath, filePath);
    },

    logout(stateDir: string): void {
      const filePath = getXaiAuthFilePath(stateDir);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
      }
    },
  };
}

export function getOpenClawXaiStateDir(): string {
  return path.join(app.getPath('userData'), 'auth');
}
