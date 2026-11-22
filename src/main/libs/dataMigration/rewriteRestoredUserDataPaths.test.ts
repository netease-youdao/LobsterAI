import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  rewriteRestoredUserDataPathsInSqliteSync,
  rewriteUserDataPathsInMetadata,
  rewriteUserDataPathString,
} from './rewriteRestoredUserDataPaths';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-rewrite-paths-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('rewriteUserDataPathString', () => {
  test('rewrites managed userData subdirs strictly rooted at sourceUserDataPath', () => {
    const options = {
      sourceUserDataPath: '/Users/alice/Library/Application Support/LobsterAI',
      targetUserDataPath: '/tmp/independent-user-data',
      targetPathStyle: 'posix' as const,
    };

    expect(
      rewriteUserDataPathString(
        '/Users/alice/Library/Application Support/LobsterAI/cowork-image-originals/s1/pic.png',
        options,
      ),
    ).toBe('/tmp/independent-user-data/cowork-image-originals/s1/pic.png');

    expect(
      rewriteUserDataPathString(
        '/Users/alice/Library/Application Support/LobsterAI/generated-images/s1/out.png',
        options,
      ),
    ).toBe('/tmp/independent-user-data/generated-images/s1/out.png');

    expect(
      rewriteUserDataPathString(
        '/Users/alice/Library/Application Support/LobsterAI/generated-videos/s1/clip.mp4',
        options,
      ),
    ).toBe('/tmp/independent-user-data/generated-videos/s1/clip.mp4');

    expect(
      rewriteUserDataPathString(
        '/Users/alice/Library/Application Support/LobsterAI/workspaces/main/MEMORY.md',
        options,
      ),
    ).toBe('/tmp/independent-user-data/workspaces/main/MEMORY.md');

    expect(
      rewriteUserDataPathString(
        '/Users/alice/Library/Application Support/LobsterAI/SKILLs/demo/SKILL.md',
        options,
      ),
    ).toBe('/tmp/independent-user-data/SKILLs/demo/SKILL.md');
  });

  test('rewrites file:// URLs with spaces and preserves non-file URLs', () => {
    const options = {
      sourceUserDataPath: '/Users/alice/Library/Application Support/LobsterAI',
      targetUserDataPath: '/Users/bob/Library/Application Support/LobsterAI',
      targetPathStyle: 'posix' as const,
    };

    expect(
      rewriteUserDataPathString(
        'file:///Users/alice/Library/Application%20Support/LobsterAI/generated-images/s1/my%20pic.png',
        options,
      ),
    ).toBe('file:///Users/bob/Library/Application%20Support/LobsterAI/generated-images/s1/my%20pic.png');

    expect(rewriteUserDataPathString('https://example.com/generated-images/a.png', options))
      .toBe('https://example.com/generated-images/a.png');
    expect(rewriteUserDataPathString('data:image/png;base64,AAAA', options))
      .toBe('data:image/png;base64,AAAA');
    expect(rewriteUserDataPathString('inline:sha256:abcdef', options))
      .toBe('inline:sha256:abcdef');
  });

  test('never rewrites user project cwd paths, sibling prefixes, or traversal paths', () => {
    const options = {
      sourceUserDataPath: '/Users/alice/Library/Application Support/LobsterAI',
      targetUserDataPath: '/tmp/independent-user-data',
      targetPathStyle: 'posix' as const,
    };

    // User project file outside userData (even if folder happens to be named workspaces)
    expect(rewriteUserDataPathString('/Users/alice/projects/demo/workspaces/main/MEMORY.md', options))
      .toBe('/Users/alice/projects/demo/workspaces/main/MEMORY.md');
    expect(rewriteUserDataPathString('/Users/alice/Desktop/screenshot.png', options))
      .toBe('/Users/alice/Desktop/screenshot.png');

    // Sibling prefix must not match on substring boundary
    expect(
      rewriteUserDataPathString(
        '/Users/alice/Library/Application Support/LobsterAI-dev/cowork-image-originals/s1/pic.png',
        options,
      ),
    ).toBe('/Users/alice/Library/Application Support/LobsterAI-dev/cowork-image-originals/s1/pic.png');

    // Traversal segments rejected
    expect(
      rewriteUserDataPathString(
        '/Users/alice/Library/Application Support/LobsterAI/cowork-image-originals/../secret.txt',
        options,
      ),
    ).toBe('/Users/alice/Library/Application Support/LobsterAI/cowork-image-originals/../secret.txt');
  });

  test('handles Windows-to-POSIX and POSIX-to-Windows cross-platform rewrites', () => {
    expect(
      rewriteUserDataPathString(
        'C:\\Users\\alice\\AppData\\Roaming\\LobsterAI\\cowork-image-originals\\s1\\img.png',
        {
          sourceUserDataPath: 'C:\\Users\\alice\\AppData\\Roaming\\LobsterAI',
          targetUserDataPath: '/Users/bob/LobsterAI',
          targetPathStyle: 'posix',
        },
      ),
    ).toBe('/Users/bob/LobsterAI/cowork-image-originals/s1/img.png');

    expect(
      rewriteUserDataPathString(
        'file:///C:/Users/alice/AppData/Roaming/LobsterAI/generated-videos/s1/v.mp4',
        {
          sourceUserDataPath: 'C:\\Users\\alice\\AppData\\Roaming\\LobsterAI',
          targetUserDataPath: '/Users/bob/LobsterAI',
          targetPathStyle: 'posix',
        },
      ),
    ).toBe('file:///Users/bob/LobsterAI/generated-videos/s1/v.mp4');

    expect(
      rewriteUserDataPathString(
        '/Users/alice/LobsterAI/generated-images/s1/pic.png',
        {
          sourceUserDataPath: '/Users/alice/LobsterAI',
          targetUserDataPath: 'D:\\LobsterData\\Profile',
          targetPathStyle: 'win32',
        },
      ),
    ).toBe('D:\\LobsterData\\Profile\\generated-images\\s1\\pic.png');
  });

  test('fallback v1 detection without sourceUserDataPath only rewrites proven userData files', () => {
    const existing = new Set([
      'cowork-image-originals/s1/pic.png',
      'workspaces/main/MEMORY.md',
    ]);
    const options = {
      targetUserDataPath: '/tmp/new-v2-user-data',
      existsInTarget: (relPosix: string) => existing.has(relPosix),
      targetPathStyle: 'posix' as const,
    };

    expect(
      rewriteUserDataPathString('/old/machine/custom-dir/cowork-image-originals/s1/pic.png', options),
    ).toBe('/tmp/new-v2-user-data/cowork-image-originals/s1/pic.png');

    expect(
      rewriteUserDataPathString('/old/machine/custom-dir/workspaces/main/MEMORY.md', options),
    ).toBe('/tmp/new-v2-user-data/workspaces/main/MEMORY.md');

    // User project file with a `workspaces` folder that does NOT exist in restored userData -> untouched!
    expect(
      rewriteUserDataPathString('/Users/alice/my-repo/workspaces/app/index.ts', options),
    ).toBe('/Users/alice/my-repo/workspaces/app/index.ts');
  });
});

