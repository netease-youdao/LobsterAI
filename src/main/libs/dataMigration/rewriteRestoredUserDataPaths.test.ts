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

  test('rewrites message versions, edits, library artifacts/manual sources, and new managed subdirs safely', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'lobsterai.sqlite');
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE cowork_messages (id TEXT PRIMARY KEY, metadata TEXT);
        CREATE TABLE cowork_message_versions (id TEXT PRIMARY KEY, snapshot_json TEXT);
        CREATE TABLE cowork_message_edits (operation_id TEXT PRIMARY KEY, operation_json TEXT NOT NULL, snapshot_json TEXT NOT NULL);
        CREATE TABLE library_local_artifacts (id TEXT PRIMARY KEY, path_key TEXT NOT NULL UNIQUE, file_path TEXT NOT NULL);
        CREATE TABLE library_manual_sources (path_key TEXT PRIMARY KEY, file_path TEXT NOT NULL);
      `);

      db.prepare('INSERT INTO cowork_message_versions (id, snapshot_json) VALUES (?, ?)').run(
        'v1',
        JSON.stringify([
          {
            id: 'm1',
            metadata: {
              attachments: [{ path: '/old/data/browser-annotation-assets/a1.png' }],
              localMediaAttachments: [{ localPath: '/old/data/qq-media/img.jpg' }],
            },
          },
        ]),
      );

      db.prepare('INSERT INTO cowork_message_edits (operation_id, operation_json, snapshot_json) VALUES (?, ?, ?)').run(
        'op1',
        JSON.stringify({
          metadata: { retainedOriginalPath: '/old/data/word-drafts/doc1.docx' },
        }),
        JSON.stringify({
          messages: [{ metadata: { attachments: [{ path: '/old/data/slides-drafts/deck.pptx' }] } }],
        }),
      );

      db.prepare('INSERT INTO library_local_artifacts (id, path_key, file_path) VALUES (?, ?, ?)').run(
        'art1',
        '/old/data/generated-images/s1/pic.png',
        '/old/data/generated-images/s1/pic.png',
      );
      // Pre-existing target key to verify unique collision safety
      db.prepare('INSERT INTO library_local_artifacts (id, path_key, file_path) VALUES (?, ?, ?)').run(
        'art-existing',
        '/new/data/generated-images/s1/dup.png',
        '/new/data/generated-images/s1/dup.png',
      );
      db.prepare('INSERT INTO library_local_artifacts (id, path_key, file_path) VALUES (?, ?, ?)').run(
        'art-dup',
        '/old/data/generated-images/s1/dup.png',
        '/old/data/generated-images/s1/dup.png',
      );

      db.prepare('INSERT INTO library_manual_sources (path_key, file_path) VALUES (?, ?)').run(
        '/old/data/sheet-drafts/book.xlsx',
        '/old/data/sheet-drafts/book.xlsx',
      );
    } finally {
      db.close();
    }

    const result = rewriteRestoredUserDataPathsInSqliteSync(dbPath, {
      sourceUserDataPath: '/old/data',
      targetUserDataPath: '/new/data',
      targetPathStyle: 'posix',
    });

    expect(result.updatedVersionRows).toBe(1);
    expect(result.updatedEditRows).toBe(1);
    expect(result.updatedLibraryArtifactRows).toBe(1);
    expect(result.updatedLibraryManualSourceRows).toBe(1);
    expect(result.updatedRows).toBe(4);

    const checkDb = new Database(dbPath, { readonly: true });
    try {
      const versionSnap = JSON.parse(
        (checkDb.prepare('SELECT snapshot_json FROM cowork_message_versions WHERE id = ?').get('v1') as { snapshot_json: string }).snapshot_json,
      ) as Array<{ metadata: { attachments: Array<{ path: string }>; localMediaAttachments: Array<{ localPath: string }> } }>;
      expect(versionSnap[0].metadata.attachments[0].path).toBe('/new/data/browser-annotation-assets/a1.png');
      expect(versionSnap[0].metadata.localMediaAttachments[0].localPath).toBe('/new/data/qq-media/img.jpg');

      const editRow = checkDb.prepare('SELECT operation_json, snapshot_json FROM cowork_message_edits WHERE operation_id = ?')
        .get('op1') as { operation_json: string; snapshot_json: string };
      expect(editRow.operation_json).toContain('/new/data/word-drafts/doc1.docx');
      expect(editRow.snapshot_json).toContain('/new/data/slides-drafts/deck.pptx');

      const art1 = checkDb.prepare('SELECT path_key, file_path FROM library_local_artifacts WHERE id = ?')
        .get('art1') as { path_key: string; file_path: string };
      expect(art1).toEqual({
        path_key: '/new/data/generated-images/s1/pic.png',
        file_path: '/new/data/generated-images/s1/pic.png',
      });

      const manual = checkDb.prepare('SELECT path_key, file_path FROM library_manual_sources')
        .get() as { path_key: string; file_path: string };
      expect(manual).toEqual({
        path_key: '/new/data/sheet-drafts/book.xlsx',
        file_path: '/new/data/sheet-drafts/book.xlsx',
      });
    } finally {
      checkDb.close();
    }
  });
});
