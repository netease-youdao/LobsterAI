import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  ShareDeploymentCandidateSource,
  ShareDeploymentKind,
  ShareDeploymentPackageManager,
  ShareDeploymentPersistenceBindingKind,
  ShareDeploymentPersistenceProvider,
} from '../../../shared/shareDeployment/constants';
import {
  buildNodeServiceProjectPackagePlan,
  collectNodeServiceDeploymentPackageEntries,
  detectNodeServiceProjectCandidates,
} from './nodeServiceProjectAnalyzer';

const tempDirectories: string[] = [];
const BROTATO_PROJECT_DIR = process.env.SHARE_DEPLOYMENT_BROTATO_PROJECT_DIR ||
  '/Users/admin/lobsterai/project/brotato-clone';

async function makeTempProjectWithPackageJson(packageJson: Record<string, unknown>): Promise<string> {
  const projectDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-node-analyzer-test-'));
  tempDirectories.push(projectDirectory);
  await fs.promises.writeFile(
    path.join(projectDirectory, 'package.json'),
    JSON.stringify(packageJson),
  );
  await fs.promises.writeFile(
    path.join(projectDirectory, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'test-service' },
      },
    }),
  );
  return projectDirectory;
}

async function makeTempProject(): Promise<string> {
  return makeTempProjectWithPackageJson({
    name: 'test-service',
    scripts: {
      build: 'next build',
      start: 'next start',
    },
  });
}

async function makeTempNextProject(): Promise<string> {
  const projectDirectory = await makeTempProject();
  const packageJsonPath = path.join(projectDirectory, 'package.json');
  const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  packageJson.dependencies = { next: '14.2.21', react: '18.3.1', 'react-dom': '18.3.1' };
  await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJson));
  return projectDirectory;
}

async function makeTempProjectWithDependencies(
  dependencies: Record<string, string>,
): Promise<string> {
  const projectDirectory = await makeTempProject();
  const packageJsonPath = path.join(projectDirectory, 'package.json');
  const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8')) as Record<string, unknown>;
  packageJson.dependencies = dependencies;
  await fs.promises.writeFile(packageJsonPath, JSON.stringify(packageJson));
  return projectDirectory;
}

async function makeTempStaticSiteProject(): Promise<string> {
  const projectDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-static-analyzer-test-'));
  tempDirectories.push(projectDirectory);
  await writeFile(projectDirectory, 'index.html', '<!doctype html><script src="./app.js"></script>');
  await writeFile(projectDirectory, 'app.js', 'console.log("static");');
  await writeFile(projectDirectory, 'style.css', 'body { margin: 0; }');
  return projectDirectory;
}

