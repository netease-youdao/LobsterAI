import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import yazl from 'yazl';

import {
  ShareDeploymentKind,
  ShareDeploymentPackageManager,
  type ShareDeploymentPersistence,
  ShareDeploymentPersistenceBindingKind,
  type ShareDeploymentProjectAnalysis,
} from '../../../shared/shareDeployment/constants';
import { getNodeToolEnv } from '../coworkUtil';
import {
  buildNodeServiceProjectPackagePlan,
  collectNodeServiceDeploymentPackageEntries,
  collectStaticSiteDeploymentPackageEntries,
  NODE_SERVICE_DEPLOYMENT_LIMITS,
  type NodeServicePackageCollection,
  type NodeServicePackageEntry,
} from './nodeServiceProjectAnalyzer';

const execFileAsync = promisify(execFile);
const COMMAND_OUTPUT_TAIL_CHARS = 4000;
const COMMAND_OUTPUT_MAX_LINES = 24;
const COMMAND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const NEXT_STANDALONE_START_COMMAND = 'node server.js';
const NITRO_OUTPUT_START_COMMAND = 'node .output/server/index.mjs';
const STATIC_BUILD_START_COMMAND = 'node server.js';
const STATIC_SITE_ENTRY_FILE = 'index.html';
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const NEXT_DOCUMENT_IMPORT_ERROR_PATTERN = /<Html>\s+should\s+not\s+be\s+imported\s+outside\s+of\s+pages\/_document/;
const MISSING_NODE_TOOL_PATTERN =
  /(?:^|\n)(?:.*?:\s*)?(node|npm|npx|pnpm|yarn)(?:\.cmd)?:\s+command not found\b/i;
const STALE_BUILD_OUTPUT_DIRECTORY_NAMES = [
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.lobster-static-runtime',
  'dist',
  'build',
  'out',
] as const;

export interface NodeServiceDeploymentPackageInput {
  projectDirectory: string;
  localServiceUrl?: string;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: number;
  persistence?: ShareDeploymentPersistence;
}

export interface NodeServiceDeploymentPackageResult {
  archivePath: string;
  sourceSha256: string;
  analysis: ShareDeploymentProjectAnalysis;
  deploymentKind: ShareDeploymentKind;
  entryFile?: string;
  spaFallback?: boolean;
  totalFiles: number;
  totalBytes: number;
  archiveBytes: number;
  warnings: string[];
}

async function writeZip(entries: NodeServicePackageEntry[]): Promise<{
  archivePath: string;
  sourceSha256: string;
  archiveBytes: number;
}> {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-node-deploy-'));
  const archivePath = path.join(tempDir, 'deployment.zip');
  const zipFile = new yazl.ZipFile();

  zipFile.on('error', (error) => {
    (zipFile.outputStream as unknown as { destroy(error: Error): void }).destroy(error as Error);
  });

  for (const entry of entries) {
    zipFile.addFile(entry.absolutePath, entry.archiveName);
  }

  const outputStream = fs.createWriteStream(archivePath);
  const pipelinePromise = pipeline(zipFile.outputStream, outputStream);
  zipFile.end();
  await pipelinePromise;

  const stat = await fs.promises.stat(archivePath);
  if (stat.size > NODE_SERVICE_DEPLOYMENT_LIMITS.MaxArchiveBytes) {
    throw new Error(
      `Deployment package is too large. The limit is ${Math.floor(NODE_SERVICE_DEPLOYMENT_LIMITS.MaxArchiveBytes / 1024 / 1024)}MB.`,
    );
  }

  const buffer = await fs.promises.readFile(archivePath);
  return {
    archivePath,
    sourceSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    archiveBytes: stat.size,
  };
}

async function copyPackageEntries(entries: NodeServicePackageEntry[], targetDirectory: string): Promise<void> {
  await fs.promises.mkdir(targetDirectory, { recursive: true });
  for (const entry of entries) {
    const destination = path.join(targetDirectory, entry.archiveName);
    const parent = path.dirname(destination);
    await fs.promises.mkdir(parent, { recursive: true });
    await fs.promises.copyFile(entry.absolutePath, destination);
  }
}

