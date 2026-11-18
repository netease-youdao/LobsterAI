import net from 'net';

/**
 * In-process loopback self-test: listen on 127.0.0.1 and connect to it.
 *
 * Windows Defender Firewall's "Query user" default block drops inbound
 * connections, 127.0.0.1 included, to programs that have no inbound allow
 * rule. The block applies to the listening program, and the OpenClaw gateway
 * runs as this same executable, so a dropped self-test means the gateway's
 * /startupz probe could only ever report "fetch failed" until the boot
 * timeout (field case 2026-10). libuv turns off SYN retransmission for
 * loopback connects on Windows, so a dropped connect fails with ETIMEDOUT
 * within about 300 ms instead of hanging.
 */

export const LoopbackSelfTestOutcome = {
  Ok: 'ok',
  /** The connect to our own listener was dropped. */
  Blocked: 'blocked',
  /** The test could not run, or failed in a way a firewall rule cannot fix. */
  Inconclusive: 'inconclusive',
} as const;

export type LoopbackSelfTestOutcome =
  typeof LoopbackSelfTestOutcome[keyof typeof LoopbackSelfTestOutcome];

export interface LoopbackSelfTestResult {
  outcome: LoopbackSelfTestOutcome;
  /** Socket error code, or LOOPBACK_SELF_TEST_TIMEOUT_CODE when the timer fired. */
  code?: string;
  elapsedMs: number;
}

export const LOOPBACK_SELF_TEST_TIMEOUT_CODE = 'TIMEOUT';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 500;

export interface LoopbackSelfTestOptions {
  timeoutMs?: number;
  /** Test seam for the client side of the connection. */
  connect?: (port: number, host: string) => net.Socket;
}

const readErrorCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code ? code : 'UNKNOWN';
};

export function runLoopbackSelfTest(options: LoopbackSelfTestOptions = {}): Promise<LoopbackSelfTestResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connect = options.connect ?? ((port: number, host: string) => net.connect({ port, host }));
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const server = net.createServer();
    let client: net.Socket | null = null;
    let accepted: net.Socket | null = null;
    let connected = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (outcome: LoopbackSelfTestOutcome, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      accepted?.destroy();
      server.close();
      resolve({ outcome, ...(code ? { code } : {}), elapsedMs: Date.now() - startedAt });
    };
    const finishIfAccepted = () => {
      if (connected && accepted) finish(LoopbackSelfTestOutcome.Ok);
    };

    timer = setTimeout(() => {
      // A stalled event loop can run this timer before an already completed
      // connect is processed; give the poll phase one turn before deciding.
      setImmediate(() => finish(
        client && !connected ? LoopbackSelfTestOutcome.Blocked : LoopbackSelfTestOutcome.Inconclusive,
        LOOPBACK_SELF_TEST_TIMEOUT_CODE,
      ));
    }, timeoutMs);

    server.on('connection', (socket) => {
      accepted = socket;
      socket.on('error', () => { /* finish() destroys it */ });
      finishIfAccepted();
    });
    server.on('error', (error) => finish(LoopbackSelfTestOutcome.Inconclusive, readErrorCode(error)));
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(LoopbackSelfTestOutcome.Inconclusive, 'NO_ADDRESS');
        return;
      }
      client = connect(address.port, LOOPBACK_HOST);
      client.on('connect', () => {
        connected = true;
        finishIfAccepted();
      });
      client.on('error', (error) => {
        const code = readErrorCode(error);
        // Refusals or resets come from somewhere else; only a drop is the
        // firewall default an allow rule fixes.
        finish(code === 'ETIMEDOUT' ? LoopbackSelfTestOutcome.Blocked : LoopbackSelfTestOutcome.Inconclusive, code);
      });
    });
  });
}

export interface LoopbackBlockCheck {
  blocked: boolean;
  attempts: number;
  last: LoopbackSelfTestResult;
}

export interface DetectLoopbackBlockOptions {
  attempts?: number;
  retryDelayMs?: number;
  selfTest?: () => Promise<LoopbackSelfTestResult>;
}

/**
 * Reports a block only when every attempt was dropped, so one stalled attempt
 * on a busy machine cannot stop the engine from starting.
 */
export async function detectLoopbackBlock(options: DetectLoopbackBlockOptions = {}): Promise<LoopbackBlockCheck> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const selfTest = options.selfTest ?? (() => runLoopbackSelfTest());
  let last: LoopbackSelfTestResult = { outcome: LoopbackSelfTestOutcome.Inconclusive, elapsedMs: 0 };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await selfTest();
    if (last.outcome !== LoopbackSelfTestOutcome.Blocked) {
      return { blocked: false, attempts: attempt, last };
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  return { blocked: true, attempts, last };
}
