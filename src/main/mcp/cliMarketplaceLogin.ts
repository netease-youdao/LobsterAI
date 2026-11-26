import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { createInterface } from 'node:readline';

import { shell } from 'electron';

import type { CliConnectorId } from '../../shared/mcp/cliConnector';
import { getNodeToolEnv, resolveUserShellPathAsync } from '../libs/coworkUtil';
import { resolveNodePackageCliCommand } from '../libs/nodeRuntime';

type LoginId = Exclude<CliConnectorId, 'baidu-drive'>;
const providers = {
  'connector-wecom': { pkg: '@wecom/cli@1.3.4', domains: ['work.weixin.qq.com'] },
  'connector-feishu': { pkg: '@larksuite/cli@1.0.100', domains: ['feishu.cn', 'larksuite.com'] },
  'connector-dingtalk': { pkg: 'dingtalk-workspace-cli@1.0.70', domains: ['login.dingtalk.com'] },
} satisfies Record<LoginId, { pkg: string; domains: string[] }>;

function json(text: string) {
  try { return JSON.parse(text); } catch { return undefined; }
}

// Programs and arguments are selected locally. Catalogue data cannot supply a
// binary, arguments or a URL to open. Device codes and CLI output stay local.
export async function connectCliAccount(id: LoginId, signal: AbortSignal): Promise<void> {
  const env = await getNodeToolEnv();
  const path = await resolveUserShellPathAsync();
  if (path) env.PATH = [env.PATH, path].filter(Boolean).join(delimiter);
  env.NO_COLOR = '1';
  env.npm_config_loglevel = 'error';
  env.DWS_NO_SKILLS = '1';
  const { pkg, domains } = providers[id];
  const launcher = resolveNodePackageCliCommand('npx', env);
  const prefix = [...launcher.baseArgs, '--yes', pkg];

  async function run(args: string[], interactive = false) {
    signal.throwIfAborted();
    const child = spawn(launcher.command, [...prefix, ...args], {
      cwd: homedir(), env: launcher.env, shell: launcher.shell,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    const stop = () => {
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === 'win32') {
        spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    };
    signal.addEventListener('abort', stop, { once: true });
    let stdout = '';
    let stderr = '';
    let problem: Error | undefined;
    let opened = false;
    async function offer(line: string) {
      if (opened || !interactive || signal.aborted) return;
      let link = line.trim();
      if (id === 'connector-feishu' && line.startsWith('{')) {
        const event = json(line);
        link = event?.event === 'device_authorization' ? event.verification_uri_complete : '';
      }
      if (typeof link !== 'string' || !/^https:\/\/\S+$/.test(link)) return;
      const url = new URL(link);
      if (url.username || url.password || url.port || !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
        throw new Error('授权地址不属于所选服务商');
      }
      opened = true;
      if (!signal.aborted && child.exitCode === null) await shell.openExternal(url.href);
    }
    for (const stream of [child.stdout, child.stderr]) {
      const lines = createInterface({ input: stream });
      lines.on('line', line => {
        if (!interactive) {
          if (stream === child.stdout && stdout.length < 128_000) stdout += line + '\n';
          if (stream === child.stderr && stderr.length < 128_000) stderr += line + '\n';
        }
        void offer(line).catch(error => { problem = error; stop(); });
      });
    }
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      signal.throwIfAborted();
      if (problem) throw problem;
      return { code, stdout, stderr };
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  const statusArgs: Record<LoginId, string[]> = {
    'connector-wecom': ['auth', 'show'],
    'connector-feishu': ['auth', 'status', '--verify', '--json'],
    'connector-dingtalk': ['auth', 'status', '--format', 'json'],
  };
  const status = () => run(statusArgs[id]);
  const connected = (result: Awaited<ReturnType<typeof status>>) => {
    if (result.code !== 0) return false;
    if (id === 'connector-wecom') return /^Status:\s*authorized\s*$/im.test(result.stdout);
    const data = json(result.stdout);
    return id === 'connector-dingtalk' ? data?.authenticated === true
      : data?.identities?.user?.available === true && data.identities.user.verified === true;
  };
  const initial = await status();
  if (connected(initial)) return;
  if (id === 'connector-wecom' && (initial.code !== 0 || !/^Status:\s*unauthorized\s*$/im.test(initial.stdout))) {
    throw new Error('无法确认企业微信授权状态，请检查网络或 CLI 安装后重试。');
  }
  if (id === 'connector-dingtalk' && json(initial.stdout)?.authenticated !== false) {
    throw new Error('无法确认钉钉授权状态，请检查网络或 CLI 安装后重试。');
  }
  const unconfigured = (json(initial.stderr) ?? json(initial.stdout))?.error?.subtype === 'not_configured';
  if (id === 'connector-feishu' && !unconfigured && !json(initial.stdout)?.appId) {
    throw new Error('无法确认飞书应用配置，请检查网络或 CLI 安装后重试。');
  }
  if (id === 'connector-feishu' && unconfigured) {
    const config = await run(['config', 'init', '--new'], true);
    if (config.code !== 0) throw new Error('飞书应用授权未完成');
  }
  const loginArgs: Record<LoginId, string[]> = {
    'connector-wecom': ['auth', 'init', '--noninteractive', '--no-browser'],
    'connector-feishu': ['auth', 'login', '--json'],
    'connector-dingtalk': ['auth', 'login', '--no-browser', '--format', 'json'],
  };
  await run(loginArgs[id], true);
  if (!connected(await status())) throw new Error('授权尚未完成，请检查账号状态后重试。');
}