function shellCommandArgs(command: string): {
  file: string;
  args: string[];
} {
  if (process.platform === 'win32') {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    };
  }
  return {
    file: '/bin/sh',
    args: ['-lc', command],
  };
}

function commandEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  port?: number,
  extraEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  const portValue = String(port || 8000);
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.NODE_ENV;
  delete env.NEXT_RUNTIME;
  delete env.NEXT_PHASE;
  delete env.__NEXT_PROCESSED_ENV;
  return {
    ...env,
    CI: 'true',
    PORT: portValue,
    HOST: '0.0.0.0',
    HOSTNAME: '0.0.0.0',
    ...extraEnv,
  };
}

function outputTail(value: string): string {
  return value.length <= COMMAND_OUTPUT_TAIL_CHARS
    ? value
    : value.slice(value.length - COMMAND_OUTPUT_TAIL_CHARS);
}

function commandOutputPathAliases(projectDirectory: string): string[] {
  const normalizedProjectDirectory = path.resolve(projectDirectory);
  const aliases = new Set([normalizedProjectDirectory]);
  if (normalizedProjectDirectory.startsWith('/var/')) {
    aliases.add(`/private${normalizedProjectDirectory}`);
  } else if (normalizedProjectDirectory.startsWith('/private/var/')) {
    aliases.add(normalizedProjectDirectory.slice('/private'.length));
  }
  return Array.from(aliases).sort((a, b) => b.length - a.length);
}

function sanitizeCommandOutput(value: string, projectDirectory: string): string {
  let output = value.replace(ANSI_ESCAPE_PATTERN, '');
  for (const alias of commandOutputPathAliases(projectDirectory)) {
    output = output.split(alias).join('<deployment-temp>/project');
  }
  return output.trim();
}

function commandFailureHint(label: string, output: string): string {
  const missingToolMatch = output.match(MISSING_NODE_TOOL_PATTERN);
  if (missingToolMatch?.[1]) {
    return `Deployment could not find ${missingToolMatch[1]} in the prepared Node tool environment.`;
  }
  if (NEXT_DOCUMENT_IMPORT_ERROR_PATTERN.test(output)) {
    if (label !== 'build') return '';
    return [
      'Next.js build failed: <Html> from next/document can only be used in pages/_document.',
      'Remove that import from pages/components such as pages/404, or move document markup into pages/_document.',
    ].join(' ');
  }
  return '';
}

function conciseNextDocumentImportErrorOutput(output: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      !trimmed.includes('Error occurred prerendering page') &&
      !trimmed.includes('<Html> should not be imported outside of pages/_document') &&
      !trimmed.includes('nextjs.org/docs/messages/no-document-import-in-page')
    ) {
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    lines.push(trimmed);
  }
  return lines.slice(0, COMMAND_OUTPUT_MAX_LINES).join('\n');
}

function formatCommandOutputForError(output: string): string {
  if (NEXT_DOCUMENT_IMPORT_ERROR_PATTERN.test(output)) {
    return conciseNextDocumentImportErrorOutput(output);
  }
  return outputTail(output);
}