async function writeFile(projectDirectory: string, relativePath: string, content = 'x'): Promise<void> {
  const filePath = path.join(projectDirectory, relativePath);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content);
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(directory =>
      fs.promises.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('buildNodeServiceProjectPackagePlan', () => {
  test('uses standalone server command for Next.js projects', async () => {
    const projectDirectory = await makeTempNextProject();

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });

    expect(plan.analysis.buildCommand).toBe('npm run build');
    expect(plan.analysis.deploymentKind).toBe(ShareDeploymentKind.NodeService);
    expect(plan.analysis.startCommand).toBe('node server.js');
  });

  test('uses Nitro output command for Nuxt projects', async () => {
    const projectDirectory = await makeTempProjectWithDependencies({ nuxt: '3.0.0' });

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });

    expect(plan.analysis.buildCommand).toBe('npm run build');
    expect(plan.analysis.deploymentKind).toBe(ShareDeploymentKind.NodeService);
    expect(plan.analysis.startCommand).toBe('node .output/server/index.mjs');
  });

  test('uses generated static server command for static build frameworks', async () => {
    const projectDirectory = await makeTempProjectWithDependencies({ vite: '5.0.0' });

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });

    expect(plan.analysis.buildCommand).toBe('npm run build');
    expect(plan.analysis.deploymentKind).toBe(ShareDeploymentKind.StaticSite);
    expect(plan.analysis.entryFile).toBe('index.html');
    expect(plan.analysis.spaFallback).toBe(true);
    expect(plan.analysis.startCommand).toBe('node server.js');
  });

  test('uses npm install when npm lockfile is missing', async () => {
    const projectDirectory = await makeTempProjectWithDependencies({ vite: '5.0.0' });
    await fs.promises.rm(path.join(projectDirectory, 'package-lock.json'), { force: true });

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });

    expect(plan.analysis.installCommand).toBe('npm install');
    expect(plan.analysis.warnings.join('\n')).toContain('No npm lockfile');
  });

  test('detects lightweight filesystem persistence candidates', async () => {
    const projectDirectory = await makeTempProjectWithPackageJson({
      name: 'sqlite-scoreboard-service',
      scripts: {
        start: 'node server.js',
      },
    });
    await writeFile(projectDirectory, 'server.js', 'console.log("server");');
    await writeFile(projectDirectory, 'db.sqlite', 'sqlite');
    await writeFile(projectDirectory, 'data/comments.json', '[]');
    await writeFile(projectDirectory, 'data/app.sqlite', 'db');
    await writeFile(projectDirectory, 'uploads/avatar.txt', 'avatar');

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });

    expect(plan.analysis.persistence).toEqual({
      enabled: true,
      provider: ShareDeploymentPersistenceProvider.Filesystem,
      quotaBytes: 100 * 1024 * 1024,
      bindings: [
        {
          appPath: 'data',
          dataPath: 'data',
          kind: ShareDeploymentPersistenceBindingKind.Directory,
          sizeBytes: 4,
        },
        {
          appPath: 'db.sqlite',
          dataPath: 'db.sqlite',
          kind: ShareDeploymentPersistenceBindingKind.File,
          sizeBytes: 6,
        },
        {
          appPath: 'uploads',
          dataPath: 'uploads',
          kind: ShareDeploymentPersistenceBindingKind.Directory,
          sizeBytes: 6,
        },
      ],
    });
  });

  test.skipIf(!fs.existsSync(BROTATO_PROJECT_DIR))(
    'detects brotato leaderboard data as a user-manageable persistence directory',
    async () => {
      const plan = await buildNodeServiceProjectPackagePlan({
        projectDirectory: BROTATO_PROJECT_DIR,
        localServiceUrl: 'http://localhost:3000',
      });

      expect(plan.analysis.success).toBe(true);
      expect(plan.analysis.deploymentKind).toBe(ShareDeploymentKind.NodeService);
      expect(plan.analysis.packageManager).toBe(ShareDeploymentPackageManager.Npm);
      expect(plan.analysis.persistence?.enabled).toBe(true);
      expect(plan.analysis.persistence?.provider).toBe(ShareDeploymentPersistenceProvider.Filesystem);
      expect(plan.analysis.persistence?.bindings).toEqual([
        {
          appPath: 'data',
          dataPath: 'data',
          kind: ShareDeploymentPersistenceBindingKind.Directory,
          sizeBytes: expect.any(Number),
        },
      ]);
      expect(plan.analysis.persistence?.bindings[0]?.sizeBytes ?? 0).toBeGreaterThan(0);
      expect(plan.entries.some(entry => entry.archiveName === 'data/leaderboard.json')).toBe(true);
      expect(plan.entries.some(entry => entry.archiveName.startsWith('node_modules/'))).toBe(false);
    },
  );

  test('allows plain static site directories without package.json', async () => {
    const projectDirectory = await makeTempStaticSiteProject();

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:8765',
    });

    expect(plan.analysis.success).toBe(true);
    expect(plan.analysis.deploymentKind).toBe(ShareDeploymentKind.StaticSite);
    expect(plan.analysis.packageManager).toBe(ShareDeploymentPackageManager.Unknown);
    expect(plan.analysis.entryFile).toBe('index.html');
    expect(plan.analysis.spaFallback).toBe(true);
    expect(plan.analysis.installCommand).toBe('');
    expect(plan.analysis.buildCommand).toBe('');
    expect(plan.analysis.startCommand).toBe('');
    expect(plan.analysis.blockers).toEqual([]);
    expect(plan.entries.map(entry => entry.archiveName)).toEqual(['app.js', 'index.html', 'style.css']);
  });

  test('blocks projects that only define a development start command', async () => {
    const projectDirectory = await makeTempProjectWithPackageJson({
      name: 'dev-only-service',
      scripts: {
        dev: 'vite dev',
      },
      devDependencies: {
        vite: '5.0.0',
      },
    });

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });

    expect(plan.analysis.success).toBe(false);
    expect(plan.analysis.startCommand).toBe('npm run dev');
    expect(plan.analysis.blockers.join('\n')).toContain('development start command');
  });

  test('blocks SvelteKit adapter-auto projects without a production adapter', async () => {
    const projectDirectory = await makeTempProjectWithPackageJson({
      name: 'sveltekit-auto-service',
      scripts: {
        build: 'vite build',
        dev: 'vite dev',
        preview: 'vite preview',
      },
      devDependencies: {
        '@sveltejs/adapter-auto': '^7.0.1',
        '@sveltejs/kit': '^2.63.0',
        '@sveltejs/vite-plugin-svelte': '^7.1.2',
        svelte: '^5.56.1',
        vite: '^8.0.16',
      },
    });

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });

    expect(plan.analysis.success).toBe(false);
    expect(plan.analysis.deploymentKind).toBe(ShareDeploymentKind.StaticSite);
    expect(plan.analysis.blockers.join('\n')).toContain('@sveltejs/adapter-auto');
    expect(plan.analysis.blockers.join('\n')).toContain('@sveltejs/adapter-static');
  });

  test('allows SvelteKit projects with a static deployment adapter', async () => {
    const projectDirectory = await makeTempProjectWithPackageJson({
      name: 'sveltekit-static-service',
      scripts: {
        build: 'vite build',
        dev: 'vite dev',
      },
      devDependencies: {
        '@sveltejs/adapter-static': '^3.0.0',
        '@sveltejs/kit': '^2.63.0',
        '@sveltejs/vite-plugin-svelte': '^7.1.2',
        svelte: '^5.56.1',
        vite: '^8.0.16',
      },
    });

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });

    expect(plan.analysis.success).toBe(true);
    expect(plan.analysis.deploymentKind).toBe(ShareDeploymentKind.StaticSite);
    expect(plan.analysis.blockers).toEqual([]);
  });

  test('excludes stale build output directories from the pre-build source copy', async () => {
    const projectDirectory = await makeTempProject();
    await writeFile(projectDirectory, 'src/app.ts');
    await writeFile(projectDirectory, '.next/server/app.js');
    await writeFile(projectDirectory, 'dist/index.js');
    await writeFile(projectDirectory, 'build/index.js');
    await writeFile(projectDirectory, 'out/index.html');

    const plan = await buildNodeServiceProjectPackagePlan({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
    });
    const archiveNames = plan.entries.map(entry => entry.archiveName);

    expect(archiveNames).toContain('src/app.ts');
    expect(archiveNames).toContain('package.json');
    expect(archiveNames).not.toContain('.next/server/app.js');
    expect(archiveNames).not.toContain('dist/index.js');
    expect(archiveNames).not.toContain('build/index.js');
    expect(archiveNames).not.toContain('out/index.html');
    expect(plan.analysis.excludedCount).toBeGreaterThan(0);
    expect(plan.analysis.warnings.join('\n')).not.toContain('excluded from the deployment package');
  });
});

