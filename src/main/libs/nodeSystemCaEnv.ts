import { McpNodeEnv } from '../../shared/mcp/constants';

type Environment = Record<string, string | undefined>;

/**
 * Make Node.js children trust the OS certificate store alongside the bundled
 * Mozilla roots, like Chromium does. Without it, servers behind a TLS-inspecting
 * proxy fail every request with "fetch failed". The env var is used because
 * OpenClaw drops NODE_OPTIONS (and so --use-system-ca) from stdio MCP env.
 * Node.js older than 22.19 ignores it. An explicit value in env wins,
 * case-insensitively on Windows.
 */
export function applyNodeSystemCaDefault(
  env: Environment,
  options: { platform?: NodeJS.Platform } = {},
): void {
  const name = McpNodeEnv.UseSystemCa;
  const caseInsensitive = (options.platform ?? process.platform) === 'win32';
  const hasExplicitValue = Object.keys(env).some(key => (
    env[key] !== undefined && (caseInsensitive ? key.toUpperCase() === name : key === name)
  ));
  if (!hasExplicitValue) env[name] = '1';
}
