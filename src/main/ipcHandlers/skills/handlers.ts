import { ipcMain } from 'electron';

import { createAuthRequiredIpcError } from '../../libs/authAccessPolicy';
import { MarketplaceTrustRegistry } from '../../skills/marketplaceTrust';
import type { SkillManager } from '../../skills/skillManager';

export interface SkillHandlerDeps {
  getSkillManager: () => SkillManager;
  getSkillStoreUrl: () => string;
  fetchMarketplaceText?: (url: string) => Promise<string>;
  onSkillsPolicyChanged?: () => Promise<void> | void;
  isAuthGateBlocked?: () => boolean;
}

const fetchMarketplaceOverHttps = async (url: string): Promise<string> => {
  const https = await import('https');
  return new Promise<string>((resolve, reject) => {
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
};

export function registerSkillHandlers(deps: SkillHandlerDeps): void {
  const {
    getSkillManager,
    getSkillStoreUrl,
    fetchMarketplaceText = fetchMarketplaceOverHttps,
    onSkillsPolicyChanged,
    isAuthGateBlocked,
  } = deps;
  const marketplaceTrust = new MarketplaceTrustRegistry();
  let lastCatalogUrl = '';

  const loadMarketplaceCatalog = async (): Promise<string> => {
    const url = getSkillStoreUrl();
    if (!url) {
      throw new Error('Skill marketplace URL is not configured');
    }
    const data = await fetchMarketplaceText(url);
    lastCatalogUrl = url;
    marketplaceTrust.updateFromRawResponse(data);
    return data;
  };

  const ensureMarketplaceTrustLoaded = async (): Promise<void> => {
    const url = getSkillStoreUrl();
    if (!url) return;
    if (marketplaceTrust.isLoaded() && lastCatalogUrl === url) return;
    try {
      await loadMarketplaceCatalog();
    } catch (error) {
      console.warn('[SkillMarketplace] Failed to refresh trust catalog before install:', error);
    }
  };

  ipcMain.handle('skills:list', () => {
    try {
      const skills = getSkillManager().listSkills();
      return { success: true, skills };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to load skills' };
    }
  });

  ipcMain.handle('skills:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    if (isAuthGateBlocked?.()) return createAuthRequiredIpcError();
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
    if (isAuthGateBlocked?.()) return createAuthRequiredIpcError();
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
    if (isAuthGateBlocked?.()) return createAuthRequiredIpcError();
    if (typeof source === 'string' && /^https:\/\//i.test(source.trim())) {
      await ensureMarketplaceTrustLoaded();
    }
    const trust = typeof source === 'string'
      ? marketplaceTrust.resolveTrustedDownload(source)
      : { trusted: false };
    return getSkillManager().downloadSkill(
      source,
      undefined,
      trust.trusted
        ? { skipSecurityScan: true, expectedSha256: trust.expectedSha256 }
        : undefined,
    );
  });

  ipcMain.handle('skills:upgrade', async (_event, skillId: string, downloadUrl: string) => {
    if (isAuthGateBlocked?.()) return createAuthRequiredIpcError();
    if (typeof downloadUrl === 'string' && /^https:\/\//i.test(downloadUrl.trim())) {
      await ensureMarketplaceTrustLoaded();
    }
    const trust = typeof downloadUrl === 'string'
      ? marketplaceTrust.resolveTrustedDownload(downloadUrl, skillId)
      : { trusted: false };
    return getSkillManager().upgradeSkill(
      skillId,
      downloadUrl,
      trust.trusted
        ? { skipSecurityScan: true, expectedSha256: trust.expectedSha256 }
        : undefined,
    );
  });

  ipcMain.handle('skills:confirmInstall', async (_event, pendingId: string, action: string) => {
    if (isAuthGateBlocked?.()) return createAuthRequiredIpcError();
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

  ipcMain.handle('skills:setConfig', async (_event, skillId: string, config: Record<string, string>) => {
    const result = getSkillManager().setSkillConfig(skillId, config);
    if (result.success) {
      await Promise.resolve(onSkillsPolicyChanged?.()).catch((syncError: unknown) => {
        console.warn('[skills] Failed to sync skill policy after config change:', syncError);
      });
    }
    return result;
  });

  ipcMain.handle('skills:getEmailAccountsConfig', (_event, skillId: string) => {
    return getSkillManager().getEmailAccountsConfig(skillId);
  });

  ipcMain.handle('skills:setEmailAccountsConfig', async (_event, skillId: string, config: Parameters<SkillManager['setEmailAccountsConfig']>[1]) => {
    const result = getSkillManager().setEmailAccountsConfig(skillId, config);
    if (result.success) {
      await Promise.resolve(onSkillsPolicyChanged?.()).catch((syncError: unknown) => {
        console.warn('[skills] Failed to sync skill policy after email accounts update:', syncError);
      });
    }
    return result;
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
      const data = await loadMarketplaceCatalog();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch skill marketplace' };
    }
  });

  // Compatibility no-ops for removed OpenClaw skill sync channels.
  ipcMain.handle('skills:detectFromOpenClaw', () => ({ skills: [] }));
  ipcMain.handle('skills:syncFromOpenClaw', () => ({ synced: [] }));
}
