import type {
  OllamaChatChunk,
  OllamaChatPayload,
  OllamaModel,
  OllamaModelLaunchInput,
  OllamaModelLaunchResult,
  OllamaRunningModel,
} from '../../shared/ollama';

type StreamCallback<T> = (chunk: T) => void;
type RequestOptions = { signal?: AbortSignal };

export class OllamaClient {
  private readonly baseUrl: string;

  constructor(baseUrl = 'http://127.0.0.1:11434') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async version(timeoutMs = 300): Promise<{ version?: string }> {
    return await this.requestJson('/api/version', { method: 'GET', timeoutMs });
  }

  async listModels(): Promise<OllamaModel[]> {
    const payload = await this.requestJson<{ models?: OllamaModel[] }>('/api/tags', { method: 'GET' });
    return payload.models ?? [];
  }

  async runningModels(timeoutMs = 30_000): Promise<OllamaRunningModel[]> {
    const payload = await this.requestJson<{ models?: OllamaRunningModel[] }>('/api/ps', { method: 'GET', timeoutMs });
    return payload.models ?? [];
  }

  async showModel(name: string): Promise<unknown> {
    return await this.requestJson('/api/show', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async deleteModel(name: string): Promise<void> {
    await this.requestJson('/api/delete', {
      method: 'DELETE',
      body: JSON.stringify({ name }),
    });
  }

  async createModel(
    name: string,
    modelfile: string,
    onProgress?: StreamCallback<Record<string, unknown>>,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.requestNdjson('/api/create', {
      method: 'POST',
      body: JSON.stringify({ name, modelfile, stream: Boolean(onProgress) }),
      signal: options.signal,
    }, onProgress);
  }

  async pullModel(
    name: string,
    onProgress?: StreamCallback<Record<string, unknown>>,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.requestNdjson('/api/pull', {
      method: 'POST',
      body: JSON.stringify({ name, stream: Boolean(onProgress) }),
      signal: options.signal,
    }, onProgress);
  }

  async preloadModel(input: OllamaModelLaunchInput): Promise<OllamaModelLaunchResult> {
    await this.requestJson('/api/generate', {
      method: 'POST',
      timeoutMs: 300_000,
      body: JSON.stringify({
        model: input.model,
        prompt: '',
        stream: false,
        keep_alive: input.keep_alive ?? -1,
        ...(input.options ? { options: input.options } : {}),
      }),
    });
    let runningModels: OllamaRunningModel[] = [];
    try {
      runningModels = await this.runningModels();
    } catch (error) {
      console.warn('[Ollama] failed to list running models after preload:', error);
    }
    return { success: true, runningModels };
  }

  async unloadModel(name: string, timeoutMs = 120_000): Promise<void> {
    await this.requestJson('/api/generate', {
      method: 'POST',
      timeoutMs,
      body: JSON.stringify({
        model: name,
        prompt: '',
        stream: false,
        keep_alive: 0,
      }),
    });
  }

  async chat(
    payload: OllamaChatPayload,
    onChunk?: StreamCallback<OllamaChatChunk>,
    options: RequestOptions = {},
  ): Promise<OllamaChatChunk | void> {
    if (payload.stream === false || !onChunk) {
      return await this.requestJson<OllamaChatChunk>('/api/chat', {
        method: 'POST',
        body: JSON.stringify({ ...payload, stream: false }),
        signal: options.signal,
      });
    }

    let sawDone = false;
    await this.requestNdjson<OllamaChatChunk>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ ...payload, stream: true }),
      signal: options.signal,
    }, (chunk) => {
      sawDone = Boolean(chunk.done || sawDone);
      onChunk(chunk);
    });
    if (!sawDone) {
      throw new Error('Ollama chat stream ended without a done chunk');
    }
  }

  private async requestJson<T>(
    path: string,
    options: RequestInit & { timeoutMs?: number },
  ): Promise<T> {
    const response = await this.fetch(path, options);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  private async requestNdjson<T>(
    path: string,
    options: RequestInit & { timeoutMs?: number },
    onChunk?: StreamCallback<T>,
  ): Promise<void> {
    const response = await this.fetch(path, options);
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        this.emitNdjsonLine(line, onChunk);
      }
    }

    buffer += decoder.decode();
    this.emitNdjsonLine(buffer, onChunk);
  }

  private emitNdjsonLine<T>(line: string, onChunk?: StreamCallback<T>): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed) as T | { error?: unknown };
    if (isOllamaStreamError(parsed)) {
      throw new Error(parsed.error);
    }
    onChunk?.(parsed as T);
  }

  private async fetch(path: string, options: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) {
      abortFromExternal();
    } else {
      externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
      const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Ollama ${path} failed: HTTP ${response.status}${text ? ` ${text}` : ''}`);
      }
      return response;
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  }
}

function isOllamaStreamError(value: unknown): value is { error: string } {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { error?: unknown }).error === 'string',
  );
}