describe('collectNodeServiceDeploymentPackageEntries', () => {
  test('includes built output and production dependencies in the deployment package', async () => {
    const projectDirectory = await makeTempProject();
    await writeFile(projectDirectory, '.next/server/app.js');
    await writeFile(projectDirectory, 'dist/index.js');
    await writeFile(projectDirectory, 'build/index.js');
    await writeFile(projectDirectory, 'out/index.html');
    await writeFile(projectDirectory, 'node_modules/react/index.js');
    await writeFile(projectDirectory, '.cache/ignored.js');

    const collection = await collectNodeServiceDeploymentPackageEntries(projectDirectory);
    const archiveNames = collection.entries.map(entry => entry.archiveName);

    expect(archiveNames).toContain('.next/server/app.js');
    expect(archiveNames).toContain('dist/index.js');
    expect(archiveNames).toContain('build/index.js');
    expect(archiveNames).toContain('out/index.html');
    expect(archiveNames).toContain('node_modules/react/index.js');
    expect(archiveNames).not.toContain('.cache/ignored.js');
  });
});

describe('detectNodeServiceProjectCandidates', () => {
  test('prioritizes usable text candidates over cached project directories', async () => {
    const projectDirectory = await makeTempStaticSiteProject();
    const cachedProjectDirectory = await makeTempStaticSiteProject();

    const candidates = await detectNodeServiceProjectCandidates({
      localServiceUrl: 'http://localhost:65530',
      projectCandidates: [
        {
          directory: projectDirectory,
          source: ShareDeploymentCandidateSource.TextFileLink,
          confidence: 82,
          reason: 'Matched a local file link in the assistant response.',
        },
      ],
      cachedProjectDirectory,
    });

    expect(candidates[0]).toEqual(expect.objectContaining({
      directory: projectDirectory,
      source: ShareDeploymentCandidateSource.TextFileLink,
      confidence: 82,
    }));
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        directory: cachedProjectDirectory,
        source: ShareDeploymentCandidateSource.Cache,
        confidence: 35,
      }),
    ]));
  });

  test('uses session context before cached and working directories when the service is offline', async () => {
    const contextProjectDirectory = await makeTempStaticSiteProject();
    const cachedProjectDirectory = await makeTempStaticSiteProject();
    const workingDirectory = await makeTempStaticSiteProject();

    const candidates = await detectNodeServiceProjectCandidates({
      localServiceUrl: 'http://localhost:65530',
      workingDirectory,
      projectCandidates: [
        {
          directory: contextProjectDirectory,
          source: ShareDeploymentCandidateSource.TextCdCommand,
          confidence: 10,
          reason: 'Matched the service directory from session context.',
        },
      ],
      cachedProjectDirectory,
    });

    expect(candidates.map(candidate => candidate.directory)).toEqual([
      contextProjectDirectory,
      cachedProjectDirectory,
      workingDirectory,
    ]);
  });

  test('falls back to the working directory when the offline service has no context', async () => {
    const workingDirectory = await makeTempStaticSiteProject();

    const candidates = await detectNodeServiceProjectCandidates({
      localServiceUrl: 'http://localhost:65530',
      workingDirectory,
    });

    expect(candidates[0]).toEqual(expect.objectContaining({
      directory: workingDirectory,
      source: ShareDeploymentCandidateSource.Workspace,
    }));
  });

  test('does not guess a child project when the working directory itself is not deployable', async () => {
    const workingDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lobster-workspace-analyzer-test-'),
    );
    tempDirectories.push(workingDirectory);
    const childProjectDirectory = path.join(workingDirectory, 'child-project');
    await writeFile(childProjectDirectory, 'index.html', '<!doctype html>');

    const candidates = await detectNodeServiceProjectCandidates({
      localServiceUrl: 'http://localhost:65530',
      workingDirectory,
    });

    expect(candidates).toEqual([]);
  });
});