describe('rewriteUserDataPathsInMetadata', () => {
  test('rewrites all supported metadata media/attachment fields without mutating input or touching cwd paths', () => {
    const original = {
      retainedOriginalPath: '/src/userData/cowork-image-originals/s1/top.png',
      imageAttachmentPreviews: [
        {
          name: 'a.png',
          retainedOriginalPath: '/src/userData/cowork-image-originals/s1/a.png',
          localPath: '/Users/alice/my-project/design.png',
        },
      ],
      historyImageReferences: [
        { name: 'a.png', path: '/src/userData/cowork-image-originals/s1/a.png', previewOnly: false },
      ],
      localMediaAttachments: [
        { localPath: '/src/userData/cowork-image-originals/s1/im.jpg', mimeType: 'image/jpeg' },
      ],
      attachments: [
        { path: '/src/userData/SKILLs/demo/SKILL.md', name: 'SKILL.md' },
        { path: '/Users/alice/my-project/notes.md', name: 'notes.md' },
        '/src/userData/workspaces/main/MEMORY.md',
      ],
      toolResultDetails: {
        mediaType: 'image',
        resultUrls: ['file:///src/userData/generated-images/s1/gen.png'],
        assets: [
          {
            filePath: '/src/userData/generated-images/s1/gen.png',
            localPath: '/src/userData/generated-images/s1/gen.png',
            url: 'file:///src/userData/generated-images/s1/gen.png',
          },
        ],
      },
      mediaStatusDetails: {
        mediaType: 'video',
        assets: [
          {
            filePath: '/src/userData/generated-videos/s1/clip.mp4',
          },
        ],
      },
      imageEdits: [
        {
          requestId: 'req-1',
          source: {
            filePath: '/src/userData/image-editing/s1/v1.png',
            originalPath: '/Users/alice/my-project/raw.png',
          },
        },
      ],
    };
    const snapshot = JSON.stringify(original);

    const { metadata, changed } = rewriteUserDataPathsInMetadata(original, {
      sourceUserDataPath: '/src/userData',
      targetUserDataPath: '/dst/userData',
      targetPathStyle: 'posix',
    });

    expect(changed).toBe(true);
    // Input is not mutated.
    expect(JSON.stringify(original)).toBe(snapshot);

    expect(metadata.retainedOriginalPath).toBe('/dst/userData/cowork-image-originals/s1/top.png');
    expect(metadata.imageAttachmentPreviews).toEqual([
      {
        name: 'a.png',
        retainedOriginalPath: '/dst/userData/cowork-image-originals/s1/a.png',
        localPath: '/Users/alice/my-project/design.png',
      },
    ]);
    expect(metadata.historyImageReferences).toEqual([
      { name: 'a.png', path: '/dst/userData/cowork-image-originals/s1/a.png', previewOnly: false },
    ]);
    expect(metadata.localMediaAttachments).toEqual([
      { localPath: '/dst/userData/cowork-image-originals/s1/im.jpg', mimeType: 'image/jpeg' },
    ]);
    expect(metadata.attachments).toEqual([
      { path: '/dst/userData/SKILLs/demo/SKILL.md', name: 'SKILL.md' },
      { path: '/Users/alice/my-project/notes.md', name: 'notes.md' },
      '/dst/userData/workspaces/main/MEMORY.md',
    ]);
    expect(metadata.toolResultDetails).toEqual({
      mediaType: 'image',
      resultUrls: ['file:///dst/userData/generated-images/s1/gen.png'],
      assets: [
        {
          filePath: '/dst/userData/generated-images/s1/gen.png',
          localPath: '/dst/userData/generated-images/s1/gen.png',
          url: 'file:///dst/userData/generated-images/s1/gen.png',
        },
      ],
    });
    expect(metadata.mediaStatusDetails).toEqual({
      mediaType: 'video',
      assets: [{ filePath: '/dst/userData/generated-videos/s1/clip.mp4' }],
    });
    expect(metadata.imageEdits).toEqual([
      {
        requestId: 'req-1',
        source: {
          filePath: '/dst/userData/image-editing/s1/v1.png',
          originalPath: '/Users/alice/my-project/raw.png',
        },
      },
    ]);
  });

  test('returns unchanged when source and target userDataPath are identical', () => {
    const input = {
      historyImageReferences: [{ name: 'a.png', path: '/same/dir/cowork-image-originals/s1/a.png' }],
    };
    const result = rewriteUserDataPathsInMetadata(input, {
      sourceUserDataPath: '/same/dir',
      targetUserDataPath: '/same/dir',
      targetPathStyle: 'posix',
    });
    expect(result.changed).toBe(false);
    expect(result.metadata).toBe(input);
  });
});

