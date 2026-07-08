import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  type ShareDeploymentAnalyzeProjectInput,
  ShareDeploymentCandidateSource,
  type ShareDeploymentDetectCandidatesInput,
  ShareDeploymentKind,
  ShareDeploymentPackageManager,
  type ShareDeploymentProjectAnalysis,
  type ShareDeploymentProjectCandidate,
} from '../../../shared/shareDeployment/constants';

const execFileAsync = promisify(execFile);

export const NODE_SERVICE_DEPLOYMENT_LIMITS = {
  MaxFiles: 50000,
  MaxSourceTotalBytes: 100 * 1024 * 1024,
  MaxDeploymentTotalBytes: 500 * 1024 * 1024,
  MaxArchiveBytes: 100 * 1024 * 1024,
  CommandTimeoutMs: 10 * 60 * 1000,
} as const;

const PACKAGE_JSON_FILE_NAME = 'package.json';
const STATIC_SITE_ENTRY_FILE = 'index.html';

const COMMON_BLOCKED_DIRECTORY_NAMES = [
  '.git',
  '.hg',
  '.svn',
  '.vite',
  '.cache',
  '.turbo',
  '.vercel',
  '.serverless',
  'coverage',
  'tmp',
  'temp',
  'logs',
] as const;

const SOURCE_BUILD_OUTPUT_DIRECTORY_NAMES = [
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.lobster-static-runtime',
  'dist',
  'build',
  'out',
] as const;

const SOURCE_BLOCKED_DIRECTORY_NAMES = new Set([
  ...COMMON_BLOCKED_DIRECTORY_NAMES,
  ...SOURCE_BUILD_OUTPUT_DIRECTORY_NAMES,
  'node_modules',
]);

const DEPLOYMENT_BLOCKED_DIRECTORY_NAMES = new Set(COMMON_BLOCKED_DIRECTORY_NAMES);
const STATIC_SITE_BLOCKED_DIRECTORY_NAMES = new Set([
  ...COMMON_BLOCKED_DIRECTORY_NAMES,
  'node_modules',
]);

const BLOCKED_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'npm-debug.log',
  'yarn-debug.log',
  'yarn-error.log',
  'pnpm-debug.log',
]);

const PROJECT_CANDIDATE_SCAN_MAX_DEPTH = 3;
const PROJECT_CANDIDATE_SCAN_MAX_DIRECTORIES = 300;
const NEXT_STANDALONE_START_COMMAND = 'node server.js';
const NITRO_OUTPUT_START_COMMAND = 'node .output/server/index.mjs';
const STATIC_BUILD_START_COMMAND = 'node server.js';
const STATIC_SITE_SUPPORTED_EXTENSION_NAMES = new Set([
  '.avif',
  '.css',
  '.csv',
  '.docx',
  '.eot',
  '.gif',
  '.html',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.json',
  '.map',
  '.markdown',
  '.md',
  '.mermaid',
  '.mjs',
  '.mmd',
  '.mp3',
  '.mp4',
  '.otf',
  '.pdf',
  '.png',
  '.pptx',
  '.svg',
  '.tsv',
  '.ttf',
  '.txt',
  '.wasm',
  '.webm',
  '.webmanifest',
  '.webp',
  '.woff',
  '.woff2',
  '.xlsx',
  '.xml',
]);

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: {
    node?: string;
  };
}

export interface NodeServicePackageEntry {
  absolutePath: string;
  archiveName: string;
  size: number;
}

export interface NodeServiceProjectPackagePlan {
  analysis: ShareDeploymentProjectAnalysis;
  entries: NodeServicePackageEntry[];
}

export interface NodeServicePackageCollection {
  entries: NodeServicePackageEntry[];
  totalBytes: number;
  excludedCount: number;
  warnings: string[];
  blockers: string[];
}

function normalizeArchiveName(value: string): string {
  return value.split(path.sep).join('/');
}

function parseLocalServicePort(value?: string): number | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch {
    // The caller will surface a missing port as a validation issue.
  }
  return undefined;
}

