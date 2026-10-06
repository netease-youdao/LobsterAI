import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import {
  ShareDeploymentFailureCode,
  ShareDeploymentPackageManager,
  type ShareDeploymentPersistence,
  ShareDeploymentPersistenceBindingKind,
  ShareDeploymentPersistenceProvider,
  ShareDeploymentPersistenceUpdateMode,
} from '../../../shared/shareDeployment/constants';
import {
  buildNodeDeploymentClientSourceKey,
  buildStaticDeploymentClientSourceKey,
  downloadDeploymentPersistenceArchive,
  getNodeDeployment,
  uploadNodeDeployment,
} from './shareDeploymentClient';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeProjectDirectory(projectDirectory: string): string {
  return path.resolve(projectDirectory.trim()).replace(/\\/g, '/').toLowerCase();
}

describe('buildNodeDeploymentClientSourceKey', () => {
  test('uses a generic service deployment project key when project directory is available', () => {
    const firstPathKey = buildNodeDeploymentClientSourceKey({
      sessionId: 'session-1',
      localServiceUrl: 'http://localhost:3000/login',
      projectDirectory: '/Users/admin/project/fanren-vote',
    });
    const secondPathKey = buildNodeDeploymentClientSourceKey({
      sessionId: 'session-2',
      localServiceUrl: 'http://localhost:5173/dashboard',
      projectDirectory: '/Users/admin/project/fanren-vote/',
    });
    const otherProjectKey = buildNodeDeploymentClientSourceKey({
      sessionId: 'session-1',
      localServiceUrl: 'http://localhost:3000/login',
      projectDirectory: '/Users/admin/project/other-app',
    });

    expect(firstPathKey).toBe(secondPathKey);
    expect(firstPathKey).toBe(
      sha256(`service-deployment:v3:${normalizeProjectDirectory('/Users/admin/project/fanren-vote')}`),
    );
    expect(firstPathKey).not.toBe(otherProjectKey);
  });

  test('uses generic session and url key when project directory is unavailable', () => {
    const legacyKey = buildNodeDeploymentClientSourceKey({
      sessionId: 'session-1',
      localServiceUrl: 'http://localhost:3000/login',
    });
    const otherSessionKey = buildNodeDeploymentClientSourceKey({
      sessionId: 'session-2',
      localServiceUrl: 'http://localhost:3000/login',
    });
    const projectKey = buildNodeDeploymentClientSourceKey({
      sessionId: 'session-1',
      localServiceUrl: 'http://localhost:3000/login',
      projectDirectory: '/Users/admin/project/fanren-vote',
    });

    expect(legacyKey).toBe(sha256('service-deployment:session-1:http://localhost:3000/login'));
    expect(legacyKey).not.toBe(otherSessionKey);
    expect(legacyKey).not.toBe(projectKey);
  });
});

describe('buildStaticDeploymentClientSourceKey', () => {
  test('uses a static deployment project key when project directory is available', () => {
    const sourceKey = buildStaticDeploymentClientSourceKey({
      sessionId: 'session-1',
      localServiceUrl: 'http://localhost:3000/login',
      projectDirectory: '/Users/admin/project/fanren-vote',
    });

    expect(sourceKey).toBe(
      sha256(`service-deployment:static:v1:${normalizeProjectDirectory('/Users/admin/project/fanren-vote')}`),
    );
    expect(sourceKey).not.toBe(buildNodeDeploymentClientSourceKey({
      sessionId: 'session-1',
      localServiceUrl: 'http://localhost:3000/login',
      projectDirectory: '/Users/admin/project/fanren-vote',
    }));
  });
});

