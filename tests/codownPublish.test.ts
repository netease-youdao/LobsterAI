import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

const {
  ArtifactKind, ReleaseTarget, artifactPlan, artifactUrl, fileDigest, manifestDirectory, readManifest, stageManifest,
} = require('../scripts/codown-artifacts.cjs');
const { CodownEnv, packagingEnv, readCodownConfig, withoutSvnCredentials } = require('../scripts/codown-config.cjs');
const { preflightSvn, publishManifest } = require('../scripts/codown-svn.cjs');
const { release, releasePlan, assertReleaseCredentials } = require('../scripts/release-codown.cjs');
const { verifyManifest, publishAndReport } = require('../scripts/codown-publish.cjs');

const roots: string[] = [];
const baseUrl = 'https://download.example.test/lobsterai';
const ticketUrl = 'https://ticket.example.test/create?processId=123';
const identity = { version: '2026.9.14', keyfrom: 'dictbind', target: ReleaseTarget.WinWeb, silent: false };
const hasSvn = ['svn', 'svnadmin', 'svnlook'].every(binary => spawnSync(binary, ['--version', '--quiet']).status === 0);
const temporary = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codown test '));
  roots.push(root);
  return root;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function command(name: string, args: string[]) {
  const result = spawnSync(name, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error || result.stderr}`);
  return result.stdout;
}

function writeArtifacts(output: string, releaseIdentity = identity) {
  for (const artifact of artifactPlan(releaseIdentity)) {
    const file = path.join(output, artifact.source);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `fixture:${artifact.name}`);
  }
}

async function snapshot(root = temporary()) {
  const output = path.join(root, 'output');
  writeArtifacts(output);
  const manifestPath = await stageManifest(root, output, identity, baseUrl);
  return { root, output, manifestPath };
}

async function fixture() {
  const { root, output, manifestPath } = await snapshot();
  const repository = path.join(root, 'repository');
  const workingCopy = path.join(root, 'working copy');
  command('svnadmin', ['create', repository]);
  const svnUrl = pathToFileURL(repository).href;
  command('svn', ['checkout', svnUrl, workingCopy]);
  // file:// is used only by this local integration fixture; production env
  // parsing requires HTTPS, including the configured SVN URL.
  const config = { workingCopy, svnUrl, publicBaseUrl: baseUrl, ticketUrl, username: '', password: '' };
  return { root, output, manifestPath, config, repository };
}

describe('codown release configuration and artifacts', () => {
  test('keeps machine configuration private and process env takes precedence', () => {
    const root = temporary();
    fs.writeFileSync(path.join(root, '.env'), 'CODOWN_PUBLIC_BASE_URL=https://local.example.test\nCODOWN_SVN_PASSWORD=secret\n');
    const env = packagingEnv(root, { [CodownEnv.PublicBaseUrl]: baseUrl });
    expect(env[CodownEnv.PublicBaseUrl]).toBe(baseUrl);
    expect(env[CodownEnv.Password]).toBe('secret');
    expect(withoutSvnCredentials(env)).not.toHaveProperty(CodownEnv.Password);
    const config = readCodownConfig({ ...env, [CodownEnv.WorkingCopy]: 'checkout', [CodownEnv.SvnUrl]: 'https://svn.example.test/product', [CodownEnv.TicketUrl]: ticketUrl }, root);
    expect(config.ticketUrl).toBe(ticketUrl);
    expect(config.workingCopy).toBe(path.join(root, 'checkout'));
  });

  test.each(['http://download.example.test', 'https://user:secret@example.test', 'https://example.test/?token=secret', 'https://example.test/#fragment'])(
    'rejects unsafe or expiring public bases: %s', url => {
      expect(() => artifactUrl(url, identity.keyfrom, 'installer.exe')).toThrow();
    },
  );

  test('publishes simple names and isolates silent payloads', () => {
    expect(artifactPlan(identity).map((artifact: { name: string }) => artifact.name)).toEqual([
      'lobsterai-2026.9.14.exe', 'lobsterai-2026.9.14-web.exe', 'lobsterai-2026.9.14.nsis.7z',
    ]);
    expect(artifactPlan({ ...identity, silent: true }).map((artifact: { name: string }) => artifact.name)).toEqual([
      'lobsterai-2026.9.14-silent.exe', 'lobsterai-2026.9.14-web-silent.exe', 'lobsterai-2026.9.14-silent.nsis.7z',
    ]);
    expect(artifactPlan({ ...identity, target: ReleaseTarget.MacArm64 })[0].name).toBe('lobsterai-2026.9.14-arm64.dmg');
  });

  test('rejects path traversal and non-Windows silent builds', () => {
    expect(() => artifactPlan({ ...identity, keyfrom: '../other' })).toThrow();
    expect(() => artifactPlan({ ...identity, version: '../../other' })).toThrow();
    expect(() => artifactPlan({ ...identity, target: ReleaseTarget.MacX64, silent: true })).toThrow();
  });

  test('freezes only this build and rejects changed or incomplete snapshots', async () => {
    const root = temporary();
    const output = path.join(root, 'output');
    writeArtifacts(output);
    fs.writeFileSync(path.join(output, 'old-installer.exe'), 'unrelated');
    const manifestPath = await stageManifest(root, output, identity, baseUrl);
    expect(fs.readdirSync(path.dirname(manifestPath))).not.toContain('old-installer.exe');
    expect(await readManifest(manifestPath)).toMatchObject(identity);
    await expect(stageManifest(root, output, identity, baseUrl)).rejects.toThrow('snapshot already exists');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.artifacts.pop();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(readManifest(manifestPath)).rejects.toThrow('Incomplete');
  });

  test('detects file tampering and manifest traversal before SVN is invoked', async () => {
    const { root, manifestPath } = await snapshot();
    const config = { workingCopy: path.join(root, 'not-a-working-copy'), publicBaseUrl: baseUrl };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const first = manifest.artifacts[0];
    fs.writeFileSync(path.join(path.dirname(manifestPath), first.name), 'changed');
    await expect(publishManifest(manifestPath, config)).rejects.toThrow('changed since build');
    first.name = '../outside.exe';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(readManifest(manifestPath)).rejects.toThrow('names do not match');
    expect(fs.existsSync(config.workingCopy)).toBe(false);
  });

  test('requires release signing credentials while allowing Linux without them', () => {
    expect(() => assertReleaseCredentials(releasePlan({ target: ReleaseTarget.WinWeb }, identity.version), {})).toThrow('YD_SIGN');
    expect(() => assertReleaseCredentials(releasePlan({ target: ReleaseTarget.MacArm64 }, identity.version), {})).toThrow('APPLE_ID');
    expect(() => assertReleaseCredentials(releasePlan({ target: ReleaseTarget.LinuxX64 }, identity.version), {})).not.toThrow();
  });
});

describe.skipIf(!hasSvn)('codown real SVN integration', () => {
  test('commits all three artifacts in one revision and retries without another commit', async () => {
    const { manifestPath, config, repository } = await fixture();
    await preflightSvn(config);
    const first = await publishManifest(manifestPath, config);
    expect(first.revision).toBe('1');
    expect(first.uploaded).toHaveLength(3);
    expect(command('svn', ['status', config.workingCopy])).toBe('');
    const second = await publishManifest(manifestPath, config);
    expect(second.uploaded).toEqual([]);
    expect(second.reused).toHaveLength(3);
    expect(command('svnlook', ['youngest', repository]).trim()).toBe('1');
    const remotePayload = command('svn', ['cat', `${config.svnUrl}/${identity.keyfrom}/lobsterai-${identity.version}.nsis.7z`]);
    expect(remotePayload).toBe(`fixture:lobsterai-${identity.version}.nsis.7z`);
  });

  test('dry run performs no working-copy mutation or commit', async () => {
    const { manifestPath, config, repository } = await fixture();
    const before = fs.readdirSync(config.workingCopy);
    const result = await publishManifest(manifestPath, config, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.revision).toBeNull();
    expect(fs.readdirSync(config.workingCopy)).toEqual(before);
    expect(command('svnlook', ['youngest', repository]).trim()).toBe('0');
  });

  test('does not publish unrelated working-copy changes', async () => {
    const { manifestPath, config, repository } = await fixture();
    fs.writeFileSync(path.join(config.workingCopy, 'unrelated.txt'), 'keep me');
    await expect(publishManifest(manifestPath, config)).rejects.toThrow('local changes');
    expect(fs.readFileSync(path.join(config.workingCopy, 'unrelated.txt'), 'utf8')).toBe('keep me');
    expect(command('svnlook', ['youngest', repository]).trim()).toBe('0');
  });

  test('rejects a different SVN working-copy URL', async () => {
    const { manifestPath, config } = await fixture();
    await expect(publishManifest(manifestPath, { ...config, svnUrl: `${config.svnUrl}/other` })).rejects.toThrow('does not point');
  });

  test('refuses same-name different bytes before adding any files', async () => {
    const { manifestPath, config, repository } = await fixture();
    await publishManifest(manifestPath, config);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const file = path.join(path.dirname(manifestPath), manifest.artifacts[0].name);
    fs.writeFileSync(file, 'rebuilt bytes');
    Object.assign(manifest.artifacts[0], await fileDigest(file));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(publishManifest(manifestPath, config)).rejects.toThrow('Refusing to overwrite');
    expect(command('svnlook', ['youngest', repository]).trim()).toBe('1');
    expect(command('svn', ['status', config.workingCopy])).toBe('');
  });

  test('updates a sparse existing channel without downloading unrelated history', async () => {
    const { root, manifestPath, config, repository } = await fixture();
    command('svn', ['mkdir', `${config.svnUrl}/${identity.keyfrom}`, '-m', 'existing channel']);
    const result = await publishManifest(manifestPath, config);
    expect(result.revision).toBe('2');
    const sparse = path.join(root, 'sparse');
    command('svn', ['checkout', '--depth', 'empty', config.svnUrl, sparse]);
    const retry = await publishManifest(manifestPath, { ...config, workingCopy: sparse });
    expect(retry.reused).toHaveLength(3);
    expect(fs.readdirSync(sparse)).toEqual(['.svn']);
    expect(command('svnlook', ['youngest', repository]).trim()).toBe('2');
  });

  test.skipIf(process.platform === 'win32')('rolls back only its own additions after a rejected commit and can retry', async () => {
    const { manifestPath, config, repository } = await fixture();
    const hook = path.join(repository, 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(publishManifest(manifestPath, config)).rejects.toThrow('commit failed');
    expect(command('svn', ['status', config.workingCopy])).toBe('');
    expect(fs.existsSync(manifestPath)).toBe(true);
    fs.unlinkSync(hook);
    expect((await publishManifest(manifestPath, config)).revision).toBe('1');
  });

  test.skipIf(process.platform === 'win32')('recovers a lost commit response by checking remote content on retry', async () => {
    const { root, manifestPath, config, repository } = await fixture();
    const realSvn = command('which', ['svn']).trim();
    const shims = path.join(root, 'shims');
    fs.mkdirSync(shims);
    fs.writeFileSync(path.join(shims, 'svn'), `#!${process.execPath}\nconst {spawnSync}=require('child_process');\nconst args=process.argv.slice(2);\nconst result=spawnSync(${JSON.stringify(realSvn)},args,{stdio:'inherit'});\nprocess.exit(args[0]==='commit' ? 1 : result.status);\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${shims}${path.delimiter}${process.env.PATH}`);
    await expect(publishManifest(manifestPath, config)).rejects.toThrow('commit failed');
    expect(command('svn', ['status', config.workingCopy])).toBe('');
    const retry = await publishManifest(manifestPath, config);
    expect(retry.uploaded).toEqual([]);
    expect(retry.reused).toHaveLength(3);
    expect(command('svnlook', ['youngest', repository]).trim()).toBe('1');
  });

  test('does not submit while another publisher holds the lock', async () => {
    const { manifestPath, config, repository } = await fixture();
    const lock = path.join(config.workingCopy, '.svn', 'codown-publish.lock');
    fs.mkdirSync(lock);
    await expect(publishManifest(manifestPath, config)).rejects.toThrow('Another codown publisher');
    expect(fs.existsSync(lock)).toBe(true);
    expect(command('svnlook', ['youngest', repository]).trim()).toBe('0');
  });

  test('keeps ticket submission manual and records the exact SVN revision locally', async () => {
    const { manifestPath, config } = await fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await publishAndReport(manifestPath, config);
    expect(log.mock.calls.flat().join('\n')).toContain(`Manual deployment: ${ticketUrl}`);
    expect(log.mock.calls.flat().join('\n')).toContain('No ticket has been created');
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), 'svn-receipt.json'), 'utf8')).revision).toBe('1');
    expect(command('svn', ['list', `${config.svnUrl}/${identity.keyfrom}`])).not.toContain('receipt');
  });
});

