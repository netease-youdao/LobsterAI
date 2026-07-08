import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getName: () => 'LobsterAI',
    getPath: (name: string) => (name === 'userData' ? path.join(os.tmpdir(), 'lobsterai-test-user-data') : os.tmpdir()),
    isPackaged: false,
    isReady: () => false,
  },
  session: {
    defaultSession: {
      resolveProxy: async () => 'DIRECT',
    },
  },
}));

import { ShareDeploymentKind, ShareDeploymentPackageManager } from '../../../shared/shareDeployment/constants';
import { packageNodeServiceDeployment } from './nodeServiceDeploymentPackager';

const tempDirectories: string[] = [];

async function makeTempProject(packageJson: Record<string, unknown>): Promise<string> {
  const projectDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-node-packager-test-'));
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
        '': { name: packageJson.name || 'test-service' },
      },
    }),
  );
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

describe('packageNodeServiceDeployment', () => {
  test('forces production mode for framework build commands', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const projectDirectory = await makeTempProject({
      name: 'next-env-service',
      scripts: {
        build: 'node build.js',
      },
      dependencies: {
        next: '14.0.0',
      },
    });
    await writeFile(
      projectDirectory,
      'build.js',
      [
        'if (process.env.NODE_ENV !== "production") {',
        '  console.error("NODE_ENV=" + process.env.NODE_ENV);',
        '  process.exit(1);',
        '}',
        'const fs = require("fs");',
        'fs.mkdirSync(".next/standalone", { recursive: true });',
        'fs.mkdirSync(".next/static", { recursive: true });',
        'fs.writeFileSync(".next/standalone/server.js", "console.log(\\"server\\")");',
        'fs.writeFileSync(".next/static/app.js", "console.log(\\"static\\")");',
      ].join('\n'),
    );

    try {
      const result = await packageNodeServiceDeployment({
        projectDirectory,
        localServiceUrl: 'http://localhost:3000',
        installCommand: '',
        buildCommand: 'node build.js',
        port: 3000,
      });

      expect(result.analysis.startCommand).toBe('node server.js');
      expect(result.deploymentKind).toBe(ShareDeploymentKind.NodeService);
      expect(result.totalFiles).toBe(2);

      await fs.promises.rm(path.dirname(result.archivePath), { recursive: true, force: true });
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  test('packages static framework builds as static site output', async () => {
    const projectDirectory = await makeTempProject({
      name: 'vite-static',
      scripts: {
        build: 'node build.js',
      },
      devDependencies: {
        vite: '5.0.0',
      },
    });
    await writeFile(
      projectDirectory,
      'build.js',
      [
        'const fs = require("fs");',
        'fs.mkdirSync("dist/assets", { recursive: true });',
        'fs.writeFileSync("dist/index.html", "<!doctype html><div id=\\"root\\"></div>");',
        'fs.writeFileSync("dist/assets/app.js", "console.log(1)");',
      ].join('\n'),
    );

    const result = await packageNodeServiceDeployment({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
      installCommand: 'node -e ""',
      buildCommand: 'node build.js',
      port: 3000,
    });

    expect(result.deploymentKind).toBe(ShareDeploymentKind.StaticSite);
    expect(result.entryFile).toBe('index.html');
    expect(result.spaFallback).toBe(true);
    expect(result.analysis.startCommand).toBe('');
    expect(result.totalFiles).toBe(2);
    expect(result.totalBytes).toBeLessThan(20 * 1024);

    await fs.promises.rm(path.dirname(result.archivePath), { recursive: true, force: true });
  });

  test('uses default build command when stale static deployment input sends a blank build command', async () => {
    const projectDirectory = await makeTempProject({
      name: 'vite-static-blank-input',
      scripts: {
        build: 'node build.js',
      },
      devDependencies: {
        vite: '5.0.0',
      },
    });
    await writeFile(
      projectDirectory,
      'build.js',
      [
        'const fs = require("fs");',
        'fs.mkdirSync("dist/assets", { recursive: true });',
        'fs.writeFileSync("dist/index.html", "<!doctype html><div id=\\"root\\"></div>");',
        'fs.writeFileSync("dist/assets/app.js", "console.log(1)");',
      ].join('\n'),
    );

    const result = await packageNodeServiceDeployment({
      projectDirectory,
      localServiceUrl: 'http://localhost:5174',
      installCommand: 'node -e ""',
      buildCommand: '',
      startCommand: '',
      port: 5174,
    });

    expect(result.deploymentKind).toBe(ShareDeploymentKind.StaticSite);
    expect(result.entryFile).toBe('index.html');
    expect(result.analysis.installCommand).toBe('node -e ""');
    expect(result.analysis.buildCommand).toBe('npm run build');
    expect(result.analysis.startCommand).toBe('');
    expect(result.totalFiles).toBe(2);

    await fs.promises.rm(path.dirname(result.archivePath), { recursive: true, force: true });
  });

  test('packages plain static site directories without package.json', async () => {
    const projectDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-static-packager-test-'));
    tempDirectories.push(projectDirectory);
    await writeFile(projectDirectory, 'index.html', '<!doctype html><link rel="stylesheet" href="./style.css">');
    await writeFile(projectDirectory, 'style.css', 'body { margin: 0; }');
    await writeFile(projectDirectory, 'images/hero.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    const result = await packageNodeServiceDeployment({
      projectDirectory,
      localServiceUrl: 'http://localhost:8765',
      port: 8765,
    });

    expect(result.deploymentKind).toBe(ShareDeploymentKind.StaticSite);
    expect(result.entryFile).toBe('index.html');
    expect(result.spaFallback).toBe(true);
    expect(result.analysis.packageManager).toBe(ShareDeploymentPackageManager.Unknown);
    expect(result.analysis.installCommand).toBe('');
    expect(result.analysis.buildCommand).toBe('');
    expect(result.analysis.startCommand).toBe('');
    expect(result.totalFiles).toBe(3);

    await fs.promises.rm(path.dirname(result.archivePath), { recursive: true, force: true });
  });

  test('ignores stale install commands for plain static site directories', async () => {
    const projectDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-static-packager-test-'));
    tempDirectories.push(projectDirectory);
    await writeFile(projectDirectory, 'index.html', '<!doctype html><h1>Static</h1>');

    const result = await packageNodeServiceDeployment({
      projectDirectory,
      localServiceUrl: 'http://localhost:8765',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      startCommand: 'npm run start',
      port: 8765,
    });

    expect(result.deploymentKind).toBe(ShareDeploymentKind.StaticSite);
    expect(result.analysis.installCommand).toBe('');
    expect(result.analysis.buildCommand).toBe('');
    expect(result.analysis.startCommand).toBe('');
    expect(result.totalFiles).toBe(1);

    await fs.promises.rm(path.dirname(result.archivePath), { recursive: true, force: true });
  });

  test('packages Nitro output without production dependency pruning', async () => {
    const projectDirectory = await makeTempProject({
      name: 'nuxt-service',
      scripts: {
        build: 'node build.js',
      },
      dependencies: {
        nuxt: '3.0.0',
      },
    });
    await writeFile(
      projectDirectory,
      'build.js',
      [
        'const fs = require("fs");',
        'fs.mkdirSync(".output/server", { recursive: true });',
        'fs.mkdirSync(".output/public", { recursive: true });',
        'fs.writeFileSync(".output/server/index.mjs", "console.log(\\"server\\")");',
        'fs.writeFileSync(".output/public/index.html", "<!doctype html>");',
      ].join('\n'),
    );

    const result = await packageNodeServiceDeployment({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
      installCommand: '',
      buildCommand: 'node build.js',
      port: 3000,
    });

    expect(result.analysis.startCommand).toBe('node .output/server/index.mjs');
    expect(result.deploymentKind).toBe(ShareDeploymentKind.NodeService);
    expect(result.totalFiles).toBe(2);
    expect(result.totalBytes).toBeLessThan(1024);

    await fs.promises.rm(path.dirname(result.archivePath), { recursive: true, force: true });
  });

  test('fails before upload when generated start command entry is missing', async () => {
    const projectDirectory = await makeTempProject({
      name: 'missing-entry-service',
      scripts: {
        build: 'node build.js',
      },
      dependencies: {
        next: '14.0.0',
      },
    });
    await fs.promises.rm(path.join(projectDirectory, 'package-lock.json'), { force: true });
    await writeFile(projectDirectory, 'yarn.lock', '# yarn lockfile');
    await writeFile(
      projectDirectory,
      'build.js',
      [
        'const fs = require("fs");',
        'fs.mkdirSync(".next/cache", { recursive: true });',
        'fs.writeFileSync(".next/cache/build.txt", "built");',
      ].join('\n'),
    );

    await expect(packageNodeServiceDeployment({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
      installCommand: '',
      buildCommand: 'node build.js',
      port: 3000,
    })).rejects.toThrow(/start command references "server\.js"/);
  });

  test('adds a clear hint when Node package tools are missing', async () => {
    const projectDirectory = await makeTempProject({
      name: 'missing-npm-service',
      scripts: {
        start: 'node server.js',
      },
    });
    await writeFile(projectDirectory, 'server.js', 'console.log("server")');

    await expect(packageNodeServiceDeployment({
      projectDirectory,
      localServiceUrl: 'http://localhost:3000',
      installCommand: 'sh -c "echo \\"/bin/sh: npm: command not found\\" >&2; exit 127"',
      buildCommand: '',
      startCommand: 'node server.js',
      port: 3000,
    })).rejects.toThrow(/Deployment could not find npm in the prepared Node tool environment/);
  });

  test('explains Next document import build failures', async () => {
    const projectDirectory = await makeTempProject({
      name: 'broken-next-service',
      scripts: {
        build: 'node fail-build.js',
      },
      dependencies: {
        next: '14.0.0',
      },
    });
    await writeFile(
      projectDirectory,
      'fail-build.js',
      [
        'process.stderr.write("\\u001b[31mError occurred prerendering page \\"/404\\".\\n");',
        'process.stderr.write("Error: <Html> should not be imported outside of pages/_document.\\n");',
        'const privatePath = process.cwd().startsWith("/var/") ? "/private" + process.cwd() : process.cwd();',
        'process.stderr.write("    at " + privatePath + "/.next/server/chunks/682.js\\u001b[39m\\n");',
        'process.stderr.write("    at renderWithHooks (" + privatePath + "/node_modules/react-dom/server.js:1:1)\\n");',
        'process.exit(1);',
      ].join('\n'),
    );

    let message = '';
    try {
      await packageNodeServiceDeployment({
        projectDirectory,
        localServiceUrl: 'http://localhost:3000',
        installCommand: '',
        buildCommand: 'node fail-build.js',
        port: 3000,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(
        /Next\.js build failed: <Html> from next\/document can only be used in pages\/_document/,
      );
      expect(message).toContain('Error occurred prerendering page "/404".');
      expect(message).not.toContain('chunks/682.js');
      expect(message).not.toContain('react-dom');
      expect(message).not.toContain('/private<deployment-temp>');
      expect(message).not.toContain('\u001b');
      return;
    }

    throw new Error('Expected packaging to fail.');
  });
});
