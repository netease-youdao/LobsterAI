import type { Server } from 'net';

const MIN_PREFERRED_PORT = 1024;
const MAX_PORT = 65_535;
const FALLBACK_ERROR_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);

export function isUsableLoopbackPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= MIN_PREFERRED_PORT && port <= MAX_PORT;
}

function listenOnce(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error(`Loopback server on ${host} has no bound port`));
      }
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Bind a loopback server, reusing the previous port while it is free. Ports
 * rendered into openclaw.json must stay stable across launches, otherwise
 * OpenClaw's startup-migration checkpoint misses on every gateway start.
 */
export async function listenOnLoopback(
  server: Server,
  host: string,
  preferredPort?: number | null,
): Promise<{ port: number; reused: boolean }> {
  if (isUsableLoopbackPort(preferredPort)) {
    try {
      return { port: await listenOnce(server, host, preferredPort), reused: true };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !FALLBACK_ERROR_CODES.has(code)) throw error;
      console.warn(`[Loopback] preferred port ${preferredPort} on ${host} is unavailable (${code}); using an ephemeral port`);
    }
  }
  return { port: await listenOnce(server, host, 0), reused: false };
}
