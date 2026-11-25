import { describe, expect, test } from 'vitest';

import { ArtifactTypeValue } from '@/types/artifact';

import {
  canRenameArtifactFile,
  formatArtifactParentLocation,
  splitArtifactFileNameExtension,
} from './artifactHeaderPath';

describe('splitArtifactFileNameExtension', () => {
  test('splits standard filenames into stem and extension', () => {
    expect(splitArtifactFileNameExtension('随手文档 2026-11-25.md')).toEqual({
      stem: '随手文档 2026-11-25',
      extension: '.md',
    });
    expect(splitArtifactFileNameExtension('archive.tar.gz')).toEqual({
      stem: 'archive.tar',
      extension: '.gz',
    });
  });

  test('preserves dotfiles, extensionless names, and trailing dots as stem', () => {
    expect(splitArtifactFileNameExtension('.gitignore')).toEqual({
      stem: '.gitignore',
      extension: '',
    });
    expect(splitArtifactFileNameExtension('Makefile')).toEqual({
      stem: 'Makefile',
      extension: '',
    });
    expect(splitArtifactFileNameExtension('notes.')).toEqual({
      stem: 'notes.',
      extension: '',
    });
  });
});

describe('canRenameArtifactFile', () => {
  test('allows local non-service artifacts and rejects inline or local-service artifacts', () => {
    expect(canRenameArtifactFile({ filePath: '/vault/note.md', type: ArtifactTypeValue.Markdown })).toBe(true);
    expect(canRenameArtifactFile({ filePath: undefined, type: ArtifactTypeValue.Markdown })).toBe(false);
    expect(canRenameArtifactFile({ filePath: '/app', type: ArtifactTypeValue.LocalService })).toBe(false);
    expect(canRenameArtifactFile(null)).toBe(false);
  });
});

describe('formatArtifactParentLocation', () => {
  test('returns workspace name without repeating filename for root files', () => {
    expect(
      formatArtifactParentLocation(
        '/Users/wangning/Obsidian Vault/随手文档 2026-11-25.md',
        '/Users/wangning/Obsidian Vault',
      ),
    ).toEqual({
      displayPath: 'Obsidian Vault',
      fullParentPath: '/Users/wangning/Obsidian Vault',
    });
  });

  test('returns relative workspace folders and compacts deep nesting', () => {
    expect(
      formatArtifactParentLocation(
        '/Users/wangning/Obsidian Vault/00-Inbox/notes/todo.md',
        '/Users/wangning/Obsidian Vault/',
      ),
    ).toEqual({
      displayPath: 'Obsidian Vault / 00-Inbox / notes',
      fullParentPath: '/Users/wangning/Obsidian Vault/00-Inbox/notes',
    });

    expect(
      formatArtifactParentLocation(
        '/Users/wangning/Dev/lobsterai/src/renderer/components/artifacts/ArtifactPanel.tsx',
        '/Users/wangning/Dev/lobsterai',
      ),
    ).toEqual({
      displayPath: 'lobsterai / … / components / artifacts',
      fullParentPath: '/Users/wangning/Dev/lobsterai/src/renderer/components/artifacts',
    });
  });

  test('handles files outside workspace and Windows paths cleanly', () => {
    expect(
      formatArtifactParentLocation(
        '/Users/wangning/Desktop/exports/report.pdf',
        '/Users/wangning/Obsidian Vault',
      ),
    ).toEqual({
      displayPath: '~ / Desktop / exports',
      fullParentPath: '/Users/wangning/Desktop/exports',
    });

    expect(
      formatArtifactParentLocation(
        'C:\\Users\\Alice\\Workspace\\docs\\plan.docx',
        'c:\\users\\alice\\workspace',
      ),
    ).toEqual({
      displayPath: 'Workspace / docs',
      fullParentPath: 'C:/Users/Alice/Workspace/docs',
    });
  });

  test('returns null when filePath is missing or has no parent directory', () => {
    expect(formatArtifactParentLocation(undefined, '/vault')).toBeNull();
    expect(formatArtifactParentLocation('', '/vault')).toBeNull();
    expect(formatArtifactParentLocation('note.md', '/vault')).toBeNull();
  });
});