function isEnvFileName(name: string): boolean {
  return /^\.env(?:\.|$)/i.test(name);
}

function isSecretLikeFileName(name: string): boolean {
  return /(?:^|[-_.])(secret|credential|credentials|token|private[-_.]?key)(?:[-_.]|$)/i.test(name);
}

function isBlockedFileName(name: string): boolean {
  return BLOCKED_FILE_NAMES.has(name) || isEnvFileName(name) || isSecretLikeFileName(name);
}

function isBlockedPathPart(part: string, blockedDirectoryNames: Set<string>): boolean {
  return blockedDirectoryNames.has(part);
}

function isBlockedRootDirectory(resolvedDirectory: string): boolean {
  const normalized = path.resolve(resolvedDirectory);
  const parsed = path.parse(normalized);
  if (normalized === parsed.root) return true;

  const homeDir = path.resolve(os.homedir());
  const blockedRoots = new Set([
    homeDir,
    path.resolve(os.tmpdir()),
    path.resolve(parsed.root, 'tmp'),
    path.resolve(parsed.root, 'var', 'tmp'),
  ]);

  if (process.platform === 'win32') {
    blockedRoots.add(path.resolve(homeDir, 'Desktop'));
    blockedRoots.add(path.resolve(homeDir, 'Documents'));
    blockedRoots.add(path.resolve(homeDir, 'Downloads'));
  } else {
    blockedRoots.add('/Users');
    blockedRoots.add('/home');
    blockedRoots.add(path.resolve(homeDir, 'Desktop'));
    blockedRoots.add(path.resolve(homeDir, 'Documents'));
    blockedRoots.add(path.resolve(homeDir, 'Downloads'));
  }

  return blockedRoots.has(normalized);
}

