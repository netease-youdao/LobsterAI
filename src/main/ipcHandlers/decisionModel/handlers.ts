// IPC + tool wiring for the experimental Jev decision model. The API key never
// enters openclaw.json: OpenClaw reaches the model only through the loopback
// bridge, and main makes the provider request. Keeps all decision model wiring
// out of main.ts except one register call.

import { ipcMain, session } from 'electron';

import {
  DECISION_MODEL_CONFIG_STORE_KEY,
  DecisionModelIpcChannel,
} from '../../../shared/decisionModel/constants';
import { type DecisionFetch, testDecisionModelConnection } from '../../libs/decisionModelClient';
import {
  applyDecisionModelConfigUpdate,
  type DecisionModelConfig,
  isDecisionModelActive,
  normalizeDecisionModelConfig,
  toDecisionModelConfigView,
} from '../../libs/decisionModelConfig';
import { handleDecisionToolRequest } from '../../libs/decisionModelTool';
import type { DecisionToolHandler } from '../../libs/mcpBridgeServer';

export interface DecisionModelStoreLike {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

export interface DecisionModelHandlerDeps {
  getStore: () => DecisionModelStoreLike;
  setDecisionToolHandler: (handler: DecisionToolHandler) => void;
  syncOpenClawConfig: (options: { reason: string; restartGatewayIfRunning?: boolean }) => Promise<unknown>;
}

export function readDecisionModelConfig(store: DecisionModelStoreLike): DecisionModelConfig {
  return normalizeDecisionModelConfig(store.get(DECISION_MODEL_CONFIG_STORE_KEY));
}

export function isDecisionModelFeatureActive(store: DecisionModelStoreLike): boolean {
  return isDecisionModelActive(readDecisionModelConfig(store));
}

// Chromium's network stack applies the app's proxy settings, which most
// users need to reach TypeSafe or OpenRouter.
const sessionFetch: DecisionFetch = (url, init) => session.defaultSession.fetch(url, init);

export function registerDecisionModelHandlers(deps: DecisionModelHandlerDeps): void {
  deps.setDecisionToolHandler((request, signal) => handleDecisionToolRequest(request, {
    getConfig: () => readDecisionModelConfig(deps.getStore()),
    fetch: sessionFetch,
  }, signal));

  ipcMain.handle(DecisionModelIpcChannel.GetConfig, () => (
    toDecisionModelConfigView(readDecisionModelConfig(deps.getStore()))
  ));

  ipcMain.handle(DecisionModelIpcChannel.SaveConfig, async (_event, update: unknown) => {
    const store = deps.getStore();
    const previous = readDecisionModelConfig(store);
    const next = applyDecisionModelConfigUpdate(previous, update);
    store.set(DECISION_MODEL_CONFIG_STORE_KEY, next);

    // The key and provider are read on every call, so only switching the
    // tool on or off touches openclaw.json (and restarts the gateway once).
    const active = isDecisionModelActive(next);
    if (isDecisionModelActive(previous) !== active) {
      console.log(`[DecisionModel] decision_evaluate ${active ? 'enabled' : 'disabled'}, syncing OpenClaw config`);
      try {
        await deps.syncOpenClawConfig({ reason: 'decision-model-toggle', restartGatewayIfRunning: true });
      } catch (error) {
        console.error('[DecisionModel] failed to sync OpenClaw config after toggle:', error);
      }
    }
    return toDecisionModelConfigView(next);
  });

  ipcMain.handle(DecisionModelIpcChannel.TestConnection, async (_event, draft: unknown) => {
    const candidate = applyDecisionModelConfigUpdate(readDecisionModelConfig(deps.getStore()), draft);
    return testDecisionModelConnection(candidate, { fetch: sessionFetch });
  });
}
