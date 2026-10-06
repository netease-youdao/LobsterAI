import crypto from 'crypto';
import { app, BrowserWindow, ipcMain } from 'electron';
import extractZip from 'extract-zip';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';

import {
  ComputerUseKitId,
} from '../../../shared/computerUse/constants';
import type {
  InstalledKitRecord,
  KitSkillMetadata,
  KitStoreKey,
  LocalizedText,
} from '../../../shared/kit/constants';
import { KitStoreKey as KitStoreKeyValue } from '../../../shared/kit/constants';
import {
  buildComputerUseMarketplaceKit,
  buildInstalledComputerUseKitRecord,
  type ComputerUseKitBundleDescriptor,
  getCurrentComputerUseKitBundleDescriptor,
  getInstalledKitsMap,
  isComputerUseKitSupportedPlatform,
  promptComputerUseAccessibilityPermission,
  removeComputerUseSkillArtifacts,
  resolveBundledComputerUseKitArchivePath,
} from '../../computerUse/computerUseKit';
import {
  getComputerUseSupportedPlatformLabel,
  installComputerUseRuntime,
  uninstallComputerUseRuntime,
} from '../../computerUse/computerUseRuntime';
import { cpRecursiveSync } from '../../fsCompat';
import { OpenClawConfigImpact } from '../../libs/openclawConfigImpact';
import type { SkillManager } from '../../skills/skillManager';
import type { SqliteStore } from '../../sqliteStore';

const KITS_INSTALLED_KEY: KitStoreKey = KitStoreKeyValue.Installed;
const SKILLS_DIR_NAME = 'SKILLs';
const SKILL_FILE_NAME = 'SKILL.md';

function downloadBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 60000 }, (res) => {
      // Follow redirects
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadBuffer(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed (HTTP ${res.statusCode})`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
  });
}

async function loadComputerUseKitBundle(
  descriptor: ComputerUseKitBundleDescriptor,
): Promise<Buffer> {
  const bundledArchivePath = resolveBundledComputerUseKitArchivePath(descriptor);
  if (bundledArchivePath) {
    return fs.promises.readFile(bundledArchivePath);
  }
  if (descriptor.archiveName) {
    throw new Error(`Computer Use kit bundle archive is not bundled: ${descriptor.archiveName}`);
  }
  return downloadBuffer(descriptor.bundle);
}

export interface KitHandlerDeps {
  getStore: () => SqliteStore;
  getKitStoreUrl: () => string;
  getSkillManager: () => SkillManager;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
    expectedImpact?: OpenClawConfigImpact;
  }) => Promise<{ success: boolean; changed: boolean; error?: string }>;
}

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

type InstalledKitsMap = Record<string, InstalledKitRecord>;

const normalizeCapabilityList = (value: unknown): unknown[] => (
  Array.isArray(value) ? value : []
);

function appendBuiltInKitsToStoreResponse(data: string): string {
  if (!isComputerUseKitSupportedPlatform()) {
    return data;
  }

  const parsed = JSON.parse(data) as Record<string, unknown>;
  const valueContainer = (parsed as { data?: { value?: unknown } }).data;
  const rawValue = valueContainer?.value;
  if (!valueContainer || !rawValue) {
    return data;
  }

  const value = typeof rawValue === 'string'
    ? JSON.parse(rawValue) as Record<string, unknown>
    : rawValue as Record<string, unknown>;
  const kits = Array.isArray(value.kits) ? value.kits : [];
  const withoutDuplicate = kits.filter((kit) => (
    !kit
    || typeof kit !== 'object'
    || (kit as Record<string, unknown>).id !== ComputerUseKitId.BuiltIn
  ));

  const nextValue = {
    ...value,
    kits: [
      ...withoutDuplicate,
      buildComputerUseMarketplaceKit(),
    ],
  };
  valueContainer.value = typeof rawValue === 'string' ? JSON.stringify(nextValue) : nextValue;
  return JSON.stringify(parsed);
}

const normalizeLocalizedText = (value: unknown): string | LocalizedText | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const en = typeof record.en === 'string' ? record.en.trim() : '';
  const zh = typeof record.zh === 'string' ? record.zh.trim() : '';
  if (!en && !zh) return undefined;
  return {
    en: en || zh,
    zh: zh || en,
  };
};

const normalizeKitSkillMetadataList = (value: unknown): Map<string, KitSkillMetadata> => {
  const metadata = new Map<string, KitSkillMetadata>();
  if (!Array.isArray(value)) return metadata;

  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id) continue;

    const name = normalizeLocalizedText(record.name);
    const description = normalizeLocalizedText(record.description);
    metadata.set(id, {
      id,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
  }

  return metadata;
};

function getSkillsRoot(): string {
  return path.resolve(app.getPath('userData'), SKILLS_DIR_NAME);
}

function ensureSkillsRoot(): string {
  const root = getSkillsRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  return root;
}

function normalizeFolderName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'skill';
}

function normalizeWindowsAttrs(targetDir: string): void {
  if (process.platform !== 'win32') return;
  const { spawnSync } = require('child_process');
  const escapedPath = targetDir.replace(/"/g, '""');
  spawnSync('cmd.exe', ['/d', '/s', '/c', `attrib -r -s -h "${escapedPath}" /s /d`], {
    stdio: 'pipe',
    windowsHide: true,
    timeout: 10000,
  });
}

function collectSkillDirs(source: string): string[] {
  const resolved = path.resolve(source);

  // Direct SKILL.md at root
  if (fs.existsSync(path.join(resolved, SKILL_FILE_NAME))) {
    return [resolved];
  }

  // Check skills/ subdirectory
  const nestedRoot = path.join(resolved, 'skills');
  if (fs.existsSync(nestedRoot) && fs.statSync(nestedRoot).isDirectory()) {
    const dirs = listSkillDirs(nestedRoot);
    if (dirs.length > 0) return dirs;
  }

  // Check SKILLs/ subdirectory
  const nestedRoot2 = path.join(resolved, SKILLS_DIR_NAME);
  if (fs.existsSync(nestedRoot2) && fs.statSync(nestedRoot2).isDirectory()) {
    const dirs = listSkillDirs(nestedRoot2);
    if (dirs.length > 0) return dirs;
  }

  // Direct children
  return listSkillDirs(resolved);
}

function listSkillDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .sort((a, b) => a.localeCompare(b))
    .map(entry => path.join(root, entry))
    .filter(entryPath => {
      try {
        return fs.statSync(entryPath).isDirectory()
          && fs.existsSync(path.join(entryPath, SKILL_FILE_NAME));
      } catch {
        return false;
      }
    });
}

function notifySkillsChanged(): void {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('skills:changed');
    }
  });
}

export function registerKitHandlers(deps: KitHandlerDeps): void {
  const { getStore, getKitStoreUrl, getSkillManager, syncOpenClawConfig } = deps;

  // Fetch kit store catalog from overmind
  ipcMain.handle('kits:fetchStore', async () => {
    const url = getKitStoreUrl();
    console.log(`[KitStore] fetching from: ${url}`);
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
      return { success: true, data: appendBuiltInKitsToStoreResponse(data) };
    } catch (error) {
      console.error('[KitStore] fetch failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch kit store' };
    }
  });

  // List installed kits
  ipcMain.handle('kits:listInstalled', () => {
    try {
      const map = getStore().get<InstalledKitsMap>(KITS_INSTALLED_KEY) ?? {};
      return { success: true, installed: map };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to list installed kits' };
    }
  });

  // Install a kit
  ipcMain.handle('kits:install', async (_event, params: {
    kitId: string;
    bundleUrl: string;
    version: string;
    skillListIds: string[];
    skillList?: KitSkillMetadata[];
    mcpServers?: unknown[] | null;
    connectors?: unknown[] | null;
  }) => {
    const { kitId, bundleUrl, version, skillListIds: _skillListIds } = params;
    const isComputerUseKit = kitId === ComputerUseKitId.BuiltIn;
    console.log(`[KitStore] Installing kit "${kitId}" v${version} from ${bundleUrl}`);

    let tempRoot: string | null = null;
    let skillWatchingStopped = false;
    let skillWatchingRestarted = false;
    try {
      const computerUseBundleDescriptor = isComputerUseKit
        ? getCurrentComputerUseKitBundleDescriptor()
        : null;
      if (isComputerUseKit && !computerUseBundleDescriptor) {
        throw new Error(`Computer Use kit is only available on ${getComputerUseSupportedPlatformLabel()}.`);
      }
      if (computerUseBundleDescriptor && bundleUrl !== computerUseBundleDescriptor.bundle) {
        throw new Error('Computer Use kit bundle URL does not match the built-in catalog entry');
      }

      // 1. Download zip
      tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lobsterai-kit-'));
      const buffer = computerUseBundleDescriptor
        ? await loadComputerUseKitBundle(computerUseBundleDescriptor)
        : await downloadBuffer(bundleUrl);
      if (computerUseBundleDescriptor) {
        if (buffer.length !== computerUseBundleDescriptor.sizeBytes) {
          throw new Error('Computer Use kit bundle size verification failed');
        }
        if (sha256Buffer(buffer) !== computerUseBundleDescriptor.sha256) {
          throw new Error('Computer Use kit bundle checksum verification failed');
        }
      }
      const zipPath = path.join(tempRoot, 'kit-bundle.zip');
      const extractRoot = path.join(tempRoot, 'extracted');
      fs.writeFileSync(zipPath, buffer);
      fs.mkdirSync(extractRoot, { recursive: true });

      // 2. Extract
      await extractZip(zipPath, { dir: extractRoot });

      // Handle single-directory wrapper (e.g. zip contains one root folder)
      let sourceRoot = extractRoot;
      const extractedEntries = fs.readdirSync(extractRoot)
        .map(entry => path.join(extractRoot, entry))
        .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
      if (extractedEntries.length === 1) {
        sourceRoot = extractedEntries[0];
      }

      // 3. Discover skill directories
      const skillDirs = collectSkillDirs(sourceRoot);
      if (skillDirs.length === 0) {
        throw new Error('No skills found in kit bundle (no SKILL.md detected)');
      }

      if (isComputerUseKit) {
        const runtimeResult = await installComputerUseRuntime();
        if (!runtimeResult.success) {
          throw new Error(runtimeResult.error || 'Computer Use runtime installation failed');
        }
      }

      const skillManager = getSkillManager();
      skillManager.stopWatching();
      skillWatchingStopped = true;
      if (isComputerUseKit) {
        removeComputerUseSkillArtifacts(getStore());
      }

      // 4. Copy skills to user SKILLs directory
      const root = ensureSkillsRoot();
      const installedSkillIds: string[] = [];
      const installedSkillMetadata: Record<string, KitSkillMetadata> = {};
      const sourceSkillMetadata = normalizeKitSkillMetadataList(params.skillList);

      for (const skillDir of skillDirs) {
        const folderName = normalizeFolderName(path.basename(skillDir));
        let targetDir = path.resolve(root, folderName);
        let suffix = 1;
        while (fs.existsSync(targetDir)) {
          targetDir = path.resolve(root, `${folderName}-${suffix}`);
          suffix += 1;
        }
        cpRecursiveSync(skillDir, targetDir);
        normalizeWindowsAttrs(targetDir);
        const installedSkillId = path.basename(targetDir);
        installedSkillIds.push(installedSkillId);

        const sourceSkillId = path.basename(skillDir);
        const metadata = sourceSkillMetadata.get(sourceSkillId) ?? sourceSkillMetadata.get(folderName);
        if (metadata?.name || metadata?.description) {
          installedSkillMetadata[installedSkillId] = {
            id: installedSkillId,
            ...(metadata.name ? { name: metadata.name } : {}),
            ...(metadata.description ? { description: metadata.description } : {}),
          };
        }
      }

      // 5. Enable installed skills
      const stateMap = getStore().get<Record<string, { enabled: boolean }>>('skills_state') ?? {};
      for (const skillId of installedSkillIds) {
        stateMap[skillId] = { enabled: true };
      }
      getStore().set('skills_state', stateMap);

      // 6. Persist kit installation record
      const installedMap = getInstalledKitsMap(getStore());
      installedMap[kitId] = isComputerUseKit
        ? buildInstalledComputerUseKitRecord(installedSkillIds, installedSkillMetadata)
        : {
          id: kitId,
          version,
          installedAt: Date.now(),
          skills: installedSkillIds.length > 0
            ? {
              skillIds: installedSkillIds,
              ...(Object.keys(installedSkillMetadata).length > 0 ? { metadata: installedSkillMetadata } : {}),
            }
            : null,
          mcpServers: normalizeCapabilityList(params.mcpServers),
          connectors: normalizeCapabilityList(params.connectors),
      };
      getStore().set(KITS_INSTALLED_KEY, installedMap);

      if (isComputerUseKit) {
        const syncResult = await syncOpenClawConfig({
          reason: 'computer-use-kit-installed',
          restartGatewayIfRunning: true,
          expectedImpact: OpenClawConfigImpact.Restart,
        });
        if (!syncResult.success) {
          throw new Error(syncResult.error || 'OpenClaw config sync failed after Computer Use install');
        }
        promptComputerUseAccessibilityPermission();
      }

      // 7. Notify after all installation work and Computer Use config sync are complete.
      skillManager.startWatching();
      skillWatchingRestarted = true;
      notifySkillsChanged();

      console.log(`[KitStore] Kit "${kitId}" installed successfully with skills: ${installedSkillIds.join(', ')}`);
      return { success: true, skillIds: installedSkillIds };
    } catch (error) {
      console.error(`[KitStore] Install failed for kit "${kitId}":`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Kit installation failed' };
    } finally {
      // Cleanup temp
      if (tempRoot) {
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch { /* ignore cleanup errors */ }
      }
      if (skillWatchingStopped && !skillWatchingRestarted) {
        try {
          getSkillManager().startWatching();
        } catch (error) {
          console.warn('[KitStore] failed to restart skill watcher after install:', error);
        }
      }
    }
  });

  // Uninstall a kit
  ipcMain.handle('kits:uninstall', async (_event, kitId: string) => {
    console.log(`[KitStore] Uninstalling kit "${kitId}"`);
    let skillWatchingStopped = false;
    let skillWatchingRestarted = false;
    try {
      const installedMap = getInstalledKitsMap(getStore());
      const kitRecord = installedMap[kitId];
      if (!kitRecord) {
        return { success: false, error: `Kit "${kitId}" is not installed` };
      }

      const skillManager = getSkillManager();
      skillManager.stopWatching();
      skillWatchingStopped = true;

      // Delete skill directories
      const root = getSkillsRoot();
      const stateMap = getStore().get<Record<string, { enabled: boolean }>>('skills_state') ?? {};

      for (const skillId of kitRecord.skills?.skillIds ?? []) {
        const skillDir = path.resolve(root, skillId);
        if (fs.existsSync(skillDir)) {
          try {
            fs.rmSync(skillDir, { recursive: true, force: true });
          } catch (err) {
            console.warn(`[KitStore] Failed to delete skill dir "${skillId}":`, err);
          }
        }
        delete stateMap[skillId];
      }

      // Update skills state
      getStore().set('skills_state', stateMap);

      // Remove kit record
      delete installedMap[kitId];
      getStore().set(KITS_INSTALLED_KEY, installedMap);

      if (kitId === ComputerUseKitId.BuiltIn) {
        removeComputerUseSkillArtifacts(getStore());
        await uninstallComputerUseRuntime();
        const syncResult = await syncOpenClawConfig({
          reason: 'computer-use-kit-uninstalled',
          restartGatewayIfRunning: true,
          expectedImpact: OpenClawConfigImpact.Restart,
        });
        if (!syncResult.success) {
          throw new Error(syncResult.error || 'OpenClaw config sync failed after Computer Use uninstall');
        }
      }

      // Notify
      skillManager.startWatching();
      skillWatchingRestarted = true;
      notifySkillsChanged();

      console.log(`[KitStore] Kit "${kitId}" uninstalled successfully`);
      return { success: true };
    } catch (error) {
      console.error(`[KitStore] Uninstall failed for kit "${kitId}":`, error);
      return { success: false, error: error instanceof Error ? error.message : 'Kit uninstallation failed' };
    } finally {
      if (skillWatchingStopped && !skillWatchingRestarted) {
        try {
          getSkillManager().startWatching();
        } catch (error) {
          console.warn('[KitStore] failed to restart skill watcher after uninstall:', error);
        }
      }
    }
  });
}