async function readPackageJson(projectDirectory: string): Promise<PackageJson | null> {
  try {
    const text = await fs.promises.readFile(path.join(projectDirectory, PACKAGE_JSON_FILE_NAME), 'utf8');
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function hasPackageJson(directory: string): Promise<boolean> {
  return await pathExists(path.join(directory, PACKAGE_JSON_FILE_NAME));
}

async function hasStaticSiteEntryFile(directory: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(path.join(directory, STATIC_SITE_ENTRY_FILE));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findNearestProjectDirectory(startDirectory: string): Promise<string | null> {
  let current = path.resolve(startDirectory);
  while (true) {
    if (await hasPackageJson(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function findNearestStaticSiteDirectory(startDirectory: string): Promise<string | null> {
  let current = path.resolve(startDirectory);
  while (true) {
    if (await hasStaticSiteEntryFile(current)) return current;
    if (await hasPackageJson(current)) return null;
    const parent = path.dirname(current);
    if (parent === current || isBlockedRootDirectory(parent)) return null;
    current = parent;
  }
}

async function findProjectDirectoryCandidate(startDirectory?: string): Promise<string | null> {
  if (!startDirectory?.trim()) return null;
  const resolved = path.resolve(startDirectory.trim());
  try {
    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return await findNearestProjectDirectory(resolved);
}

async function findStaticSiteDirectoryCandidate(startDirectory?: string): Promise<string | null> {
  if (!startDirectory?.trim()) return null;
  const resolved = path.resolve(startDirectory.trim());
  try {
    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return await findNearestStaticSiteDirectory(resolved);
}

function resolvePackageManager(projectDirectory: string): ShareDeploymentPackageManager {
  if (fs.existsSync(path.join(projectDirectory, 'pnpm-lock.yaml'))) {
    return ShareDeploymentPackageManager.Pnpm;
  }
  if (fs.existsSync(path.join(projectDirectory, 'yarn.lock'))) {
    return ShareDeploymentPackageManager.Yarn;
  }
  if (fs.existsSync(path.join(projectDirectory, 'package-lock.json'))) {
    return ShareDeploymentPackageManager.Npm;
  }
  return ShareDeploymentPackageManager.Npm;
}

function hasNpmLockfile(projectDirectory: string): boolean {
  return fs.existsSync(path.join(projectDirectory, 'package-lock.json')) ||
    fs.existsSync(path.join(projectDirectory, 'npm-shrinkwrap.json'));
}

function resolveInstallCommand(
  projectDirectory: string,
  packageManager: ShareDeploymentPackageManager,
): string {
  switch (packageManager) {
    case ShareDeploymentPackageManager.Pnpm:
      return 'pnpm install --frozen-lockfile';
    case ShareDeploymentPackageManager.Yarn:
      return 'yarn install --frozen-lockfile';
    case ShareDeploymentPackageManager.Unknown:
      return '';
    case ShareDeploymentPackageManager.Npm:
    default:
      return hasNpmLockfile(projectDirectory) ? 'npm ci' : 'npm install';
  }
}

function scriptRunCommand(packageManager: ShareDeploymentPackageManager, scriptName: string): string {
  switch (packageManager) {
    case ShareDeploymentPackageManager.Pnpm:
      return `pnpm run ${scriptName}`;
    case ShareDeploymentPackageManager.Yarn:
      return `yarn run ${scriptName}`;
    case ShareDeploymentPackageManager.Npm:
    default:
      return `npm run ${scriptName}`;
  }
}

function resolveBuildCommand(
  packageJson: PackageJson | null,
  packageManager: ShareDeploymentPackageManager,
): string {
  const scripts = packageJson?.scripts ?? {};
  if (typeof scripts.build === 'string' && scripts.build.trim()) {
    return scriptRunCommand(packageManager, 'build');
  }
  return '';
}

function isNextProjectPackage(packageJson: PackageJson | null): boolean {
  return hasPackageDependency(packageJson, ['next']);
}

function hasPackageDependency(packageJson: PackageJson | null, packageNames: string[]): boolean {
  const dependencies = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };
  return packageNames.some(packageName => Boolean(dependencies[packageName]));
}

function hasPackageScript(packageJson: PackageJson | null, scriptName: string): boolean {
  const script = packageJson?.scripts?.[scriptName];
  return typeof script === 'string' && script.trim().length > 0;
}

function hasProductionStartScript(packageJson: PackageJson | null): boolean {
  return hasPackageScript(packageJson, 'start') || hasPackageScript(packageJson, 'serve');
}

function isNuxtProjectPackage(packageJson: PackageJson | null): boolean {
  return hasPackageDependency(packageJson, ['nuxt', 'nuxt3']);
}

function isStaticBuildProjectPackage(packageJson: PackageJson | null): boolean {
  return hasPackageDependency(packageJson, [
    'vite',
    'react-scripts',
    '@vue/cli-service',
    '@angular/cli',
    'astro',
    'parcel',
    '@sveltejs/vite-plugin-svelte',
  ]);
}

function isSupportedStaticSiteFileName(name: string): boolean {
  return STATIC_SITE_SUPPORTED_EXTENSION_NAMES.has(path.extname(name).toLowerCase());
}

function isSvelteKitProjectPackage(packageJson: PackageJson | null): boolean {
  return hasPackageDependency(packageJson, ['@sveltejs/kit', '@sveltejs/vite-plugin-svelte']);
}

function hasSvelteKitProductionAdapter(packageJson: PackageJson | null): boolean {
  return hasPackageDependency(packageJson, [
    '@sveltejs/adapter-static',
    '@sveltejs/adapter-node',
    '@sveltejs/adapter-vercel',
    '@sveltejs/adapter-netlify',
    '@sveltejs/adapter-cloudflare',
  ]);
}

function isDevStartCommand(command: string): boolean {
  return command.endsWith(' run dev') || command.endsWith(' dev');
}

function deploymentReadinessBlockers(
  packageJson: PackageJson | null,
  startCommand: string,
): string[] {
  if (!packageJson) return [];

  const blockers: string[] = [];
  if (isDevStartCommand(startCommand) && !hasProductionStartScript(packageJson)) {
    blockers.push(
      'This project only defines a development start command. Add a production start/serve script or configure a supported static build before sharing.',
    );
  }

  if (
    isSvelteKitProjectPackage(packageJson) &&
    hasPackageDependency(packageJson, ['@sveltejs/adapter-auto']) &&
    !hasSvelteKitProductionAdapter(packageJson) &&
    !hasProductionStartScript(packageJson)
  ) {
    blockers.push(
      'This SvelteKit project uses @sveltejs/adapter-auto without a production deployment adapter. Use @sveltejs/adapter-static for static sharing, or @sveltejs/adapter-node with a start script such as "node build/index.js".',
    );
  }

  return blockers;
}

function resolveStartCommand(
  packageJson: PackageJson | null,
  packageManager: ShareDeploymentPackageManager,
): string {
  if (
    isNextProjectPackage(packageJson) &&
    hasPackageScript(packageJson, 'build')
  ) {
    return NEXT_STANDALONE_START_COMMAND;
  }
  if (
    isNuxtProjectPackage(packageJson) &&
    hasPackageScript(packageJson, 'build')
  ) {
    return NITRO_OUTPUT_START_COMMAND;
  }
  if (
    isStaticBuildProjectPackage(packageJson) &&
    hasPackageScript(packageJson, 'build')
  ) {
    return STATIC_BUILD_START_COMMAND;
  }
  if (hasPackageScript(packageJson, 'start')) return scriptRunCommand(packageManager, 'start');
  if (hasPackageScript(packageJson, 'serve')) return scriptRunCommand(packageManager, 'serve');
  if (hasPackageScript(packageJson, 'dev')) return scriptRunCommand(packageManager, 'dev');
  return '';
}

function resolveDeploymentKind(
  packageJson: PackageJson | null,
  isStaticSiteDirectory: boolean,
): ShareDeploymentKind {
  if (!packageJson && isStaticSiteDirectory) {
    return ShareDeploymentKind.StaticSite;
  }
  if (isStaticBuildProjectPackage(packageJson) && !isNextProjectPackage(packageJson) && !isNuxtProjectPackage(packageJson)) {
    return ShareDeploymentKind.StaticSite;
  }
  return ShareDeploymentKind.NodeService;
}

function hasRunnableScript(packageJson: PackageJson | null): boolean {
  if (
    isNextProjectPackage(packageJson) &&
    hasPackageScript(packageJson, 'build')
  ) {
    return true;
  }
  if (
    (isNuxtProjectPackage(packageJson) || isStaticBuildProjectPackage(packageJson)) &&
    hasPackageScript(packageJson, 'build')
  ) {
    return true;
  }
  return ['start', 'serve', 'dev'].some(scriptName => {
    return hasPackageScript(packageJson, scriptName);
  });
}

async function isUsableNodeProjectDirectory(projectDirectory: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(projectDirectory);
    if (!stat.isDirectory() || isBlockedRootDirectory(projectDirectory)) return false;
    const packageJson = await readPackageJson(projectDirectory);
    return hasRunnableScript(packageJson);
  } catch {
    return false;
  }
}

async function isUsableStaticSiteDirectory(projectDirectory: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(projectDirectory);
    return stat.isDirectory() &&
      !isBlockedRootDirectory(projectDirectory) &&
      await hasStaticSiteEntryFile(projectDirectory);
  } catch {
    return false;
  }
}

async function isUsableProjectDirectory(projectDirectory: string): Promise<boolean> {
  return await isUsableNodeProjectDirectory(projectDirectory) ||
    await isUsableStaticSiteDirectory(projectDirectory);
}

function resolveNodeVersion(packageJson: PackageJson | null): string {
  const engine = packageJson?.engines?.node;
  if (typeof engine !== 'string') return '20';
  const majorMatch = engine.match(/(?:^|[^\d])(\d{2})(?:[^\d]|$)/);
  const major = majorMatch?.[1];
  if (major === '18' || major === '20' || major === '22') return major;
  return '20';
}

async function collectPackageEntries(
  projectDirectory: string,
  blockedDirectoryNames: Set<string>,
  maxTotalBytes: number,
): Promise<NodeServicePackageCollection> {
  const entries: NodeServicePackageEntry[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  let totalBytes = 0;
  let excludedCount = 0;

  async function walk(directory: string): Promise<void> {
    if (blockers.length > 0) return;

    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (blockers.length > 0) return;
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(projectDirectory, absolutePath);
      const relativeParts = relativePath.split(path.sep).filter(Boolean);
      if (
        relativeParts.some(part => isBlockedPathPart(part, blockedDirectoryNames)) ||
        isBlockedFileName(child.name)
      ) {
        excludedCount += 1;
        continue;
      }
      if (child.isSymbolicLink()) {
        excludedCount += 1;
        continue;
      }
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!child.isFile()) {
        excludedCount += 1;
        continue;
      }

      const stat = await fs.promises.stat(absolutePath);
      totalBytes += stat.size;
      entries.push({
        absolutePath,
        archiveName: normalizeArchiveName(relativePath),
        size: stat.size,
      });
      if (entries.length > NODE_SERVICE_DEPLOYMENT_LIMITS.MaxFiles) {
        blockers.push(`Project has more than ${NODE_SERVICE_DEPLOYMENT_LIMITS.MaxFiles} files after exclusions.`);
        return;
      }
      if (totalBytes > maxTotalBytes) {
        blockers.push(
          `Project files exceed ${Math.floor(maxTotalBytes / 1024 / 1024)}MB after exclusions.`,
        );
        return;
      }
    }
  }

  await walk(projectDirectory);

  if (excludedCount > 0) {
    warnings.push(`${excludedCount} files or directories will be excluded from the deployment package.`);
  }

  return {
    entries: entries.sort((a, b) => a.archiveName.localeCompare(b.archiveName)),
    totalBytes,
    excludedCount,
    warnings,
    blockers,
  };
}

export async function collectNodeServiceDeploymentPackageEntries(
  projectDirectory: string,
): Promise<NodeServicePackageCollection> {
  return await collectPackageEntries(
    projectDirectory,
    DEPLOYMENT_BLOCKED_DIRECTORY_NAMES,
    NODE_SERVICE_DEPLOYMENT_LIMITS.MaxDeploymentTotalBytes,
  );
}

export async function collectStaticSiteDeploymentPackageEntries(
  projectDirectory: string,
): Promise<NodeServicePackageCollection> {
  const entries: NodeServicePackageEntry[] = [];
  const warnings: string[] = [];
  const blockers: string[] = [];
  let totalBytes = 0;
  let excludedCount = 0;

  async function walk(directory: string): Promise<void> {
    if (blockers.length > 0) return;

    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const child of children) {
      if (blockers.length > 0) return;
      const absolutePath = path.join(directory, child.name);
      const relativePath = path.relative(projectDirectory, absolutePath);
      const relativeParts = relativePath.split(path.sep).filter(Boolean);
      if (
        relativeParts.some(part => isBlockedPathPart(part, STATIC_SITE_BLOCKED_DIRECTORY_NAMES)) ||
        isBlockedFileName(child.name) ||
        child.isSymbolicLink()
      ) {
        excludedCount += 1;
        continue;
      }
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!child.isFile() || !isSupportedStaticSiteFileName(child.name)) {
        excludedCount += 1;
        continue;
      }

      const stat = await fs.promises.stat(absolutePath);
      totalBytes += stat.size;
      entries.push({
        absolutePath,
        archiveName: normalizeArchiveName(relativePath),
        size: stat.size,
      });
      if (entries.length > NODE_SERVICE_DEPLOYMENT_LIMITS.MaxFiles) {
        blockers.push(`Project has more than ${NODE_SERVICE_DEPLOYMENT_LIMITS.MaxFiles} files after exclusions.`);
        return;
      }
      if (totalBytes > NODE_SERVICE_DEPLOYMENT_LIMITS.MaxDeploymentTotalBytes) {
        blockers.push(
          `Project files exceed ${Math.floor(NODE_SERVICE_DEPLOYMENT_LIMITS.MaxDeploymentTotalBytes / 1024 / 1024)}MB after exclusions.`,
        );
        return;
      }
    }
  }

  await walk(projectDirectory);

  if (excludedCount > 0) {
    warnings.push(`${excludedCount} files or directories will be excluded from the static deployment package.`);
  }

  return {
    entries: entries.sort((a, b) => a.archiveName.localeCompare(b.archiveName)),
    totalBytes,
    excludedCount,
    warnings,
    blockers,
  };
}

export async function buildNodeServiceProjectPackagePlan(
  input: ShareDeploymentAnalyzeProjectInput,
): Promise<NodeServiceProjectPackagePlan> {
  const projectDirectory = path.resolve(input.projectDirectory.trim());
  const warnings: string[] = [];
  const blockers: string[] = [];

  let stat: fs.Stats | null = null;
  try {
    stat = await fs.promises.stat(projectDirectory);
  } catch {
    blockers.push('Project directory does not exist.');
  }

  if (stat && !stat.isDirectory()) {
    blockers.push('Project path must be a directory.');
  }

  if (isBlockedRootDirectory(projectDirectory)) {
    blockers.push('Choose a project subdirectory instead of a system, home, or shared root directory.');
  }

  const isStaticSiteDirectory = stat?.isDirectory()
    ? await hasStaticSiteEntryFile(projectDirectory)
    : false;
  const packageJson = await readPackageJson(projectDirectory);
  if (!packageJson && !isStaticSiteDirectory) {
    blockers.push('Project directory must contain package.json or index.html.');
  }

  const packageManager = packageJson
    ? resolvePackageManager(projectDirectory)
    : ShareDeploymentPackageManager.Unknown;
  const installCommand = resolveInstallCommand(projectDirectory, packageManager);
  const buildCommand = resolveBuildCommand(packageJson, packageManager);
  const startCommand = resolveStartCommand(packageJson, packageManager);
  const deploymentKind = resolveDeploymentKind(packageJson, isStaticSiteDirectory);
  const nodeVersion = resolveNodeVersion(packageJson);
  const port = parseLocalServicePort(input.localServiceUrl);

  if (!startCommand && deploymentKind !== ShareDeploymentKind.StaticSite) {
    blockers.push('package.json must define a start, serve, or dev script.');
  }
  blockers.push(...deploymentReadinessBlockers(packageJson, startCommand));
  if (!port) {
    blockers.push('Local service URL must include a valid port.');
  }
  if (isDevStartCommand(startCommand) && !blockers.length) {
    warnings.push('Only a dev script was found. Confirm the service can run in a cloud deployment.');
  }
  if (packageJson && packageManager === ShareDeploymentPackageManager.Npm && !hasNpmLockfile(projectDirectory)) {
    warnings.push('No npm lockfile was found. npm install behavior may be less reproducible.');
  }

  const shouldCollectPackageEntries = Boolean(stat?.isDirectory() && blockers.length === 0);
  const collected = shouldCollectPackageEntries
    ? deploymentKind === ShareDeploymentKind.StaticSite && !packageJson
      ? await collectStaticSiteDeploymentPackageEntries(projectDirectory)
      : await collectPackageEntries(
          projectDirectory,
          SOURCE_BLOCKED_DIRECTORY_NAMES,
          NODE_SERVICE_DEPLOYMENT_LIMITS.MaxSourceTotalBytes,
        )
    : {
        entries: [],
        totalBytes: 0,
        excludedCount: 0,
        warnings: [],
        blockers: [],
      };

  const analysis: ShareDeploymentProjectAnalysis = {
    success: blockers.length === 0 && collected.blockers.length === 0,
    projectDirectory,
    packageName: typeof packageJson?.name === 'string' ? packageJson.name : undefined,
    packageVersion: typeof packageJson?.version === 'string' ? packageJson.version : undefined,
    deploymentKind,
    entryFile: deploymentKind === ShareDeploymentKind.StaticSite ? 'index.html' : undefined,
    spaFallback: deploymentKind === ShareDeploymentKind.StaticSite ? true : undefined,
    packageManager,
    nodeVersion,
    installCommand,
    buildCommand,
    startCommand,
    port,
    totalFiles: collected.entries.length,
    totalBytes: collected.totalBytes,
    excludedCount: collected.excludedCount,
    warnings: [...warnings, ...collected.warnings],
    blockers: [...blockers, ...collected.blockers],
  };

  return {
    analysis,
    entries: collected.entries,
  };
}

export async function analyzeNodeServiceProjectDirectory(
  input: ShareDeploymentAnalyzeProjectInput,
): Promise<ShareDeploymentProjectAnalysis> {
  try {
    return (await buildNodeServiceProjectPackagePlan(input)).analysis;
  } catch (error) {
    return {
      success: false,
      projectDirectory: input.projectDirectory,
      packageManager: ShareDeploymentPackageManager.Unknown,
      nodeVersion: '20',
      installCommand: 'npm install',
      buildCommand: '',
      startCommand: '',
      totalFiles: 0,
      totalBytes: 0,
      excludedCount: 0,
      warnings: [],
      blockers: [error instanceof Error ? error.message : 'Failed to analyze project directory.'],
    };
  }
}

async function getPidListeningOnPort(port: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      timeout: 1500,
    });
    const pidLine = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => /^p\d+$/.test(line));
    return pidLine ? pidLine.slice(1) : null;
  } catch {
    return null;
  }
}