describe('codown build orchestration and online verification', () => {
  test.skipIf(process.platform === 'win32')('passes the renamed payload URL to the real builder config in a single full-build invocation', () => {
    const root = temporary();
    const shims = path.join(root, 'shims');
    const output = path.join(root, 'fresh output');
    fs.mkdirSync(shims);
    const configPath = path.resolve('scripts/electron-builder-config.cjs');
    fs.writeFileSync(path.join(shims, 'npm'), `#!${process.execPath}\nconst config=require(${JSON.stringify(configPath)});\nconsole.log('PROBE='+JSON.stringify({args:process.argv.slice(2),url:config.nsisWeb.appPackageUrl,targets:config.win.target,output:config.directories.output,reuse:process.env.LOBSTERAI_REUSE_NSIS_WEB_PACKAGE}));\n`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ['scripts/dist-win-web.cjs', '--keyfrom', identity.keyfrom, '--silent', '--codown'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${shims}${path.delimiter}${process.env.PATH}`,
        CODOWN_PUBLIC_BASE_URL: baseUrl,
        LOBSTERAI_BUILD_OUTPUT_DIR: output,
        LOBSTERAI_REUSE_NSIS_WEB_PACKAGE: '1',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split('\n').filter(line => line.startsWith('PROBE='));
    expect(lines).toHaveLength(1);
    const probe = JSON.parse(lines[0].slice('PROBE='.length));
    const version = require('../package.json').version;
    expect(probe).toEqual({
      args: ['run', 'dist:win'],
      url: `${baseUrl}/${identity.keyfrom}/lobsterai-${version}-silent.nsis.7z`,
      targets: ['nsis', 'nsis-web'],
      output,
    });
  });

  test('performs one build and preserves the snapshot when upload fails', async () => {
    const root = temporary();
    const plan = releasePlan({ target: ReleaseTarget.WinWeb, keyfrom: identity.keyfrom }, identity.version);
    const build = vi.fn((_args: string[], output: string) => writeArtifacts(output));
    const publish = vi.fn().mockRejectedValue(new Error('network unavailable'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(release(root, plan, { publicBaseUrl: baseUrl }, {}, {
      preflight: vi.fn(), build, verifySignatures: vi.fn(), publish,
    })).rejects.toThrow('network unavailable');
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][0]).toEqual(['run', 'dist:win:web', '--', '--keyfrom', identity.keyfrom, '--codown']);
    const manifestPath = path.join(manifestDirectory(root, identity), 'manifest.json');
    expect((await readManifest(manifestPath)).artifacts).toHaveLength(3);
    expect(fs.readdirSync(path.join(root, '.work'))).toEqual([]);
  });

  test('does not publish after a build or signature verification failure', async () => {
    for (const failSigning of [false, true]) {
      const root = temporary();
      const publish = vi.fn();
      const build = failSigning ? (_args: string[], output: string) => writeArtifacts(output) : () => { throw new Error('build failed'); };
      const check = () => { throw new Error('signature failed'); };
      await expect(release(root, releasePlan(identity, identity.version), { publicBaseUrl: baseUrl }, {}, {
        preflight: vi.fn(), build, verifySignatures: check, publish,
      })).rejects.toThrow(failSigning ? 'signature failed' : 'build failed');
      expect(publish).not.toHaveBeenCalled();
      expect(fs.existsSync(manifestDirectory(root, identity))).toBe(false);
    }
  });

  test('downloads all files and checks actual bytes, not just HTTP status', async () => {
    const { manifestPath } = await snapshot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (url: string) => new Response(fs.readFileSync(path.join(path.dirname(manifestPath), path.basename(new URL(url).pathname)))));
    await verifyManifest(manifestPath, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(log.mock.calls.flat().join('\n')).toContain('All downloads match');
    await expect(verifyManifest(manifestPath, { fetchImpl: async () => new Response('wrong') })).rejects.toThrow('checksum mismatch');
    await expect(verifyManifest(manifestPath, { fetchImpl: async () => new Response('', { status: 404 }) })).rejects.toThrow('manual deployment first');
  });

  test('refuses changing download bases after a web build', async () => {
    const { manifestPath } = await snapshot();
    await expect(publishManifest(manifestPath, { publicBaseUrl: 'https://other.example.test' })).rejects.toThrow('rebuilding is required');
  });

  test('publishes the payload as a dependency rather than a user installer', () => {
    expect(artifactPlan(identity).find((artifact: { kind: string }) => artifact.kind === ArtifactKind.Payload)?.name).toBe('lobsterai-2026.9.14.nsis.7z');
  });
});
