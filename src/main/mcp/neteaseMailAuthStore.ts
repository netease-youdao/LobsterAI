import { spawn } from 'node:child_process';
import path from 'node:path';

import { NeteaseMailAuthStoreOperation, NeteaseMailFailure } from '../../shared/neteaseMail/constants';
import type { McpOAuthCliContext } from './mcpOAuthCli';
import { type NeteaseMailCredential, NeteaseMailOAuthError } from './neteaseMailOAuth';

export interface NeteaseMailAuthStatus { connected: boolean; expiresAt?: number }
export interface NeteaseMailAuthStore {
  status(): Promise<NeteaseMailAuthStatus>;
  save(credential: NeteaseMailCredential): Promise<void>;
  remove(): Promise<void>;
}

export function createNeteaseMailAuthStore(context: McpOAuthCliContext): NeteaseMailAuthStore {
  const run = (operation: string, credential?: NeteaseMailCredential) => new Promise<NeteaseMailAuthStatus>((resolve, reject) => {
    const child = spawn(context.electronNodeRuntimePath, [path.join(__dirname, 'neteaseMailAuthStoreWorker.js'), context.runtimeRoot], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENCLAW_NO_RESPAWN: '1',
        OPENCLAW_HOME: path.dirname(context.stateDir), OPENCLAW_STATE_DIR: context.stateDir,
        OPENCLAW_CONFIG_PATH: path.join(context.stateDir, 'openclaw.json'), OPENCLAW_AGENT_DIR: '',
      },
    });
    const timeout = setTimeout(() => child.kill(), 30_000);
    let output = '';
    child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-16_384); });
    child.stderr.resume(); // SDK diagnostics may contain credential material. Never forward them.
    const failed = () => reject(new NeteaseMailOAuthError(NeteaseMailFailure.StorageFailed));
    child.on('error', () => { clearTimeout(timeout); failed(); });
    child.stdin.on('error', () => { /* handled by the child's exit status */ });
    child.on('close', code => {
      clearTimeout(timeout);
      const line = output.split(/\r?\n/).findLast(value => value.startsWith('NETEASE_MAIL_STATUS:'));
      if (code !== 0 || !line) { failed(); return; }
      try {
        const value = JSON.parse(line.slice('NETEASE_MAIL_STATUS:'.length)) as NeteaseMailAuthStatus;
        resolve({ connected: value.connected === true, ...(typeof value.expiresAt === 'number' ? { expiresAt: value.expiresAt } : {}) });
      } catch { failed(); }
    });
    child.stdin.end(JSON.stringify({ operation, credential }));
  });
  return {
    status: () => run(NeteaseMailAuthStoreOperation.Status),
    save: async credential => { await run(NeteaseMailAuthStoreOperation.Save, credential); },
    remove: async () => { await run(NeteaseMailAuthStoreOperation.Remove); },
  };
}
