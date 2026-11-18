import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { type CompanionSelectionApp, companionSelectionAppFallback } from '../../shared/desktopCompanion/selectionApps';
import { extractIcon } from '../shellApps';

const execFileAsync = promisify(execFile);

// Resolve only the user's exclusions. Neither script opens an app or reads its content.
const MAC_APP_INFO_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  return JSON.stringify(JSON.parse(argv[0]).map(function(id) {
    try {
      var url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(id);
      if (!url || url.isNil()) return { id: id };
      var bundle = $.NSBundle.bundleWithURL(url);
      var info = bundle.localizedInfoDictionary;
      var name = ObjC.unwrap(info.objectForKey('CFBundleDisplayName')) || ObjC.unwrap(info.objectForKey('CFBundleName'));
      if (!name) {
        info = bundle.infoDictionary;
        name = ObjC.unwrap(info.objectForKey('CFBundleDisplayName')) || ObjC.unwrap(info.objectForKey('CFBundleName'));
      }
      var path = ObjC.unwrap(url.path);
      return { id: id, name: name || path.split('/').pop().replace(/\\.app$/, ''), path: path };
    } catch (_) { return { id: id }; }
  }));
}`;

const WINDOWS_APP_INFO_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ids = ConvertFrom-Json ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:LOBSTER_SELECTION_APP_IDS)))
$processes = @(Get-Process -ErrorAction SilentlyContinue)
$result = @($ids | ForEach-Object {
  $id = $_
  $exe = [System.IO.Path]::GetFileName($id)
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($exe)
  $appPath = ($processes | Where-Object { $_.ProcessName -eq $stem } | Select-Object -First 1).Path
  if (!$appPath) {
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
      $key = Get-Item -LiteralPath ($root + '\' + $exe) -ErrorAction SilentlyContinue
      if ($key) { $appPath = $key.GetValue(''); if ($appPath) { break } }
    }
  }
  $name = $null
  if ($appPath -and (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    $version = (Get-Item -LiteralPath $appPath).VersionInfo
    $name = $version.ProductName
    if (!$name) { $name = $version.FileDescription }
  }
  @{ id = $id; name = $name; path = $appPath }
})
ConvertTo-Json -InputObject $result -Compress
`;

export async function getCompanionSelectionApps(appIds: string[]): Promise<CompanionSelectionApp[]> {
  const ids = [...new Set(appIds)].slice(0, 100);
  const fallback = ids.map(companionSelectionAppFallback);
  if (!ids.length || (process.platform !== 'darwin' && process.platform !== 'win32')) return fallback;

  let metadata: unknown;
  try {
    const { stdout } = process.platform === 'darwin'
      ? await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_APP_INFO_SCRIPT, JSON.stringify(ids)], {
        timeout: 5_000, maxBuffer: 512 * 1024,
      })
      : await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_APP_INFO_SCRIPT], {
        timeout: 5_000, maxBuffer: 512 * 1024, windowsHide: true,
        env: { ...process.env, LOBSTER_SELECTION_APP_IDS: Buffer.from(JSON.stringify(ids)).toString('base64') },
      });
    metadata = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
  } catch (error) {
    console.debug('[DesktopCompanion] App details unavailable:', error);
    return fallback;
  }
  if (!Array.isArray(metadata)) return fallback;

  const entries = metadata as Array<{ id?: unknown; name?: unknown; path?: unknown } | null>;
  return Promise.all(fallback.map(async item => {
    const details = entries.find(entry => entry?.id === item.id);
    if (!details) return item;
    const result = { ...item };
    if (typeof details.name === 'string' && details.name.trim()) result.name = details.name.trim().slice(0, 200);
    if (typeof details.path === 'string' && details.path) {
      try {
        const icon = await extractIcon({ name: result.name, path: details.path, isDefault: false });
        if (icon) result.icon = icon;
      } catch {
        // Removed or inaccessible apps still remain in the list until the user removes them.
      }
    }
    return result;
  }));
}
