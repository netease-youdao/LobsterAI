import { spawnSync } from 'node:child_process';

import { describe, expect, test } from 'vitest';

const runChannelDryRun = (args: string[], env: NodeJS.ProcessEnv = {}) => (
  spawnSync(process.execPath, ['scripts/dist-win-channel.cjs', ...args, '--dry-run'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf8',
  })
);

const runWebDryRun = (args: string[], env: NodeJS.ProcessEnv = {}) => (
  spawnSync(process.execPath, ['scripts/dist-win-web.cjs', ...args, '--dry-run'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf8',
  })
);

const readWebArtifactName = (silentOnDoubleClick: boolean) => (
  spawnSync(
    process.execPath,
    [
      '-e',
      "const config = require('./scripts/electron-builder-config.cjs'); process.stdout.write(`artifact=${config.nsisWeb.artifactName}\\n`);",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KEYFROM: 'dictbind',
        LOBSTERAI_CHANNEL_BUILD: '1',
        LOBSTERAI_SILENT_ON_DOUBLE_CLICK: silentOnDoubleClick ? '1' : '0',
        LOBSTERAI_WEB_INSTALLER: '1',
        LOBSTERAI_WEB_PKG_URL: 'https://cdn.example.test/LobsterAI.nsis.7z',
      },
      encoding: 'utf8',
    },
  )
);

const readWebBasePackageUrl = () => (
  spawnSync(
    process.execPath,
    [
      '-e',
      "const config = require('./scripts/electron-builder-config.cjs'); process.stdout.write(`packageUrl=${config.nsisWeb.appPackageUrl}\\n`);",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KEYFROM: 'dictbind',
        LOBSTERAI_CHANNEL_BUILD: '1',
        LOBSTERAI_SILENT_ON_DOUBLE_CLICK: '1',
        LOBSTERAI_WEB_INSTALLER: '1',
        LOBSTERAI_WEB_PKG_URL: '',
        LOBSTERAI_WEB_PKG_BASE_URL: 'https://cdn.example.test/releases',
      },
      encoding: 'utf8',
    },
  )
);

describe('channel installer build flags', () => {
  test('keeps channel builds interactive unless the silent flag is explicit', () => {
    const plain = runChannelDryRun(['--keyfrom', 'dictbind']);

    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('keyfrom=dictbind');
    expect(plain.stdout).toContain('silentOnDoubleClick=false source=default');
  });

  test('enables double-click silent install from an explicit build flag', () => {
    const silent = runChannelDryRun(['--keyfrom', 'dictbind', '--silent']);

    expect(silent.status).toBe(0);
    expect(silent.stdout).toContain('keyfrom=dictbind');
    expect(silent.stdout).toContain('silentOnDoubleClick=true source=cli');
  });

  test('does not leak inherited build env into a channel dry-run', () => {
    const inherited = runChannelDryRun(['--keyfrom', 'ci_plain_channel'], {
      LOBSTERAI_CHANNEL_BUILD: '1',
      LOBSTERAI_SILENT_ON_DOUBLE_CLICK: '1',
    });
    expect(inherited.status).toBe(0);
    expect(inherited.stdout).toContain('silentOnDoubleClick=false source=default');
    expect(inherited.stderr).toContain('ignoring inherited LOBSTERAI_CHANNEL_BUILD=1');
    expect(inherited.stderr).toContain('ignoring inherited LOBSTERAI_SILENT_ON_DOUBLE_CLICK=1');
  });
});

describe('web installer build flags', () => {
  test('keeps web installers interactive unless the silent flag is explicit', () => {
    const plain = runWebDryRun([
      '--keyfrom',
      'dictbind',
      '--pkg-base-url',
      'https://cdn.example.test/releases',
    ]);

    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain('keyfrom=dictbind');
    expect(plain.stdout).toContain('silentOnDoubleClick=false source=default');
  });

  test('carries the silent flag through the two-pass web build instructions', () => {
    const silent = runWebDryRun(['--keyfrom', 'dictbind', '--silent']);

    expect(silent.status).toBe(0);
    expect(silent.stdout).toContain('silentOnDoubleClick=true source=cli');
    expect(silent.stdout).toContain(
      'npm run dist:win:web -- --keyfrom dictbind --silent --pkg-url <uploaded-url>',
    );
    expect(silent.stdout).toMatch(
      /next: upload release[\\/]nsis-web[\\/]lobsterai-[^\s]+-x64\.nsis\.7z/,
    );
  });

  test('uses the prepackaged app for the stub-only pass', () => {
    const stubOnly = runWebDryRun([
      '--keyfrom',
      'dictbind',
      '--silent',
      '--pkg-url',
      'https://cdn.example.test/lobsterai.nsis.7z',
    ]);

    expect(stubOnly.status).toBe(0);
    expect(stubOnly.stdout).toContain('mode=stub-only');
    expect(stubOnly.stdout).toMatch(
      /electron-builder --win nsis-web --x64 --prepackaged release[\\/]win-unpacked/,
    );
  });

  test('does not leak inherited silent flags into a web build', () => {
    const inherited = runWebDryRun(
      [
        '--keyfrom',
        'ci_plain_web',
        '--pkg-base-url',
        'https://cdn.example.test/releases',
      ],
      {
        LOBSTERAI_CHANNEL_BUILD: '1',
        LOBSTERAI_SILENT_ON_DOUBLE_CLICK: '1',
      },
    );

    expect(inherited.status).toBe(0);
    expect(inherited.stdout).toContain('silentOnDoubleClick=false source=default');
    expect(inherited.stderr).toContain('ignoring inherited LOBSTERAI_CHANNEL_BUILD=1');
    expect(inherited.stderr).toContain(
      'ignoring inherited LOBSTERAI_SILENT_ON_DOUBLE_CLICK=1',
    );
  });

  test('marks only double-click-silent web artifacts in their filename', () => {
    const plain = readWebArtifactName(false);
    const silent = readWebArtifactName(true);

    expect(plain.status).toBe(0);
    expect(plain.stdout).toContain(
      'artifact=LobsterAI-WebSetup-${arch}-${version}-dictbind.${ext}',
    );
    expect(silent.status).toBe(0);
    expect(silent.stdout).toContain(
      'artifact=LobsterAI-WebSetup-${arch}-${version}-dictbind-silent.${ext}',
    );
  });

  test('uses the actual lowercase electron-builder package name for base URLs', () => {
    const probe = readWebBasePackageUrl();

    expect(probe.status).toBe(0);
    expect(probe.stdout).toMatch(
      /packageUrl=https:\/\/cdn\.example\.test\/releases\/dictbind\/lobsterai-[^/\s]+-x64\.nsis\.7z/,
    );
  });
});
