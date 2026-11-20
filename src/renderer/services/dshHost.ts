// Renderer service for LobsterAI's primary DeepSeek Harness (DSH) host,
// plugin management (`dsh plugin`), and on-demand DSH Ecosystem Web View.

export interface DshHostStatusSnapshot {
  phase: string;
  origin: string | null;
  authenticatedWebUrl: string | null;
  pid: number | null;
  runtimeVersion: string | null;
  profileDir: string;
  dshHomeDir: string;
  cliShimPath: string | null;
  lastError: string | null;
  startedAt: number | null;
  restartCount: number;
}

export interface DshPluginEntry {
  name: string;
  specifier: string;
  managed: boolean;
}

export const dshHostService = {
  getStatus(): Promise<DshHostStatusSnapshot | null> {
    return window.electron.dshHost.getStatus();
  },

  restart(): Promise<{ ok: boolean; error?: string }> {
    return window.electron.dshHost.restart();
  },

  openEcosystemView(routeHash?: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    return window.electron.dshHost.openEcosystemView(routeHash);
  },

  closeEcosystemView(): Promise<{ ok: boolean }> {
    return window.electron.dshHost.closeEcosystemView();
  },

  listPlugins(): Promise<{
    ok: boolean;
    profileDir?: string;
    cliShimPath?: string | null;
    plugins: DshPluginEntry[];
  }> {
    return window.electron.dshHost.listPlugins();
  },

  installPlugin(packageSpec: string): Promise<{
    ok: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    plugins?: DshPluginEntry[];
  }> {
    return window.electron.dshHost.installPlugin(packageSpec);
  },

  removePlugin(packageName: string): Promise<{
    ok: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
    plugins?: DshPluginEntry[];
  }> {
    return window.electron.dshHost.removePlugin(packageName);
  },

  openProfileDir(): Promise<{ ok: boolean; profileDir?: string }> {
    return window.electron.dshHost.openProfileDir();
  },
};
