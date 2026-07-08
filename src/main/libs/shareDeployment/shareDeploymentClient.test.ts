import crypto from 'crypto';
import path from 'path';
import { describe, expect, test } from 'vitest';

import {
  buildNodeDeploymentClientSourceKey,
  buildStaticDeploymentClientSourceKey,
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
