import path from 'node:path';

export const NpmConfigEnv = {
  Prefix: 'npm_config_prefix',
  UppercasePrefix: 'NPM_CONFIG_PREFIX',
} as const;

export function configureMacGatewayNpmEnv(
  env: NodeJS.ProcessEnv,
  openclawBaseDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'darwin') return;

  // npm defaults its global prefix to the parent of process.execPath. Our
  // Node runtime is an Electron Helper inside the signed .app, so plugin CLI
  // installs/upgrades must use a writable directory outside that bundle.
  const prefix = path.join(openclawBaseDir, 'npm');
  env[NpmConfigEnv.Prefix] = prefix;
  env[NpmConfigEnv.UppercasePrefix] = prefix;
  env.PATH = [path.join(prefix, 'bin'), env.PATH || env.Path || ''].filter(Boolean).join(path.delimiter);
}