async function getProcessCwd(pid: string): Promise<string | null> {
  if (process.platform === 'win32') return null;
  if (process.platform === 'darwin') {
    const procCwd = `/proc/${pid}/cwd`;
    try {
      return await fs.promises.realpath(procCwd);
    } catch {
      // macOS does not expose /proc by default; fall through to lsof.
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], {
      timeout: 1500,
    });
    const cwdLine = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line.startsWith('n'));
    return cwdLine ? cwdLine.slice(1) : null;
  } catch {
    return null;
  }
}

function pushUniqueCandidate(
  candidates: ShareDeploymentProjectCandidate[],
  candidate: ShareDeploymentProjectCandidate | null,
): void {
  if (!candidate?.directory) return;
  const normalized = path.resolve(candidate.directory);
  const normalizedCandidate: ShareDeploymentProjectCandidate = {
    ...candidate,
    directory: normalized,
    confidence: Math.max(0, Math.min(100, Math.round(candidate.confidence))),
    detectedAt: candidate.detectedAt ?? Date.now(),
  };
  const existingIndex = candidates.findIndex(item => path.resolve(item.directory) === normalized);
  if (existingIndex >= 0) {
    if (normalizedCandidate.confidence > candidates[existingIndex].confidence) {
      candidates[existingIndex] = normalizedCandidate;
    }
    return;
  }
  candidates.push(normalizedCandidate);
}

