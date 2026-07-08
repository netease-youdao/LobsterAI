import { ipcMain } from 'electron';

import type { CoworkStore } from '../../coworkStore';
import {
  classifyPluginConfigChange,
  OpenClawConfigImpact,
  OpenClawPluginChangeAction,
} from '../../libs/openclawConfigImpact';

export interface PluginHandlerDeps {
  getCoworkStore: () => CoworkStore;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<{ success: boolean; changed: boolean }>;
}

export function registerPluginHandlers(deps: PluginHandlerDeps): void {
  const { getCoworkStore, syncOpenClawConfig } = deps;

  ipcMain.handle('plugins:list', async () => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      return { success: true, plugins: await manager.listPlugins() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list plugins' };
    }
  });

  ipcMain.handle('plugins:sync', async () => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      const result = await manager.syncPluginsFromOpenClaw();
      return result;
    } catch (error) {
      console.error('[plugins:sync] error:', error);
      return { synced: [], error: error instanceof Error ? error.message : 'Failed to sync plugins' };
    }
  });

  ipcMain.handle('plugins:detect', async () => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      const result = manager.detectPluginsFromOpenClaw();
      return result;
    } catch (error) {
      console.error('[plugins:detect] error:', error);
      return { plugins: [], error: error instanceof Error ? error.message : 'Failed to detect plugins' };
    }
  });

  ipcMain.handle('plugins:install', async (event, params: {
    source: 'npm' | 'clawhub' | 'git' | 'local';
    spec: string;
    registry?: string;
    version?: string;
  }) => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      const sender = event.sender;
      const sendLog = (line: string) => {
        try { sender.send('plugins:install-log', line); } catch { /* window closed */ }
      };
      const result = await manager.installPlugin(params, sendLog);
      if (result.ok) {
        sendLog('Syncing gateway config...\n');
        const impactDecision = classifyPluginConfigChange(OpenClawPluginChangeAction.Install);
        await syncOpenClawConfig({
          reason: 'plugin-install',
          restartGatewayIfRunning: impactDecision.impact === OpenClawConfigImpact.Restart,
        });
        sendLog('Gateway config synced.\n');
      }
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to install plugin' };
    }
  });

  ipcMain.handle('plugins:uninstall', async (_event, pluginId: string) => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      const result = await manager.uninstallPlugin(pluginId);
      if (result.ok) {
        const impactDecision = classifyPluginConfigChange(OpenClawPluginChangeAction.Uninstall);
        await syncOpenClawConfig({
          reason: 'plugin-uninstall',
          restartGatewayIfRunning: impactDecision.impact === OpenClawConfigImpact.Restart,
        });
      }
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to uninstall plugin' };
    }
  });

  ipcMain.handle('plugins:set-enabled', async (_event, pluginId: string, enabled: boolean) => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      manager.setPluginEnabled(pluginId, enabled);
      const impactDecision = classifyPluginConfigChange(OpenClawPluginChangeAction.Toggle);
      await syncOpenClawConfig({
        reason: 'plugin-toggle',
        restartGatewayIfRunning: impactDecision.impact === OpenClawConfigImpact.Restart,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to toggle plugin' };
    }
  });

  ipcMain.handle('plugins:get-config-schema', async (_event, pluginId: string) => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      const schema = manager.getPluginConfigSchema(pluginId);
      const config = manager.getPluginConfig(pluginId);
      return { success: true, schema, config };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get config schema' };
    }
  });

  ipcMain.handle('plugins:save-config', async (_event, pluginId: string, config: Record<string, unknown>) => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      manager.savePluginConfig(pluginId, config);
      const impactDecision = classifyPluginConfigChange(OpenClawPluginChangeAction.Config);
      await syncOpenClawConfig({
        reason: 'plugin-config',
        restartGatewayIfRunning: impactDecision.impact === OpenClawConfigImpact.Restart,
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to save plugin config' };
    }
  });

  ipcMain.handle('plugins:batch-save', async (_event, changes: {
    toggles?: Array<{ pluginId: string; enabled: boolean }>;
    configs?: Array<{ pluginId: string; config: Record<string, unknown> }>;
  }) => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      for (const { pluginId, enabled } of changes.toggles ?? []) {
        manager.setPluginEnabled(pluginId, enabled);
      }
      for (const { pluginId, config } of changes.configs ?? []) {
        manager.savePluginConfig(pluginId, config);
      }
      const hasChanges = (changes.toggles?.length ?? 0) > 0 || (changes.configs?.length ?? 0) > 0;
      if (hasChanges) {
        await syncOpenClawConfig({
          reason: 'plugin-batch-save',
          restartGatewayIfRunning: true,
        });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to batch save plugin changes' };
    }
  });

  ipcMain.handle('plugins:check-updates', async (_event, pluginIds?: string[]) => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());
      const updates = await manager.checkPluginUpdates(pluginIds);
      return { success: true, updates };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check plugin updates' };
    }
  });

  ipcMain.handle('plugins:update', async (event, pluginId: string) => {
    try {
      const { PluginManager } = await import('../../plugins/pluginManager');
      const manager = new PluginManager(getCoworkStore());

      // Find plugin info to determine source/spec/registry
      const plugins = getCoworkStore().listUserPlugins();
      const plugin = plugins.find(p => p.pluginId === pluginId);
      if (!plugin) {
        return { ok: false, error: `Plugin "${pluginId}" not found` };
      }
      if (plugin.source !== 'npm' && plugin.source !== 'clawhub') {
        return { ok: false, error: `Update not supported for source "${plugin.source}"` };
      }

      const previousEnabled = plugin.enabled;

      const sender = event.sender;
      const sendLog = (line: string) => {
        try { sender.send('plugins:install-log', line); } catch { /* window closed */ }
      };

      // Reinstall without version constraint to get latest
      const result = await manager.installPlugin({
        source: plugin.source,
        spec: plugin.spec,
        registry: plugin.registry,
      }, sendLog);

      if (result.ok) {
        // Restore previous enabled state (installPlugin always sets enabled=true)
        if (!previousEnabled) {
          manager.setPluginEnabled(pluginId, false);
        }
        sendLog('Syncing gateway config...\n');
        const impactDecision = classifyPluginConfigChange(OpenClawPluginChangeAction.Install);
        await syncOpenClawConfig({
          reason: 'plugin-update',
          restartGatewayIfRunning: impactDecision.impact === OpenClawConfigImpact.Restart,
        });
        sendLog('Gateway config synced.\n');
      }
      return result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to update plugin' };
    }
  });
}
