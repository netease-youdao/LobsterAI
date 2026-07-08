#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DMG_PATH = path.join(os.homedir(), 'Downloads', 'Codex.dmg');
const RUNTIME_VERSION = '1.0.809';
const RUNTIME_ARCHIVE_NAME = `lobsterai-computer-use-runtime-mac-arm64-${RUNTIME_VERSION}.zip`;
const SKILL_ARCHIVE_NAME = `lobsterai-computer-use-skill-mac-arm64-${RUNTIME_VERSION}.zip`;
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'resources', 'computer-use');
const RUNTIME_OUTPUT_PATH = path.join(OUTPUT_DIR, RUNTIME_ARCHIVE_NAME);
const SKILL_OUTPUT_PATH = path.join(OUTPUT_DIR, SKILL_ARCHIVE_NAME);
const ARCHIVE_TIMESTAMP = new Date('2026-01-01T00:00:00Z');
const PLUGIN_RELATIVE_PATH = path.join(
  'Codex.app',
  'Contents',
  'Resources',
  'plugins',
  'openai-bundled',
  'plugins',
  'computer-use',
);
const MAC_CLIENT_RELATIVE_PATH = 'computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient';

function parseArgs(argv) {
  const result = {
    dmgPath: DEFAULT_DMG_PATH,
    runtimeOutputPath: RUNTIME_OUTPUT_PATH,
    skillOutputPath: SKILL_OUTPUT_PATH,
    pluginDir: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--dmg' && next) {
      result.dmgPath = path.resolve(next);
      i += 1;
    } else if (arg === '--plugin-dir' && next) {
      result.pluginDir = path.resolve(next);
      i += 1;
    } else if ((arg === '--out' || arg === '--runtime-out') && next) {
      result.runtimeOutputPath = path.resolve(next);
      i += 1;
    } else if (arg === '--skill-out' && next) {
      result.skillOutputPath = path.resolve(next);
      i += 1;
    } else if (arg === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return result;
}

function printHelp() {
  console.log([
    'Usage: node scripts/extract-computer-use-mac-runtime.cjs [options]',
    '',
    'Options:',
    `  --dmg <path>         Source Codex DMG. Default: ${DEFAULT_DMG_PATH}`,
    '  --plugin-dir <path>  Already extracted computer-use plugin directory.',
    `  --out <path>         Runtime zip output. Default: ${RUNTIME_OUTPUT_PATH}`,
    `  --runtime-out <path> Runtime zip output. Default: ${RUNTIME_OUTPUT_PATH}`,
    `  --skill-out <path>   Skill bundle zip output. Default: ${SKILL_OUTPUT_PATH}`,
    '  --help              Show this help.',
  ].join('\n'));
}

function attachDmg(dmgPath) {
  if (!fs.existsSync(dmgPath)) {
    throw new Error(`DMG not found: ${dmgPath}`);
  }

  const output = execFileSync('hdiutil', ['attach', dmgPath, '-readonly', '-nobrowse'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mountPoint = output
    .split(/\r?\n/)
    .map(line => line.split(/\t+/).at(-1)?.trim())
    .find(value => value?.startsWith('/Volumes/'));
  if (!mountPoint) {
    throw new Error('Could not determine DMG mount point from hdiutil output');
  }
  return mountPoint;
}

function detachDmg(mountPoint) {
  try {
    execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'inherit' });
  } catch (error) {
    console.warn(`[extract-computer-use] failed to detach ${mountPoint}:`, error);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function ensurePluginDir(pluginDir) {
  const skillPath = path.join(pluginDir, 'skills', 'computer-use', 'SKILL.md');
  const clientPath = path.join(
    pluginDir,
    'Codex Computer Use.app',
    'Contents',
    'SharedSupport',
    'SkyComputerUseClient.app',
    'Contents',
    'MacOS',
    'SkyComputerUseClient',
  );

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Computer Use skill not found under plugin directory: ${skillPath}`);
  }
  if (!fs.existsSync(clientPath)) {
    throw new Error(`SkyComputerUseClient not found under plugin directory: ${clientPath}`);
  }
}

function writeRuntimeManifest(stageDir) {
  const manifest = {
    arch: 'arm64',
    id: 'computer-use',
    mode: 'mac-mcp-app',
    platform: 'darwin',
    version: RUNTIME_VERSION,
    mcpArgs: ['mcp'],
    mcpCommand: MAC_CLIENT_RELATIVE_PATH,
    mcpCwd: 'computer-use',
  };
  fs.writeFileSync(
    path.join(stageDir, 'runtime.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

function setArchiveTimestamps(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      setArchiveTimestamps(path.join(targetPath, entry));
    }
  }
  fs.utimesSync(targetPath, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP);
}

function buildRuntimeArchive(pluginDir, outputPath) {
  ensurePluginDir(pluginDir);

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-computer-use-mac-'));
  const stagedPluginDir = path.join(stageDir, 'computer-use');

  try {
    execFileSync('/usr/bin/ditto', [pluginDir, stagedPluginDir], {
      stdio: 'inherit',
    });
    writeRuntimeManifest(stageDir);
    setArchiveTimestamps(stageDir);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.rmSync(outputPath, { force: true });
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '.', outputPath], {
      cwd: stageDir,
      stdio: 'inherit',
    });

    return {
      outputPath,
      sha256: sha256File(outputPath),
      sizeBytes: fs.statSync(outputPath).size,
    };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function buildSkillBundle(pluginDir, outputPath) {
  ensurePluginDir(pluginDir);

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-computer-use-skill-'));
  const skillDir = path.join(stageDir, 'computer-use');
  const sourceSkillPath = path.join(pluginDir, 'skills', 'computer-use', 'SKILL.md');
  const targetSkillPath = path.join(skillDir, 'SKILL.md');

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.copyFileSync(sourceSkillPath, targetSkillPath);
    setArchiveTimestamps(stageDir);

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.rmSync(outputPath, { force: true });
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '.', outputPath], {
      cwd: stageDir,
      stdio: 'inherit',
    });

    return {
      outputPath,
      sha256: sha256File(outputPath),
      sizeBytes: fs.statSync(outputPath).size,
    };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let mountPoint = null;
  let pluginDir = options.pluginDir;

  try {
    if (!pluginDir) {
      mountPoint = attachDmg(options.dmgPath);
      pluginDir = path.join(mountPoint, PLUGIN_RELATIVE_PATH);
    }

    const result = {
      runtimeArchive: buildRuntimeArchive(pluginDir, options.runtimeOutputPath),
      skillBundle: buildSkillBundle(pluginDir, options.skillOutputPath),
    };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (mountPoint) {
      detachDmg(mountPoint);
    }
  }
}

main();