describe('rewriteRestoredUserDataPathsInSqliteSync', () => {
  test('rewrites matching cowork_messages rows and skips malformed or non-matching rows', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'lobsterai.sqlite');
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE cowork_messages (
          id TEXT PRIMARY KEY,
          metadata TEXT
        );
      `);
      db.prepare('INSERT INTO cowork_messages (id, metadata) VALUES (?, ?)').run(
        'm1',
        JSON.stringify({
          historyImageReferences: [{ name: 'a.png', path: '/old/data/cowork-image-originals/s1/a.png', previewOnly: false }],
        }),
      );
      db.prepare('INSERT INTO cowork_messages (id, metadata) VALUES (?, ?)').run(
        'm2',
        JSON.stringify({
          attachments: [{ path: '/Users/alice/project/file.txt' }],
        }),
      );
      db.prepare('INSERT INTO cowork_messages (id, metadata) VALUES (?, ?)').run('m3', '{not-json');
      db.prepare('INSERT INTO cowork_messages (id, metadata) VALUES (?, ?)').run('m4', null);
    } finally {
      db.close();
    }

    const result = rewriteRestoredUserDataPathsInSqliteSync(dbPath, {
      sourceUserDataPath: '/old/data',
      targetUserDataPath: '/new/data',
      targetPathStyle: 'posix',
    });
    expect(result.updatedRows).toBe(1);

    const checkDb = new Database(dbPath, { readonly: true });
    try {
      const m1 = JSON.parse(
        (checkDb.prepare('SELECT metadata FROM cowork_messages WHERE id = ?').get('m1') as { metadata: string }).metadata,
      );
      const m2 = JSON.parse(
        (checkDb.prepare('SELECT metadata FROM cowork_messages WHERE id = ?').get('m2') as { metadata: string }).metadata,
      );
      expect(m1.historyImageReferences[0].path).toBe('/new/data/cowork-image-originals/s1/a.png');
      expect(m2.attachments[0].path).toBe('/Users/alice/project/file.txt');
    } finally {
      checkDb.close();
    }
  });
});