async function pushUsableInputCandidate(
  candidates: ShareDeploymentProjectCandidate[],
  candidate: ShareDeploymentProjectCandidate | null,
): Promise<void> {
  if (!candidate?.directory?.trim()) return;
  const directory = path.resolve(candidate.directory.trim());
  if (!await isUsableProjectDirectory(directory)) return;
  pushUniqueCandidate(candidates, {
    ...candidate,
    directory,
  });
}

async function findWorkspaceChildProjectCandidates(
  workingDirectory?: string,
): Promise<ShareDeploymentProjectCandidate[]> {
  if (!workingDirectory?.trim()) return [];

  const root = path.resolve(workingDirectory.trim());
  try {
    const stat = await fs.promises.stat(root);
    if (!stat.isDirectory() || isBlockedRootDirectory(root)) return [];
  } catch {
    return [];
  }

  const candidates: ShareDeploymentProjectCandidate[] = [];
  let visitedDirectories = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > PROJECT_CANDIDATE_SCAN_MAX_DEPTH) return;
    if (visitedDirectories >= PROJECT_CANDIDATE_SCAN_MAX_DIRECTORIES) return;

    let children: fs.Dirent[];
    try {
      children = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const child of children) {
      if (visitedDirectories >= PROJECT_CANDIDATE_SCAN_MAX_DIRECTORIES) return;
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      if (isBlockedPathPart(child.name, SOURCE_BLOCKED_DIRECTORY_NAMES)) continue;

      const childDirectory = path.join(directory, child.name);
      visitedDirectories += 1;
      if (await isUsableProjectDirectory(childDirectory)) {
        pushUniqueCandidate(candidates, {
          directory: childDirectory,
          source: ShareDeploymentCandidateSource.WorkspaceChild,
          confidence: Math.max(50, 76 - depth * 6),
          reason: 'Found a deployable project under the current workspace directory.',
        });
      }

      await walk(childDirectory, depth + 1);
    }
  }

  await walk(root, 1);
  return candidates;
}

