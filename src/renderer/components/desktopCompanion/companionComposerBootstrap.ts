import { agentService } from '../../services/agent';
import { applyAppConfigToStore } from '../../services/appConfigModels';
import { authService } from '../../services/auth';
import { configService } from '../../services/config';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { themeService } from '../../services/theme';

/**
 * Loads what the home composer reads, inside the desktop companion's composer
 * window. Only read paths run here: the main window owns login callbacks,
 * session streams and their analytics, so starting those twice would race.
 */
export async function bootstrapCompanionComposer(): Promise<void> {
  await configService.init();
  applyAppConfigToStore();
  themeService.initialize();
  await i18nService.initialize();
  await Promise.all([coworkService.loadConfig(), agentService.loadAgents()]);
  // Signed-in users also get the server's models and quota.
  void authService.refreshAuthState({ clearOnFailure: false });
}

/** Picks up settings changed in the main window since the composer was last open. */
export async function refreshCompanionComposer(): Promise<void> {
  await configService.init();
  applyAppConfigToStore();
  const config = configService.getConfig();
  themeService.applyPersistedSelection({ mode: config.theme, themeId: config.themeId });
  i18nService.setLanguage(config.language, { persist: false });
  await Promise.all([coworkService.loadConfig(), agentService.loadAgents()]);
}
