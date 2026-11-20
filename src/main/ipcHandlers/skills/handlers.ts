import { ipcMain } from 'electron';

import type { SkillManager } from '../../skills/skillManager';

export interface SkillHandlerDeps {
  getSkillManager: () => SkillManager;
  getSkillStoreUrl: () => string;
  onSkillsPolicyChanged?: () => Promise<void> | void;
}

export function registerSkillHandlers(deps: SkillHandlerDeps): void {
  const { getSkillManager, getSkillStoreUrl, onSkillsPolicyChanged } = deps;

  ipcMain.handle('skills:list', () => {
    try {
      const skills = getSkillManager().listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
    }
  });

  ipcMain.handle('skills:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      const skills = getSkillManager().setSkillEnabled(options.id, options.enabled);
      try {
        await onSkillsPolicyChanged?.();
      } catch (syncError) {
        console.warn('[skills] Failed to sync enabled state to DSH host:', syncError);
      }
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update skill' };
    }
  });

  ipcMain.handle('skills:delete', async (_event, id: string) => {
    try {
      const skills = await getSkillManager().deleteSkill(id);
      await Promise.resolve(onSkillsPolicyChanged?.()).catch((): void => undefined);
      return { success: true, skills };
    } catch (error) {
      console.error('[skills] Failed to delete skill:', id, error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete skill' };
    }
  });

  ipcMain.handle('skills:download', async (_event, source: string) => {
    return getSkillManager().downloadSkill(source);
  });

  ipcMain.handle('skills:upgrade', async (_event, skillId: string, downloadUrl: string) => {
    return getSkillManager().upgradeSkill(skillId, downloadUrl);
  });

  ipcMain.handle('skills:confirmInstall', async (_event, pendingId: string, action: string) => {
    const validActions = ['install', 'installDisabled', 'cancel'];
    if (!validActions.includes(action)) {
      return { success: false, error: 'Invalid action' };
    }
    return getSkillManager().confirmPendingInstall(
      pendingId,
      action as 'install' | 'installDisabled' | 'cancel',
    );
  });

  ipcMain.handle('skills:getRoot', () => {
    try {
      const root = getSkillManager().getSkillsRoot();
      return { success: true, path: root };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to resolve skills root' };
    }
  });

  ipcMain.handle('skills:autoRoutingPrompt', () => {
    try {
      const prompt = getSkillManager().buildAutoRoutingPrompt();
      return { success: true, prompt };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to build auto-routing prompt' };
    }
  });

  ipcMain.handle('skills:getConfig', (_event, skillId: string) => {
    return getSkillManager().getSkillConfig(skillId);
  });

  ipcMain.handle('skills:setConfig', (_event, skillId: string, config: Record<string, string>) => {
    return getSkillManager().setSkillConfig(skillId, config);
  });

  ipcMain.handle('skills:getEmailAccountsConfig', (_event, skillId: string) => {
    return getSkillManager().getEmailAccountsConfig(skillId);
  });

  ipcMain.handle('skills:setEmailAccountsConfig', (_event, skillId: string, config: Parameters<SkillManager['setEmailAccountsConfig']>[1]) => {
    return getSkillManager().setEmailAccountsConfig(skillId, config);
  });

  ipcMain.handle('skills:testEmailAccountConnectivity', async (
    _event,
    skillId: string,
    account: Parameters<SkillManager['testEmailAccountConnectivity']>[1],
  ) => {
    return getSkillManager().testEmailAccountConnectivity(skillId, account);
  });

  ipcMain.handle('skills:testEmailConnectivity', async (
    _event,
    skillId: string,
    config: Record<string, string>,
  ) => {
    return getSkillManager().testEmailConnectivity(skillId, config);
  });

  ipcMain.handle('skills:fetchMarketplace', async () => {
    const url = getSkillStoreUrl();
    console.log(`[SkillMarketplace] fetching from: ${url}`);
    try {
      const https = await import('https');
      const data = await new Promise<string>((resolve, reject) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            res.resume();
            return;
          }
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { body += chunk; });
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      });
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch skill marketplace' };
    }
  });

  // Compatibility no-ops for removed OpenClaw skill sync channels.
  ipcMain.handle('skills:detectFromOpenClaw', () => ({ skills: [] }));
  ipcMain.handle('skills:syncFromOpenClaw', () => ({ synced: [] }));
}