export async function detectNodeServiceProjectCandidates(
  input: ShareDeploymentDetectCandidatesInput,
): Promise<ShareDeploymentProjectCandidate[]> {
  const candidates: ShareDeploymentProjectCandidate[] = [];
  const port = parseLocalServicePort(input.localServiceUrl);

  if (port) {
    const pid = await getPidListeningOnPort(port);
    const cwd = pid ? await getProcessCwd(pid) : null;
    const projectDirectory = cwd ? await findProjectDirectoryCandidate(cwd) : null;
    const usableProjectDirectory =
      projectDirectory && await isUsableNodeProjectDirectory(projectDirectory)
        ? projectDirectory
        : null;
    pushUniqueCandidate(
      candidates,
      usableProjectDirectory
        ? {
            directory: usableProjectDirectory,
            source: ShareDeploymentCandidateSource.ProcessCwd,
            confidence: 95,
            reason: `Matched the process listening on port ${port}.`,
            pid: Number(pid),
          }
        : null,
    );
    if (!usableProjectDirectory) {
      const staticSiteDirectory = cwd ? await findStaticSiteDirectoryCandidate(cwd) : null;
      const usableStaticSiteDirectory =
        staticSiteDirectory && await isUsableStaticSiteDirectory(staticSiteDirectory)
          ? staticSiteDirectory
          : null;
      pushUniqueCandidate(
        candidates,
        usableStaticSiteDirectory
          ? {
              directory: usableStaticSiteDirectory,
              source: ShareDeploymentCandidateSource.ProcessCwd,
              confidence: 95,
              reason: `Matched the static site directory served by the process listening on port ${port}.`,
              pid: Number(pid),
            }
          : null,
      );
    }
  }

  for (const candidate of input.projectCandidates ?? []) {
    await pushUsableInputCandidate(candidates, candidate);
  }

  await pushUsableInputCandidate(
    candidates,
    input.cachedProjectDirectory?.trim()
      ? {
          directory: input.cachedProjectDirectory,
          source: ShareDeploymentCandidateSource.Cache,
          confidence: 35,
          reason: 'Matched the previously used project directory for this local service origin.',
        }
      : null,
  );

  const workspaceProjectDirectory =
    await findProjectDirectoryCandidate(input.workingDirectory) ??
    await findStaticSiteDirectoryCandidate(input.workingDirectory);
  const usableWorkspaceProjectDirectory =
    workspaceProjectDirectory && await isUsableProjectDirectory(workspaceProjectDirectory)
      ? workspaceProjectDirectory
      : null;
  pushUniqueCandidate(
    candidates,
    usableWorkspaceProjectDirectory
      ? {
          directory: usableWorkspaceProjectDirectory,
          source: ShareDeploymentCandidateSource.Workspace,
          confidence: 60,
          reason: 'Matched the current workspace directory.',
        }
      : null,
  );

  for (const childProjectCandidate of await findWorkspaceChildProjectCandidates(input.workingDirectory)) {
    pushUniqueCandidate(candidates, childProjectCandidate);
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}