function errorOutput(error: unknown, projectDirectory: string): string {
  const source = error as {
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const stdout = typeof source.stdout === 'string' ? source.stdout.trim() : '';
  const stderr = typeof source.stderr === 'string' ? source.stderr.trim() : '';
  const message = typeof source.message === 'string' ? source.message.trim() : '';
  const sanitized = sanitizeCommandOutput([stderr, stdout, message].filter(Boolean).join('\n'), projectDirectory);
  return formatCommandOutputForError(sanitized);
}

async function runDeploymentCommand(
  projectDirectory: string,
  command: string,
  label: string,
  baseEnv: NodeJS.ProcessEnv,
  port?: number,
  extraEnv?: Record<string, string>,
): Promise<void> {
  const trimmed = command.trim();
  if (!trimmed) return;

  const shell = shellCommandArgs(trimmed);
  try {
    await execFileAsync(shell.file, shell.args, {
      cwd: projectDirectory,
      env: commandEnvironment(baseEnv, port, extraEnv),
      timeout: NODE_SERVICE_DEPLOYMENT_LIMITS.CommandTimeoutMs,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const output = errorOutput(error, projectDirectory);
    const hint = commandFailureHint(label, output);
    throw new Error(
      [
        `Node service deployment ${label} command failed: ${trimmed}`,
        hint,
        output,
      ].filter(Boolean).join('\n'),
    );
  }
}

async function removeStaleBuildOutputs(projectDirectory: string): Promise<void> {
  await Promise.all(
    STALE_BUILD_OUTPUT_DIRECTORY_NAMES.map(directoryName =>
      fs.promises.rm(path.join(projectDirectory, directoryName), { recursive: true, force: true }),
    ),
  );
}

function pruneCommand(packageManager: ShareDeploymentPackageManager): string {
  switch (packageManager) {
    case ShareDeploymentPackageManager.Npm:
      return 'npm prune --omit=dev';
    case ShareDeploymentPackageManager.Pnpm:
      return 'pnpm prune --prod';
    case ShareDeploymentPackageManager.Yarn:
    default:
      return '';
  }
}

function effectiveCommand(
  value: string | undefined,
  fallback: string,
  options: { blankUsesFallback?: boolean } = {},
): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  if (value !== undefined && !options.blankUsesFallback) return '';
  return fallback;
}

async function runProductionDependencyPrune(
  projectDirectory: string,
  packageManager: ShareDeploymentPackageManager,
  commandWarnings: string[],
  baseEnv: NodeJS.ProcessEnv,
  port?: number,
): Promise<void> {
  const prune = pruneCommand(packageManager);
  if (!prune) return;

  try {
    await runDeploymentCommand(projectDirectory, prune, 'production dependency pruning', baseEnv, port);
  } catch (error) {
    commandWarnings.push(error instanceof Error ? error.message : 'Production dependency pruning failed.');
  }
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readPackageJson(projectDirectory: string): Promise<PackageJson | null> {
  try {
    const raw = await fs.promises.readFile(path.join(projectDirectory, 'package.json'), 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function isNextPackageJson(packageJson: PackageJson | null): boolean {
  return hasPackageDependency(packageJson, ['next']);
}

function hasPackageDependency(packageJson: PackageJson | null, packageNames: string[]): boolean {
  const dependencies = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };
  return packageNames.some(packageName => Boolean(dependencies[packageName]));
}

function isStaticBuildPackageJson(packageJson: PackageJson | null): boolean {
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

async function shouldUseNextStandalonePackage(packageJson: PackageJson | null, buildCommand: string): Promise<boolean> {
  if (!buildCommand.trim()) return false;
  return isNextPackageJson(packageJson);
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

function resolvePackageScriptStartCommand(
  packageJson: PackageJson | null,
  packageManager: ShareDeploymentPackageManager,
): string {
  const scripts = packageJson?.scripts ?? {};
  if (typeof scripts.start === 'string' && scripts.start.trim()) {
    return scriptRunCommand(packageManager, 'start');
  }
  if (typeof scripts.serve === 'string' && scripts.serve.trim()) {
    return scriptRunCommand(packageManager, 'serve');
  }
  if (typeof scripts.dev === 'string' && scripts.dev.trim()) {
    return scriptRunCommand(packageManager, 'dev');
  }
  return '';
}

function isGeneratedOptimizedStartCommand(command: string): boolean {
  return command === NEXT_STANDALONE_START_COMMAND ||
    command === NITRO_OUTPUT_START_COMMAND ||
    command === STATIC_BUILD_START_COMMAND;
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeRelativeArchiveName(value: string): string | null {
  let normalized = value.replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some(part => part === '..')
  ) {
    return null;
  }
  return normalized;
}

async function includePersistenceEntries(
  collection: NodeServicePackageCollection,
  sourceEntries: NodeServicePackageEntry[],
  projectDirectory: string,
  persistence?: ShareDeploymentPersistence,
): Promise<NodeServicePackageCollection> {
  if (!persistence?.enabled || persistence.bindings.length === 0) {
    return collection;
  }

  const selectedEntries = new Map<string, NodeServicePackageEntry>();
  for (const binding of persistence.bindings) {
    const appPath = normalizeRelativeArchiveName(binding.appPath);
    if (!appPath) continue;
    const directoryPrefix = `${appPath}/`;
    for (const entry of sourceEntries) {
      const selected = binding.kind === ShareDeploymentPersistenceBindingKind.Directory
        ? entry.archiveName.startsWith(directoryPrefix)
        : entry.archiveName === appPath;
      if (selected) {
        selectedEntries.set(entry.archiveName, entry);
      }
    }
  }

  if (selectedEntries.size === 0) {
    return collection;
  }

  const entriesByArchiveName = new Map(
    collection.entries.map(entry => [entry.archiveName, entry]),
  );
  let totalBytes = collection.totalBytes;
  for (const sourceEntry of selectedEntries.values()) {
    if (entriesByArchiveName.has(sourceEntry.archiveName)) continue;
    const absolutePath = path.join(projectDirectory, sourceEntry.archiveName);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    entriesByArchiveName.set(sourceEntry.archiveName, {
      absolutePath,
      archiveName: sourceEntry.archiveName,
      size: stat.size,
    });
    totalBytes += stat.size;
  }

  const blockers = [...collection.blockers];
  if (entriesByArchiveName.size > NODE_SERVICE_DEPLOYMENT_LIMITS.MaxFiles) {
    blockers.push(`Project has more than ${NODE_SERVICE_DEPLOYMENT_LIMITS.MaxFiles} files after exclusions.`);
  }
  if (totalBytes > NODE_SERVICE_DEPLOYMENT_LIMITS.MaxDeploymentTotalBytes) {
    blockers.push(
      `Project files exceed ${Math.floor(NODE_SERVICE_DEPLOYMENT_LIMITS.MaxDeploymentTotalBytes / 1024 / 1024)}MB after exclusions.`,
    );
  }

  return {
    ...collection,
    entries: Array.from(entriesByArchiveName.values())
      .sort((a, b) => a.archiveName.localeCompare(b.archiveName)),
    totalBytes,
    blockers,
  };
}

function nodeStartCommandEntryName(command: string): string | null {
  const tokens = shellTokens(command.trim());
  if (tokens.length < 2) return null;

  const binary = path.basename(tokens[0]).toLowerCase().replace(/\.exe$/, '');
  if (binary !== 'node' && binary !== 'nodejs') return null;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-e' || token === '--eval' || token === '-p' || token === '--print') {
      return null;
    }
    if (token === '-r' || token === '--require' || token === '--loader' || token === '--import') {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      continue;
    }

    const entryName = normalizeRelativeArchiveName(token);
    if (!entryName || !/\.(?:cjs|js|mjs|ts)$/i.test(entryName)) {
      return null;
    }
    return entryName;
  }

  return null;
}

function missingNodeStartCommandEntryName(
  collection: NodeServicePackageCollection,
  startCommand: string,
): string | null {
  const entryName = nodeStartCommandEntryName(startCommand);
  if (!entryName) return null;
  return collection.entries.some(entry => entry.archiveName === entryName) ? null : entryName;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isBlockedDeploymentFileName(name: string): boolean {
  return name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    /^\.env(?:\.|$)/i.test(name) ||
    /(?:^|[-_.])(secret|credential|credentials|token|private[-_.]?key)(?:[-_.]|$)/i.test(name);
}

async function collectDeploymentDirectoryEntries(
  sourceDirectory: string,
  archivePrefix: string,
  entriesByArchiveName: Map<string, NodeServicePackageEntry>,
  state: {
    totalBytes: number;
    excludedCount: number;
    blockers: string[];
  },
): Promise<void> {
  if (state.blockers.length > 0) return;

  let children: fs.Dirent[];
  try {
    children = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const child of children) {
    if (state.blockers.length > 0) return;

    const absolutePath = path.join(sourceDirectory, child.name);
    const relativeName = archivePrefix
      ? path.posix.join(archivePrefix, child.name)
      : child.name;

    if (isBlockedDeploymentFileName(child.name) || child.isSymbolicLink()) {
      state.excludedCount += 1;
      continue;
    }

    if (child.isDirectory()) {
      await collectDeploymentDirectoryEntries(absolutePath, relativeName, entriesByArchiveName, state);
      continue;
    }

    if (!child.isFile()) {
      state.excludedCount += 1;
      continue;
    }

    const stat = await fs.promises.stat(absolutePath);
    state.totalBytes += stat.size;
    entriesByArchiveName.set(relativeName, {
      absolutePath,
      archiveName: relativeName,
      size: stat.size,
    });

    if (entriesByArchiveName.size > NODE_SERVICE_DEPLOYMENT_LIMITS.MaxFiles) {
      state.blockers.push(`Project has more than ${NODE_SERVICE_DEPLOYMENT_LIMITS.MaxFiles} files after exclusions.`);
      return;
    }
    if (state.totalBytes > NODE_SERVICE_DEPLOYMENT_LIMITS.MaxDeploymentTotalBytes) {
      state.blockers.push(
        `Project files exceed ${Math.floor(NODE_SERVICE_DEPLOYMENT_LIMITS.MaxDeploymentTotalBytes / 1024 / 1024)}MB after exclusions.`,
      );
      return;
    }
  }
}

async function collectNextStandaloneDeploymentPackageEntries(
  projectDirectory: string,
): Promise<NodeServicePackageCollection> {
  const standaloneDirectory = path.join(projectDirectory, '.next', 'standalone');
  const staticDirectory = path.join(projectDirectory, '.next', 'static');
  const publicDirectory = path.join(projectDirectory, 'public');
  const entriesByArchiveName = new Map<string, NodeServicePackageEntry>();
  const state = {
    totalBytes: 0,
    excludedCount: 0,
    blockers: [] as string[],
  };

  if (!await pathExists(path.join(standaloneDirectory, 'server.js'))) {
    return {
      entries: [],
      totalBytes: 0,
      excludedCount: 0,
      warnings: [],
      blockers: ['Next.js standalone build output was not found.'],
    };
  }

  await collectDeploymentDirectoryEntries(standaloneDirectory, '', entriesByArchiveName, state);
  await collectDeploymentDirectoryEntries(staticDirectory, '.next/static', entriesByArchiveName, state);
  await collectDeploymentDirectoryEntries(publicDirectory, 'public', entriesByArchiveName, state);

  return {
    entries: Array.from(entriesByArchiveName.values()).sort((a, b) => a.archiveName.localeCompare(b.archiveName)),
    totalBytes: state.totalBytes,
    excludedCount: state.excludedCount,
    warnings: [],
    blockers: state.blockers,
  };
}

async function collectNitroDeploymentPackageEntries(
  projectDirectory: string,
): Promise<NodeServicePackageCollection | null> {
  const outputDirectory = path.join(projectDirectory, '.output');
  if (!await pathExists(path.join(outputDirectory, 'server', 'index.mjs'))) {
    return null;
  }

  const entriesByArchiveName = new Map<string, NodeServicePackageEntry>();
  const state = {
    totalBytes: 0,
    excludedCount: 0,
    blockers: [] as string[],
  };
  await collectDeploymentDirectoryEntries(outputDirectory, '.output', entriesByArchiveName, state);

  return {
    entries: Array.from(entriesByArchiveName.values()).sort((a, b) => a.archiveName.localeCompare(b.archiveName)),
    totalBytes: state.totalBytes,
    excludedCount: state.excludedCount,
    warnings: [],
    blockers: state.blockers,
  };
}

async function hasIndexHtml(directory: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(path.join(directory, 'index.html'));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findStaticBuildOutputDirectory(
  projectDirectory: string,
  includeProjectRoot = false,
): Promise<string | null> {
  const directCandidates = [
    ...(includeProjectRoot ? [projectDirectory] : []),
    ...['dist', 'build', 'out'].map(name => path.join(projectDirectory, name)),
  ];
  for (const candidate of directCandidates) {
    if (await hasIndexHtml(candidate)) return candidate;
  }

  const distDirectory = path.join(projectDirectory, 'dist');
  let children: fs.Dirent[];
  try {
    children = await fs.promises.readdir(distDirectory, { withFileTypes: true });
  } catch {
    return null;
  }

  const nestedCandidates: string[] = [];
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!child.isDirectory()) continue;
    const childDirectory = path.join(distDirectory, child.name);
    nestedCandidates.push(path.join(childDirectory, 'browser'), childDirectory);
  }

  for (const candidate of nestedCandidates) {
    if (await hasIndexHtml(candidate)) return candidate;
  }

  return null;
}

async function collectStaticBuildDeploymentPackageEntries(
  projectDirectory: string,
  includeProjectRoot = false,
): Promise<NodeServicePackageCollection | null> {
  const staticOutputDirectory = await findStaticBuildOutputDirectory(projectDirectory, includeProjectRoot);
  if (!staticOutputDirectory) return null;

  return await collectStaticSiteDeploymentPackageEntries(staticOutputDirectory);
}

interface OptimizedDeploymentPackage {
  collection: NodeServicePackageCollection;
  deploymentKind: ShareDeploymentKind;
  startCommand: string;
  entryFile?: string;
  spaFallback?: boolean;
}

async function collectOptimizedDeploymentPackage(
  projectDirectory: string,
  packageJson: PackageJson | null,
): Promise<OptimizedDeploymentPackage | null> {
  if (isNextPackageJson(packageJson)) {
    const collection = await collectNextStandaloneDeploymentPackageEntries(projectDirectory);
    if (collection.blockers.length === 0) {
      return {
        collection,
        deploymentKind: ShareDeploymentKind.NodeService,
        startCommand: NEXT_STANDALONE_START_COMMAND,
      };
    }
  }

  const nitroCollection = await collectNitroDeploymentPackageEntries(projectDirectory);
  if (nitroCollection && nitroCollection.blockers.length === 0) {
    return {
      collection: nitroCollection,
      deploymentKind: ShareDeploymentKind.NodeService,
      startCommand: NITRO_OUTPUT_START_COMMAND,
    };
  }

  if (isStaticBuildPackageJson(packageJson) || isNextPackageJson(packageJson) || !packageJson) {
    const staticCollection = await collectStaticBuildDeploymentPackageEntries(projectDirectory, !packageJson);
    if (staticCollection && staticCollection.blockers.length === 0) {
      return {
        collection: staticCollection,
        deploymentKind: ShareDeploymentKind.StaticSite,
        startCommand: '',
        entryFile: STATIC_SITE_ENTRY_FILE,
        spaFallback: true,
      };
    }
  }

  return null;
}

export async function packageNodeServiceDeployment(
  input: NodeServiceDeploymentPackageInput,
): Promise<NodeServiceDeploymentPackageResult> {
  const plan = await buildNodeServiceProjectPackagePlan({
    projectDirectory: input.projectDirectory,
    localServiceUrl: input.localServiceUrl,
  });
  if (!plan.analysis.success) {
    throw new Error(plan.analysis.blockers.join('\n') || 'Project cannot be deployed.');
  }

  const commandEnv = await getNodeToolEnv();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-node-build-'));
  const projectDir = path.join(tempDir, 'project');
  const commandWarnings: string[] = [];
  const isPlainStaticDeployment =
    plan.analysis.deploymentKind === ShareDeploymentKind.StaticSite &&
    plan.analysis.packageManager === ShareDeploymentPackageManager.Unknown;
  const installCommand = isPlainStaticDeployment
    ? ''
    : effectiveCommand(
        input.installCommand,
        plan.analysis.installCommand,
        { blankUsesFallback: plan.analysis.deploymentKind === ShareDeploymentKind.StaticSite },
      );
  const buildCommand = isPlainStaticDeployment
    ? ''
    : effectiveCommand(
        input.buildCommand,
        plan.analysis.buildCommand,
        { blankUsesFallback: plan.analysis.deploymentKind === ShareDeploymentKind.StaticSite },
      );
  const startCommand = isPlainStaticDeployment
    ? ''
    : effectiveCommand(input.startCommand, plan.analysis.startCommand);
  const port = input.port ?? plan.analysis.port;

  try {
    await copyPackageEntries(plan.entries, projectDir);
    const packageJson = await readPackageJson(projectDir);
    const useNextStandalonePackage = await shouldUseNextStandalonePackage(packageJson, buildCommand);
    if (buildCommand.trim()) {
      await removeStaleBuildOutputs(projectDir);
    }
    await runDeploymentCommand(projectDir, installCommand, 'install', commandEnv, port);
    await runDeploymentCommand(
      projectDir,
      buildCommand,
      'build',
      commandEnv,
      port,
      {
        NODE_ENV: 'production',
        ...(useNextStandalonePackage ? { NEXT_PRIVATE_STANDALONE: 'true' } : {}),
      },
    );

    let effectiveStartCommand = startCommand;
    let deploymentKind: ShareDeploymentKind = ShareDeploymentKind.NodeService;
    let entryFile: string | undefined;
    let spaFallback: boolean | undefined;
    let deploymentPackage: NodeServicePackageCollection | null = null;
    const optimizedPackage = await collectOptimizedDeploymentPackage(projectDir, packageJson);
    if (optimizedPackage) {
      deploymentPackage = optimizedPackage.collection;
      deploymentKind = optimizedPackage.deploymentKind;
      effectiveStartCommand = optimizedPackage.startCommand;
      entryFile = optimizedPackage.entryFile;
      spaFallback = optimizedPackage.spaFallback;
    } else {
      await runProductionDependencyPrune(projectDir, plan.analysis.packageManager, commandWarnings, commandEnv, port);
      deploymentPackage = await collectNodeServiceDeploymentPackageEntries(projectDir);
      const fallbackStartCommand = resolvePackageScriptStartCommand(packageJson, plan.analysis.packageManager);
      if (isGeneratedOptimizedStartCommand(effectiveStartCommand) && fallbackStartCommand) {
        effectiveStartCommand = fallbackStartCommand;
      }
    }

    if (deploymentKind === ShareDeploymentKind.NodeService) {
      deploymentPackage = await includePersistenceEntries(
        deploymentPackage,
        plan.entries,
        projectDir,
        input.persistence ?? plan.analysis.persistence,
      );
    }

    if (deploymentPackage.blockers.length) {
      throw new Error(deploymentPackage.blockers.join('\n'));
    }
    if (deploymentKind === ShareDeploymentKind.NodeService) {
      const missingStartEntry = missingNodeStartCommandEntryName(deploymentPackage, effectiveStartCommand);
      if (missingStartEntry) {
        throw new Error(
          [
            `Deployment start command references "${missingStartEntry}", but this file is not included in the deployment package.`,
            'Check the build output or define a package.json start, serve, or dev script before retrying.',
          ].join(' '),
        );
      }
    }

    const archive = await writeZip(deploymentPackage.entries);
    const analysis: ShareDeploymentProjectAnalysis = {
      ...plan.analysis,
      deploymentKind,
      entryFile,
      spaFallback,
      installCommand,
      buildCommand,
      startCommand: effectiveStartCommand,
      port,
      totalFiles: deploymentPackage.entries.length,
      totalBytes: deploymentPackage.totalBytes,
      excludedCount: deploymentPackage.excludedCount,
      warnings: [
        ...plan.analysis.warnings,
        ...deploymentPackage.warnings,
        ...commandWarnings,
      ],
    };

    return {
      ...archive,
      analysis,
      deploymentKind,
      entryFile,
      spaFallback,
      totalFiles: analysis.totalFiles,
      totalBytes: analysis.totalBytes,
      warnings: analysis.warnings,
    };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}
