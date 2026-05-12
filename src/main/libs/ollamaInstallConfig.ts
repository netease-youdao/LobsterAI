import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type OllamaInstallConfig = {
  presetInstaller: Partial<Record<NodeJS.Platform, string[]>>;
  installerFilenames: Record<'win32' | 'darwin' | 'linux', string[]>;
  mirrorDownload: Partial<Record<NodeJS.Platform, string>>;
  officialUrl: string;
};

function expandPath(value: string): string {
  const expandedHome = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  return expandedHome.replace(/%USERPROFILE%/gi, os.homedir());
}

function splitEnvPaths(value?: string): string[] {
  return (value ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(expandPath);
}

function readEnterpriseConfig(): Partial<OllamaInstallConfig> {
  const configPath = path.join(os.homedir(), '.lobsterai', 'install.config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<OllamaInstallConfig>;
  } catch {
    return {};
  }
}

export function getOllamaInstallConfig(): OllamaInstallConfig {
  const downloadsDir = app.getPath('downloads');
  const enterpriseConfig = readEnterpriseConfig();
  const envPresetPaths = splitEnvPaths(process.env.LOBSTERAI_OLLAMA_PRESET_PATH);
  const envMirrorUrl = process.env.LOBSTERAI_OLLAMA_MIRROR_URL?.trim();

  const defaults: OllamaInstallConfig = {
    presetInstaller: {
      win32: [
        'C:\\ProgramData\\LobsterAI\\installers',
        downloadsDir,
      ],
      darwin: [
        '/Library/Application Support/LobsterAI/installers',
        downloadsDir,
      ],
      linux: [
        '/opt/lobsterai/installers',
        downloadsDir,
      ],
    },
    installerFilenames: {
      win32: ['OllamaSetup.exe'],
      darwin: ['Ollama.dmg', 'Ollama-darwin.zip'],
      linux: process.arch === 'arm64'
        ? ['ollama-linux-arm64.tgz', 'ollama-linux-amd64.tgz']
        : ['ollama-linux-amd64.tgz', 'ollama-linux-arm64.tgz'],
    },
    mirrorDownload: {
      win32: 'https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe',
      darwin: 'https://github.com/ollama/ollama/releases/latest/download/Ollama-darwin.zip',
      linux: process.arch === 'arm64'
        ? 'https://github.com/ollama/ollama/releases/latest/download/ollama-linux-arm64.tgz'
        : 'https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tgz',
    },
    officialUrl: 'https://ollama.com/download',
  };

  const platform = process.platform;
  return {
    presetInstaller: {
      ...defaults.presetInstaller,
      ...(enterpriseConfig.presetInstaller ?? {}),
      ...(envPresetPaths.length > 0 ? { [platform]: envPresetPaths } : {}),
    },
    installerFilenames: {
      ...defaults.installerFilenames,
      ...(enterpriseConfig.installerFilenames ?? {}),
    },
    mirrorDownload: {
      ...defaults.mirrorDownload,
      ...(enterpriseConfig.mirrorDownload ?? {}),
      ...(envMirrorUrl ? { [platform]: envMirrorUrl } : {}),
    },
    officialUrl: enterpriseConfig.officialUrl || defaults.officialUrl,
  };
}

export function getPlatformInstallerFilenames(config: OllamaInstallConfig): string[] {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    return config.installerFilenames[process.platform];
  }
  return [];
}

export function getPlatformPresetDirs(config: OllamaInstallConfig): string[] {
  return (config.presetInstaller[process.platform] ?? []).map((dir) => path.resolve(expandPath(dir)));
}
