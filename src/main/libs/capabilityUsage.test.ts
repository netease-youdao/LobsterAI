import path from 'path';
import { expect, test } from 'vitest';

import { classifyCapability, getResourceAnalyticsSalt } from './capabilityUsage';

test('recognizes pinned OpenClaw MCP namespaces without uploading server or tool names', () => {
  const params = classifyCapability('private-server__private-query', {}, [], 'salt');
  expect(params.capabilityKind).toBe('mcp');
  expect(JSON.stringify(params)).not.toContain('private');
});

test('correlates tools from the same MCP server only within an installation', () => {
  const first = classifyCapability('private-server__query', {}, [], 'local-secret');
  const second = classifyCapability('private-server__write', {}, [], 'local-secret');
  const otherInstallation = classifyCapability('private-server__query', {}, [], 'other-secret');
  expect(first.serverId).toMatch(/^[\da-f]{32}$/);
  expect(first.serverId).toBe(second.serverId);
  expect(first.capabilityId).not.toBe(second.capabilityId);
  expect(first.serverId).not.toBe(otherInstallation.serverId);
  expect(first.capabilityId).not.toBe(otherInstallation.capabilityId);
});

test('only a read of an installed SKILL.md counts as a skill load, not arbitrary reads', () => {
  const skillPath = path.resolve('private', 'SKILL.md');
  const skills = [{ id: 'docx', isBuiltIn: true, skillPath }];
  expect(classifyCapability('read', { path: skillPath }, skills, 'salt')).toMatchObject({
    capabilityKind: 'skill_load',
    skillId: 'docx',
  });
  expect(
    classifyCapability('read', { path: path.resolve('other', 'SKILL.md') }, skills, 'salt')
      .capabilityKind,
  ).toBe('tool');
});

test('user capabilities have stable per-installation pseudonyms and no raw path/id', () => {
  const skillPath = path.resolve('private', 'SKILL.md');
  const skills = [{ id: 'private-name', skillPath }];
  const first = classifyCapability('read', { path: skillPath }, skills, 'salt');
  expect(first.capabilityId).toBe(
    classifyCapability('read', { path: skillPath }, skills, 'salt').capabilityId,
  );
  expect(first.capabilityId).not.toBe(
    classifyCapability('read', { path: skillPath }, skills, 'other-installation').capabilityId,
  );
  expect(JSON.stringify(first)).not.toContain('private');
});

test('the resource salt persists locally and is independent of the public installation id', () => {
  const values = new Map<string, unknown>();
  const store = { get: <T>(key: string) => values.get(key) as T | undefined,
    set: <T>(key: string, value: T) => { values.set(key, value); } };
  const salt = getResourceAnalyticsSalt(store);
  expect(getResourceAnalyticsSalt(store)).toBe(salt);
  expect(salt).toMatch(/^[\da-f-]{36}$/i);
  expect(values.has('installation_uuid')).toBe(false);
});
