import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { isUsableLoopbackPort } from './loopbackListen';

export const OPENCLAW_LOOPBACK_STATE_FILE = 'loopback-state.json';

export const OpenClawLoopbackService = {
  TokenProxy: 'tokenProxy',
  CompatProxy: 'compatProxy',
  McpBridge: 'mcpBridge',
} as const;
export type OpenClawLoopbackService = typeof OpenClawLoopbackService[keyof typeof OpenClawLoopbackService];

const LOOPBACK_STATE_VERSION = 1;
const MIN_SECRET_LENGTH = 32;

type LoopbackStateFile = {
  version: typeof LOOPBACK_STATE_VERSION;
  appVersion: string;
  proxyToken: string;
  mcpBridgeSecret: string;
  ports: Partial<Record<OpenClawLoopbackService, number>>;
};

export type OpenClawLoopbackSecretFactory = {
  proxyToken: () => string;
  mcpBridgeSecret: () => string;
};

const defaultSecretFactory: OpenClawLoopbackSecretFactory = {
  proxyToken: () => crypto.randomBytes(24).toString('hex'),
  mcpBridgeSecret: () => crypto.randomUUID(),
};

const isSecret = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length >= MIN_SECRET_LENGTH;

function sanitizePorts(value: unknown): LoopbackStateFile['ports'] {
  const ports: LoopbackStateFile['ports'] = {};
  if (!value || typeof value !== 'object') return ports;
  for (const service of Object.values(OpenClawLoopbackService)) {
    const port = (value as Record<string, unknown>)[service];
    if (isUsableLoopbackPort(port)) ports[service] = port;
  }
  return ports;
}

function readLoopbackState(filePath: string): LoopbackStateFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<LoopbackStateFile>;
    if (parsed?.version !== LOOPBACK_STATE_VERSION || typeof parsed.appVersion !== 'string'
      || !isSecret(parsed.proxyToken) || !isSecret(parsed.mcpBridgeSecret)) {
      return null;
    }
    return {
      version: LOOPBACK_STATE_VERSION,
      appVersion: parsed.appVersion,
      proxyToken: parsed.proxyToken,
      mcpBridgeSecret: parsed.mcpBridgeSecret,
      ports: sanitizePorts(parsed.ports),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[OpenClawLoopback] ignoring unreadable loopback state:', error);
    }
    return null;
  }
}

/**
 * Loopback ports and secrets that are rendered into openclaw.json. OpenClaw
 * fingerprints the env-substituted config for its startup-migration checkpoint,
 * so values regenerated on every launch rerun its migrations on every start.
 * The secrets keep the gateway-token protection level and rotate with the app
 * version; ports are reused while they stay free.
 */
export class OpenClawLoopbackState {
  private state: LoopbackStateFile;

  constructor(
    private readonly filePath: string,
    appVersion: string,
    secretFactory: OpenClawLoopbackSecretFactory = defaultSecretFactory,
  ) {
    const loaded = readLoopbackState(filePath);
    const current = loaded?.appVersion === appVersion ? loaded : null;
    this.state = {
      version: LOOPBACK_STATE_VERSION,
      appVersion,
      proxyToken: current?.proxyToken ?? secretFactory.proxyToken(),
      mcpBridgeSecret: current?.mcpBridgeSecret ?? secretFactory.mcpBridgeSecret(),
      ports: loaded?.ports ?? {},
    };
    if (!current) {
      console.log(`[OpenClawLoopback] ${loaded ? 'rotated' : 'created'} loopback secrets for app ${appVersion}`);
      this.persist();
    }
  }

  get proxyToken(): string {
    return this.state.proxyToken;
  }

  get mcpBridgeSecret(): string {
    return this.state.mcpBridgeSecret;
  }

  getPreferredPort(service: OpenClawLoopbackService): number | undefined {
    return this.state.ports[service];
  }

  rememberPort(service: OpenClawLoopbackService, port: number): void {
    if (!isUsableLoopbackPort(port) || this.state.ports[service] === port) return;
    this.state = { ...this.state, ports: { ...this.state.ports, [service]: port } };
    this.persist();
  }

  private persist(): void {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      // In-memory values still work for this launch; only cross-launch reuse is lost.
      console.warn('[OpenClawLoopback] failed to persist loopback state:', error);
      try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    }
  }
}
