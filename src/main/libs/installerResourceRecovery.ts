import fs from 'fs';
import path from 'path';
import * as tar from 'tar';

/**
 * Recovery for Windows installs where the NSIS installer stopped (killed by
 * the user, or its extractor child was frozen by security software) after the
 * main app files were extracted but before win-resources.tar was unpacked.
 * In that state the app launches, but resources/cfmind, python-win and SKILLs
 * are empty directories; the tar preserved next to them is the only local
 * source of the OpenClaw runtime. The installer only deletes the tar after a
 * successful extraction, so we can finish its job here.
 */

export const INSTALLER_RESOURCES_TAR = 'win-resources.tar';
/** Written after a successful extraction, by the installer or by this module. */
export const INSTALLER_RESOURCES_MARKER = '.win-resources-extracted';

const GATEWAY_BUNDLE_ENTRY = path.join('cfmind', 'gateway-bundle.mjs');
const GATEWAY_BUNDLE_REQUIRED_ASSETS = [path.join('cfmind', 'web-tree-sitter.wasm')];

// Mirrors the fallback candidates of OpenClawEngineManager.resolveOpenClawEntry.
// The optimized root bundle is only usable when its root-relative assets are
// present; otherwise recovery must not treat a partial extraction as complete.
const RUNTIME_FALLBACK_ENTRY_CANDIDATES = [
  path.join('cfmind', 'openclaw.mjs'),
  path.join('cfmind', 'dist', 'entry.js'),
  path.join('cfmind', 'gateway.asar'),
];

const PROGRESS_LOG_STEP_BYTES = 50 * 1024 * 1024;

export interface InstallerResourceRecoveryProgress {
  entries: number;
  bytes: number;
  totalBytes: number;
}

export interface InstallerResourceRecoveryResult {
  /** True when an extraction was actually started. */
  attempted: boolean;
  /** True when a complete runtime entry is present (recovered now, or already intact). */
  success: boolean;
  tarPath: string;
  entries?: number;
  elapsedMs?: number;
  error?: string;
}

export const hasBundledRuntimeEntry = (resourcesDir: string): boolean => {
  if (fs.existsSync(path.join(resourcesDir, GATEWAY_BUNDLE_ENTRY))) {
    return GATEWAY_BUNDLE_REQUIRED_ASSETS.every((asset) =>
      fs.existsSync(path.join(resourcesDir, asset)),
    );
  }

  return RUNTIME_FALLBACK_ENTRY_CANDIDATES.some((candidate) =>
    fs.existsSync(path.join(resourcesDir, candidate)),
  );
};

const stringifyError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const doRecover = async (
  resourcesDir: string,
  reason: string,
  onProgress?: (progress: InstallerResourceRecoveryProgress) => void,
): Promise<InstallerResourceRecoveryResult> => {
  const tarPath = path.join(resourcesDir, INSTALLER_RESOURCES_TAR);
  const markerPath = path.join(resourcesDir, INSTALLER_RESOURCES_MARKER);

  if (hasBundledRuntimeEntry(resourcesDir)) {
    return { attempted: false, success: true, tarPath };
  }

  if (!fs.existsSync(tarPath)) {
    console.warn(
      `[InstallerRecovery] runtime entry or required bundle assets are missing and no installer tar ` +
        `is left to recover from ` +
        `(reason=${reason}, extractedMarker=${fs.existsSync(markerPath)}, dir=${resourcesDir})`,
    );
    return { attempted: false, success: false, tarPath, error: 'installer resource tar not found' };
  }

  let totalBytes = 0;
  try {
    totalBytes = fs.statSync(tarPath).size;
  } catch {
    // Progress percentages become unavailable; extraction can still proceed.
  }

  const t0 = Date.now();
  let entries = 0;
  let bytes = 0;
  let nextProgressBytes = PROGRESS_LOG_STEP_BYTES;
  console.log(
    `[InstallerRecovery] runtime entry or required bundle assets are missing, extracting ` +
      `${tarPath} -> ${resourcesDir} ` +
      `(reason=${reason}, tarBytes=${totalBytes})`,
  );
  onProgress?.({ entries: 0, bytes: 0, totalBytes });

  try {
    await tar.extract({
      file: tarPath,
      cwd: resourcesDir,
      onReadEntry: (entry) => {
        entries += 1;
        bytes += Number(entry.size ?? 0);
        if (bytes >= nextProgressBytes) {
          while (bytes >= nextProgressBytes) {
            nextProgressBytes += PROGRESS_LOG_STEP_BYTES;
          }
          console.log(
            `[InstallerRecovery] extract progress: entries=${entries} ` +
              `mb=${(bytes / (1024 * 1024)).toFixed(0)} elapsedMs=${Date.now() - t0}`,
          );
          onProgress?.({ entries, bytes, totalBytes });
        }
      },
    });
  } catch (error) {
    console.error(
      `[InstallerRecovery] extraction failed after ${Date.now() - t0}ms (entries=${entries}), ` +
        `keeping ${tarPath} for a later retry:`,
      error,
    );
    return {
      attempted: true,
      success: false,
      tarPath,
      entries,
      elapsedMs: Date.now() - t0,
      error: stringifyError(error),
    };
  }

  const elapsedMs = Date.now() - t0;
  if (!hasBundledRuntimeEntry(resourcesDir)) {
    console.error(
      `[InstallerRecovery] extraction finished (entries=${entries}, elapsedMs=${elapsedMs}) ` +
        `but the runtime entry or required bundle assets are still missing, keeping ${tarPath}`,
    );
    return {
      attempted: true,
      success: false,
      tarPath,
      entries,
      elapsedMs,
      error: 'runtime entry or required bundle assets are still missing after extraction',
    };
  }

  // Mirror the installer's success path: stamp the marker, drop the archive.
  try {
    fs.writeFileSync(markerPath, `${new Date().toISOString()} source=app-recovery reason=${reason}\n`);
  } catch (error) {
    console.warn('[InstallerRecovery] failed to write extraction marker:', error);
  }
  try {
    fs.rmSync(tarPath);
  } catch (error) {
    console.warn(`[InstallerRecovery] recovered, but failed to remove ${tarPath}:`, error);
  }

  console.log(`[InstallerRecovery] runtime recovered from installer tar (entries=${entries}, elapsedMs=${elapsedMs})`);
  return { attempted: true, success: true, tarPath, entries, elapsedMs };
};

let inflightRecovery: Promise<InstallerResourceRecoveryResult> | null = null;

/**
 * Extract win-resources.tar back into the resources directory if (and only
 * if) the OpenClaw runtime entry is missing. The tar is deleted only after
 * the runtime entry is confirmed present, so a failed attempt (e.g. security
 * software still holding files) can be retried later. Concurrent calls share
 * one extraction. Cheap no-op when the runtime is intact.
 */
export const recoverInstallerResourcesFromTar = (
  resourcesDir: string,
  reason: string,
  onProgress?: (progress: InstallerResourceRecoveryProgress) => void,
): Promise<InstallerResourceRecoveryResult> => {
  if (inflightRecovery) {
    return inflightRecovery;
  }
  const promise = doRecover(resourcesDir, reason, onProgress).finally(() => {
    if (inflightRecovery === promise) {
      inflightRecovery = null;
    }
  });
  inflightRecovery = promise;
  return promise;
};