describe('deployment response normalization', () => {
  test('preserves missing and explicit null deployment expiry fields', async () => {
    const lookup = (data: Record<string, unknown>) => getNodeDeployment(
      'https://server.test',
      'https://server.test/s',
      async () => new Response(
        JSON.stringify({ code: 0, data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      String(data.deploymentId),
    );

    const missingResult = await lookup({ deploymentId: 'dep_missing_expiry' });
    const nullResult = await lookup({ deploymentId: 'dep_null_expiry', expiresAt: null });

    expect(Object.prototype.hasOwnProperty.call(missingResult.deployment, 'expiresAt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(nullResult.deployment, 'expiresAt')).toBe(true);
    expect(nullResult.deployment?.expiresAt).toBeNull();
  });
});

describe('deployment persistence data management client', () => {
  test('downloads service data as a zip archive', async () => {
    const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lobster-persistence-client-test-'));

    try {
      const archiveContent = Buffer.from(
        '504b0506000000000000000000000000000000000000',
        'hex',
      );
      const downloadCalls: string[] = [];
      const downloadFetch = async (url: string): Promise<Response> => {
        downloadCalls.push(url);
        return new Response(archiveContent, { status: 200 });
      };

      const downloadResult = await downloadDeploymentPersistenceArchive(
        'https://server.test',
        downloadFetch,
        {
          deploymentId: 'dep_data',
          shareId: 'shr_data',
          projectDirectory: tempDirectory,
        },
      );

      expect(downloadResult.success).toBe(true);
      expect(downloadCalls).toEqual(['https://server.test/api/share-deployments/dep_data/persistence/archive']);
      expect(path.dirname(path.dirname(downloadResult.filePath ?? ''))).toBe(
        path.join(tempDirectory, '.lobster', 'persistence', 'shr_data'),
      );
      expect(path.basename(downloadResult.filePath ?? '')).toBe('shr_data-service-data.zip');
      expect(await fs.promises.readFile(downloadResult.filePath ?? '')).toEqual(Buffer.from(archiveContent));
    } finally {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test('sends replace mode in the persistence manifest when redeploying', async () => {
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lobster-persistence-replace-test-'),
    );
    const archivePath = path.join(tempDirectory, 'deployment.zip');
    await fs.promises.writeFile(
      archivePath,
      Buffer.from('504b0506000000000000000000000000000000000000', 'hex'),
    );
    let manifest: Record<string, unknown> | undefined;
    let quotaReservationId: string | undefined;
    const persistence: ShareDeploymentPersistence = {
      enabled: true,
      provider: ShareDeploymentPersistenceProvider.Filesystem,
      bindings: [{
        appPath: 'data',
        dataPath: 'data',
        kind: ShareDeploymentPersistenceBindingKind.Directory,
      }],
    };

    try {
      const result = await uploadNodeDeployment(
        'https://server.test',
        'https://public.test',
        async (_url, options) => {
          const form = options?.body as FormData;
          manifest = JSON.parse(String(form.get('manifest'))) as Record<string, unknown>;
          quotaReservationId = String(form.get('quotaReservationId'));
          return Response.json({
            code: 0,
            data: {
              deploymentId: 'dep_data',
              shareId: 'shr_data',
              url: 'https://public.test/share/shr_data',
              status: 'live',
              deploymentStatus: 'queued',
              failureCode: 'persistence_unavailable',
            },
          });
        },
        {
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          title: 'Persistent service',
          localServiceUrl: 'http://localhost:8000',
          projectDirectory: tempDirectory,
          nodeVersion: '20',
          installCommand: 'npm install',
          buildCommand: '',
          startCommand: 'npm start',
          port: 8000,
          persistence,
          persistenceUpdateMode: ShareDeploymentPersistenceUpdateMode.Replace,
          quotaReservationId: 'qrs_test',
          archivePath,
          sourceSha256: 'source-hash',
          archiveBytes: 22,
          clientSourceKey: 'client-key',
          analysis: {
            success: true,
            projectDirectory: tempDirectory,
            packageManager: ShareDeploymentPackageManager.Npm,
            nodeVersion: '20',
            installCommand: 'npm install',
            buildCommand: '',
            startCommand: 'npm start',
            port: 8000,
            totalFiles: 1,
            totalBytes: 22,
            excludedCount: 0,
            persistence,
            warnings: [],
            blockers: [],
          },
        },
      );

      expect(result.success).toBe(true);
      expect(result.deployment?.errorCode).toBe(
        ShareDeploymentFailureCode.PersistenceUnavailable,
      );
      expect((manifest?.persistence as Record<string, unknown>).updateMode).toBe(
        ShareDeploymentPersistenceUpdateMode.Replace,
      );
      expect(quotaReservationId).toBe('qrs_test');
    } finally {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test.each([
    {
      name: 'disabled by the renderer',
      persistence: {
        enabled: false,
        provider: ShareDeploymentPersistenceProvider.Filesystem,
        bindings: [{
          appPath: 'data',
          dataPath: 'data',
          kind: ShareDeploymentPersistenceBindingKind.Directory,
        }],
      } satisfies ShareDeploymentPersistence,
    },
    {
      name: 'enabled without bindings',
      persistence: {
        enabled: true,
        provider: ShareDeploymentPersistenceProvider.Filesystem,
        bindings: [],
      } satisfies ShareDeploymentPersistence,
    },
  ])('omits persistence from the manifest when it is $name', async ({ persistence }) => {
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lobster-persistence-disabled-test-'),
    );
    const archivePath = path.join(tempDirectory, 'deployment.zip');
    await fs.promises.writeFile(
      archivePath,
      Buffer.from('504b0506000000000000000000000000000000000000', 'hex'),
    );
    const detectedPersistence: ShareDeploymentPersistence = {
      enabled: true,
      provider: ShareDeploymentPersistenceProvider.Filesystem,
      bindings: [{
        appPath: 'data',
        dataPath: 'data',
        kind: ShareDeploymentPersistenceBindingKind.Directory,
      }],
    };
    let manifest: Record<string, unknown> | undefined;

    try {
      const result = await uploadNodeDeployment(
        'https://server.test',
        'https://public.test',
        async (_url, options) => {
          const form = options?.body as FormData;
          manifest = JSON.parse(String(form.get('manifest'))) as Record<string, unknown>;
          return Response.json({
            code: 0,
            data: {
              deploymentId: 'dep_data',
              shareId: 'shr_data',
              url: 'https://public.test/share/shr_data',
              status: 'live',
              deploymentStatus: 'queued',
            },
          });
        },
        {
          sessionId: 'session-1',
          artifactId: 'artifact-1',
          title: 'Persistent service',
          localServiceUrl: 'http://localhost:8000',
          projectDirectory: tempDirectory,
          nodeVersion: '20',
          installCommand: 'npm install',
          buildCommand: '',
          startCommand: 'npm start',
          port: 8000,
          persistence,
          archivePath,
          sourceSha256: 'source-hash',
          archiveBytes: 22,
          clientSourceKey: 'client-key',
          analysis: {
            success: true,
            projectDirectory: tempDirectory,
            packageManager: ShareDeploymentPackageManager.Npm,
            nodeVersion: '20',
            installCommand: 'npm install',
            buildCommand: '',
            startCommand: 'npm start',
            port: 8000,
            totalFiles: 1,
            totalBytes: 22,
            excludedCount: 0,
            persistence: detectedPersistence,
            warnings: [],
            blockers: [],
          },
        },
      );

      expect(result.success).toBe(true);
      expect(manifest).not.toHaveProperty('persistence');
    } finally {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test('rejects an HTTP 200 business error instead of saving it as a zip archive', async () => {
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lobster-persistence-client-error-test-'),
    );

    try {
      const result = await downloadDeploymentPersistenceArchive(
        'https://server.test',
        async () => Response.json({
          code: 41505,
          message: 'Service data management is not configured on the server.',
          data: null,
        }),
        {
          deploymentId: 'dep_data',
          shareId: 'shr_data',
          projectDirectory: tempDirectory,
        },
      );

      expect(result).toEqual({
        success: false,
        code: 41505,
        error: 'Service data management is not configured on the server.',
      });
      expect(fs.existsSync(path.join(tempDirectory, '.lobster'))).toBe(false);
    } finally {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test('reports an empty online data directory without writing an archive', async () => {
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lobster-persistence-client-empty-test-'),
    );

    try {
      const result = await downloadDeploymentPersistenceArchive(
        'https://server.test',
        async () => new Response(null, { status: 204 }),
        {
          deploymentId: 'dep_data',
          shareId: 'shr_data',
          projectDirectory: tempDirectory,
        },
      );

      expect(result).toEqual({
        success: true,
        empty: true,
      });
      expect(fs.existsSync(path.join(tempDirectory, '.lobster'))).toBe(false);
    } finally {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test('reports a missing cloud data directory without saving an error response', async () => {
    const tempDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'lobster-persistence-client-missing-test-'),
    );

    try {
      const result = await downloadDeploymentPersistenceArchive(
        'https://server.test',
        async () => Response.json({
          code: 41505,
          message:
            'Failed to export service data through the temporary service data function (HTTP 404): Cloud data does not exist.',
          data: null,
        }, { status: 500 }),
        {
          deploymentId: 'dep_data',
          shareId: 'shr_data',
          projectDirectory: tempDirectory,
        },
      );

      expect(result).toEqual({
        success: true,
        empty: true,
      });
      expect(fs.existsSync(path.join(tempDirectory, '.lobster'))).toBe(false);
    } finally {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
