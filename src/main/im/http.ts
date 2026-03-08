import { app, session } from 'electron';

// Fallback for cases where Electron session is not ready yet.
const nodeFetch = require('node-fetch');

function linkAbortSignal(source: AbortSignal, controller: AbortController): void {
  if (source.aborted) {
    controller.abort();
    return;
  }
  source.addEventListener('abort', () => controller.abort(), { once: true });
}

export async function fetchWithSystemProxy(url: string, options: RequestInit = {}): Promise<Response> {
  if (app.isReady()) {
    try {
      return await session.defaultSession.fetch(url, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[IM HTTP] session fetch failed, fallback to node-fetch: ${message}`);
    }
  }

  return nodeFetch(url, options);
}

export async function fetchJsonWithTimeout<T>(
  url: string,
  options: RequestInit = {},
  timeoutMs = 10_000
): Promise<T> {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  if (options.signal) {
    linkAbortSignal(options.signal, timeoutController);
  }

  try {
    const response = await fetchWithSystemProxy(url, {
      ...options,
      signal: timeoutController.signal,
    });

    const rawText = await response.text();
    let data: unknown = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        throw new Error(`Expected JSON response but got: ${rawText.slice(0, 120)}`);
      }
    }

    if (!response.ok) {
      const payload = data as { description?: string; message?: string } | null;
      const detail = payload?.description || payload?.message || rawText || response.statusText || 'request failed';
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    return data as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
