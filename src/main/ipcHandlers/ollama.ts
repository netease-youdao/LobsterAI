import { BrowserWindow, ipcMain, shell } from 'electron';
import os from 'os';

import type {
  OllamaChatPayload,
  OllamaInstallProgress,
  OllamaModelLaunchInput,
  OllamaStatusSnapshot,
} from '../../shared/ollama';
import { OllamaIpcChannel } from '../../shared/ollama';
import { OllamaManager } from '../libs/ollamaManager';
import { buildOllamaOpenClawAppConfig, type OllamaOpenClawAppConfig } from '../libs/ollamaOpenClawBinding';
import type { SqliteStore } from '../sqliteStore';

export function registerOllamaIpcHandlers(
  manager: OllamaManager,
  options: {
    getStore: () => SqliteStore;
    syncOpenClawConfig: (options: { reason: string; restartGatewayIfRunning?: boolean }) => Promise<{ success: boolean; error?: string }>;
  },
): void {
  const broadcast = (channel: string, payload: unknown): void => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (win.isDestroyed()) return;
      win.webContents.send(channel, payload);
    });
  };
  const sendStatus = (status: OllamaStatusSnapshot) => broadcast(OllamaIpcChannel.StatusChanged, status);
  const sendProgress = (progress: OllamaInstallProgress) => broadcast(OllamaIpcChannel.InstallProgress, progress);

  manager.on('status', sendStatus);
  manager.on('install-progress', sendProgress);
  const activePulls = new Map<string, AbortController>();
  const activeChats = new Map<string, AbortController>();

  ipcMain.handle(OllamaIpcChannel.Status, async () => manager.detect());
  ipcMain.handle(OllamaIpcChannel.Install, async () => {
    const status = await manager.install();
    await shell.openExternal('https://ollama.com/download').catch((error) => {
      console.warn('[Ollama] failed to open download page:', error);
    });
    return status;
  });
  ipcMain.handle(OllamaIpcChannel.Start, async () => manager.start());
  ipcMain.handle(OllamaIpcChannel.Stop, async () => manager.stop());
  ipcMain.handle(OllamaIpcChannel.Restart, async () => manager.restart());
  ipcMain.handle(OllamaIpcChannel.ModelsDir, async () => {
    return process.env.OLLAMA_MODELS || `${os.homedir()}/.ollama/models`;
  });

  ipcMain.handle(OllamaIpcChannel.ListLocalModels, async () => {
    const client = await manager.client();
    return await client.listModels();
  });
  ipcMain.handle(OllamaIpcChannel.ListRunningModels, async () => {
    const client = await manager.client();
    return await client.runningModels();
  });
  ipcMain.handle(OllamaIpcChannel.DeleteModel, async (_event, name: string) => {
    const client = await manager.client();
    await client.deleteModel(name);
    return { success: true };
  });
  ipcMain.handle(OllamaIpcChannel.ShowModel, async (_event, name: string) => {
    const client = await manager.client();
    return await client.showModel(name);
  });
  ipcMain.handle(OllamaIpcChannel.CreateModel, async (_event, name: string, modelfile: string) => {
    const client = await manager.client();
    await client.createModel(name, modelfile);
    return { success: true };
  });
  ipcMain.handle(OllamaIpcChannel.PreloadModel, async (_event, input: OllamaModelLaunchInput) => {
    const modelName = input.model.trim();
    if (!modelName) throw new Error('Model name is required');
    const client = await manager.client();
    return await client.preloadModel({ ...input, model: modelName });
  });
  ipcMain.handle(OllamaIpcChannel.UnloadModel, async (_event, name: string) => {
    const modelName = name.trim();
    if (!modelName) throw new Error('Model name is required');
    const client = await manager.client();
    await client.unloadModel(modelName);
    return { success: true, runningModels: await client.runningModels() };
  });
  ipcMain.handle(OllamaIpcChannel.PullModel, async (_event, name: string) => {
    const modelName = name.trim();
    if (!modelName) throw new Error('Model name is required');
    if (activePulls.has(modelName)) {
      throw new Error(`Pull already in progress: ${modelName}`);
    }
    const controller = new AbortController();
    activePulls.set(modelName, controller);
    try {
      const client = await manager.client();
      await client.pullModel(modelName, (chunk) => {
        broadcast(OllamaIpcChannel.PullProgress, { name: modelName, chunk });
      }, { signal: controller.signal });
      broadcast(OllamaIpcChannel.PullProgress, { name: modelName, chunk: { status: 'success' } });
      return { success: true };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        broadcast(OllamaIpcChannel.PullProgress, { name: modelName, chunk: { status: 'cancelled' } });
        throw new Error('Pull cancelled', { cause: error });
      }
      throw error;
    } finally {
      activePulls.delete(modelName);
    }
  });
  ipcMain.handle(OllamaIpcChannel.CancelPull, async (_event, name: string) => {
    const modelName = name.trim();
    const controller = activePulls.get(modelName);
    if (!controller) return { success: true, cancelled: false };
    broadcast(OllamaIpcChannel.PullProgress, { name: modelName, chunk: { status: 'cancelling' } });
    controller.abort(new Error('Pull cancelled'));
    return { success: true, cancelled: true };
  });
  ipcMain.handle(OllamaIpcChannel.Chat, async (_event, payload: OllamaChatPayload) => {
    const client = await manager.client();
    return await client.chat({ ...payload, stream: false });
  });
  ipcMain.handle(OllamaIpcChannel.ChatStream, async (_event, requestId: string, payload: OllamaChatPayload) => {
    if (typeof requestId !== 'string' || !requestId.trim()) throw new Error('Request ID is required');
    if (activeChats.has(requestId)) throw new Error(`Chat stream already in progress: ${requestId}`);
    const controller = new AbortController();
    activeChats.set(requestId, controller);
    const client = await manager.client();
    try {
      await client.chat({ ...payload, stream: true }, (chunk) => {
        broadcast(OllamaIpcChannel.ChatStreamChunk, { requestId, chunk });
      }, { signal: controller.signal });
      return { success: true };
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new Error('Generation cancelled', { cause: error });
      }
      throw error;
    } finally {
      activeChats.delete(requestId);
    }
  });
  ipcMain.handle(OllamaIpcChannel.CancelChatStream, async (_event, requestId: string) => {
    const controller = activeChats.get(requestId);
    if (!controller) return { success: true, cancelled: false };
    controller.abort(new Error('Generation cancelled'));
    return { success: true, cancelled: true };
  });
  ipcMain.handle(OllamaIpcChannel.SetOpenClawModel, async (_event, modelName: string) => {
    const current = options.getStore().get<OllamaOpenClawAppConfig>('app_config') ?? {};
    const next = buildOllamaOpenClawAppConfig(current, modelName);
    options.getStore().set('app_config', next);
    const syncResult = await options.syncOpenClawConfig({
      reason: 'ollama-local-model-selected',
      restartGatewayIfRunning: true,
    });
    return { success: syncResult.success, error: syncResult.error };
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
