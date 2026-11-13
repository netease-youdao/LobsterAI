import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  AgentPersonaFile,
  pickChangedAgentPersona,
  seedAgentPersonaFiles,
  writeAgentPersonaFiles,
} from './agentPersonaFiles';

let workspaceDir: string;

const readPersonaFile = (filename: AgentPersonaFile): string =>
  fs.readFileSync(path.join(workspaceDir, filename), 'utf8');

beforeEach(() => {
  workspaceDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agent-persona-')), 'workspace-writer');
});

afterEach(() => {
  fs.rmSync(path.dirname(workspaceDir), { recursive: true, force: true });
});

describe('seedAgentPersonaFiles', () => {
  test('creates the workspace and missing files from the stored values', () => {
    const created = seedAgentPersonaFiles(workspaceDir, { systemPrompt: '  Be terse.  ', identity: '' });

    expect(created).toEqual([AgentPersonaFile.Soul, AgentPersonaFile.Identity]);
    expect(readPersonaFile(AgentPersonaFile.Soul)).toBe('Be terse.\n');
    expect(readPersonaFile(AgentPersonaFile.Identity)).toBe('');
  });

  test('never overwrites an existing file, including an emptied one', () => {
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, AgentPersonaFile.Soul), 'Edited by the agent.\n', 'utf8');
    fs.writeFileSync(path.join(workspaceDir, AgentPersonaFile.Identity), '', 'utf8');

    const created = seedAgentPersonaFiles(workspaceDir, { systemPrompt: 'Stored soul', identity: 'Stored identity' });

    expect(created).toEqual([]);
    expect(readPersonaFile(AgentPersonaFile.Soul)).toBe('Edited by the agent.\n');
    expect(readPersonaFile(AgentPersonaFile.Identity)).toBe('');
  });
});

describe('writeAgentPersonaFiles', () => {
  test('overwrites only the fields that are set', () => {
    seedAgentPersonaFiles(workspaceDir, { systemPrompt: 'Old soul', identity: 'Old identity' });

    writeAgentPersonaFiles(workspaceDir, { systemPrompt: 'New soul' });

    expect(readPersonaFile(AgentPersonaFile.Soul)).toBe('New soul\n');
    expect(readPersonaFile(AgentPersonaFile.Identity)).toBe('Old identity\n');
    expect(fs.readdirSync(workspaceDir).sort()).toEqual([AgentPersonaFile.Identity, AgentPersonaFile.Soul]);
  });
});

describe('pickChangedAgentPersona', () => {
  test('writes both fields for a new agent', () => {
    expect(pickChangedAgentPersona(null, { systemPrompt: 'Soul' })).toEqual({ systemPrompt: 'Soul', identity: '' });
  });

  test('keeps only defined fields whose stored value changed', () => {
    expect(pickChangedAgentPersona(
      { systemPrompt: 'Soul', identity: 'Identity' },
      { systemPrompt: 'Soul', identity: 'New identity' },
    )).toEqual({ identity: 'New identity' });
    expect(pickChangedAgentPersona({ systemPrompt: 'Soul', identity: 'Identity' }, {})).toEqual({});
  });
});
