import BetterSqlite3 from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { beforeEach, describe, expect, test } from 'vitest';

import { mediaSourceKey } from './mediaMetadataCompaction';
import { MEDIA_METADATA_MIGRATION_KEY, migrateInlineMediaMetadata } from './mediaMetadataMigration';

const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100_000, 7)]);
const dataUrl = `data:image/png;base64,${pngBytes.toString('base64')}`;

let db: BetterSqlite3.Database;
let kvValues: Map<string, unknown>;
let tempDir: string;

const kv = {
  get: <T>(key: string) => kvValues.get(key) as T | undefined,
  set: (key: string, value: unknown) => { kvValues.set(key, structuredClone(value)); },
};
const recoveryDirectory = (sessionId: string) => path.join(tempDir, 'recovery', sessionId);
const run = (shouldStop?: () => boolean) => migrateInlineMediaMetadata({
  db, kv, recoveryDirectory, pause: async () => {}, shouldStop,
});

const insert = (id: string, type: string, metadata: unknown) => {
  db.prepare(`INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
    VALUES (?, 'session', ?, '', ?, 1, 1)`).run(id, type, JSON.stringify(metadata));
};
const stored = (id: string) => JSON.parse((db.prepare('SELECT metadata FROM cowork_messages WHERE id = ?')
  .get(id) as { metadata: string }).metadata) as Record<string, any>;

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.exec(`CREATE TABLE cowork_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, content TEXT NOT NULL,
    metadata TEXT, created_at INTEGER NOT NULL, sequence INTEGER)`);
  kvValues = new Map();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-media-migration-'));
});

describe('migrateInlineMediaMetadata', () => {
  test('rewrites saved assets, result URLs and poll details to file references', async () => {
    const savedPath = path.join(tempDir, 'generated.png');
    fs.writeFileSync(savedPath, pngBytes);
    const asset = { type: 'image', url: dataUrl, originalUrl: dataUrl, filePath: savedPath, localPath: savedPath };
    insert('tool-use', 'tool_use', {
      toolUseId: 'call-1',
      mediaStatusDetails: { mediaType: 'image', resultUrls: [dataUrl], assets: [asset] },
      toolResultDetails: { mediaType: 'image', resultUrls: [dataUrl], assets: [asset] },
    });
    insert('system', 'system', { toolResultDetails: { mediaType: 'image', assets: [asset] } });

    const result = await run();

    expect(result).toMatchObject({ done: true, compactedRows: 2, rescuedImages: 0, skippedRows: 0 });
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore / 100);
    const toolUse = stored('tool-use');
    expect(toolUse.toolUseId).toBe('call-1');
    expect(toolUse.mediaStatusDetails.resultUrls).toEqual([pathToFileURL(savedPath).href]);
    expect(toolUse.toolResultDetails.assets[0]).toMatchObject({
      url: pathToFileURL(savedPath).href, originalUrl: mediaSourceKey(dataUrl), filePath: savedPath,
    });
    expect(JSON.stringify(stored('system'))).not.toContain('base64');
  });

  test('writes an image back to the recovery directory when its saved file is gone', async () => {
    const missingPath = path.join(tempDir, 'moved-away.png');
    insert('missing', 'tool_result', {
      toolResultDetails: { mediaType: 'image', assets: [{ type: 'image', url: dataUrl, originalUrl: dataUrl,
        filename: 'moved-away.png', filePath: missingPath, localPath: missingPath }] },
    });
    insert('unsaved', 'tool_result', {
      toolResultDetails: { mediaType: 'image', assets: [{ type: 'image', url: dataUrl }] },
    });

    const result = await run();

    expect(result).toMatchObject({ compactedRows: 2, rescuedImages: 2 });
    const rescued = stored('missing').toolResultDetails.assets[0];
    expect(rescued.filePath.startsWith(recoveryDirectory('session'))).toBe(true);
    expect(rescued).toMatchObject({ filename: 'moved-away.png', savedToRecoveryDirectory: true,
      url: pathToFileURL(rescued.filePath).href });
    expect(fs.readFileSync(rescued.filePath)).toEqual(pngBytes);
    // The same image is written once and shared by both rows.
    expect(stored('unsaved').toolResultDetails.assets[0].filePath).toBe(rescued.filePath);
    expect(fs.readdirSync(recoveryDirectory('session'))).toHaveLength(1);
  });

  test('leaves rows it cannot rescue and unrelated large metadata untouched', async () => {
    const videoDataUrl = `data:video/mp4;base64,${'A'.repeat(100_000)}`;
    const unrescuable = { toolResultDetails: { mediaType: 'video', assets: [{ type: 'video', url: videoDataUrl }] } };
    const unrelated = { toolResultDetails: { content: 'x'.repeat(100_000) }, toolInput: { image: dataUrl } };
    insert('video', 'tool_result', unrescuable);
    insert('unrelated', 'tool_result', unrelated);

    const result = await run();

    expect(result).toMatchObject({ done: true, compactedRows: 0, skippedRows: 1 });
    expect(stored('video')).toEqual(unrescuable);
    expect(stored('unrelated')).toEqual(unrelated);
  });

  test('rewrites rows only while the user is idle and can stop while waiting', async () => {
    const savedPath = path.join(tempDir, 'generated.png');
    fs.writeFileSync(savedPath, pngBytes);
    insert('row', 'tool_result', {
      toolResultDetails: { mediaType: 'image', assets: [{ type: 'image', url: dataUrl, filePath: savedPath }] },
    });
    let idleChecks = 0;
    let stop = false;
    const waiting = migrateInlineMediaMetadata({
      db, kv, recoveryDirectory, pause: async () => {},
      isIdle: () => { idleChecks += 1; return false; },
      waitForIdle: async () => { if (idleChecks >= 3) stop = true; },
      shouldStop: () => stop,
    });
    expect(await waiting).toMatchObject({ done: false, compactedRows: 0 });
    expect(stored('row').toolResultDetails.assets[0].url).toBe(dataUrl);

    let idle = false;
    const result = await migrateInlineMediaMetadata({
      db, kv, recoveryDirectory, pause: async () => {},
      isIdle: () => idle,
      waitForIdle: async () => { idle = true; },
    });
    expect(result).toMatchObject({ done: true, compactedRows: 1 });
  });

  test('resumes after an interrupted run and does not scan again once done', async () => {
    const savedPath = path.join(tempDir, 'generated.png');
    fs.writeFileSync(savedPath, pngBytes);
    insert('row', 'tool_result', {
      toolResultDetails: { mediaType: 'image', assets: [{ type: 'image', url: dataUrl, filePath: savedPath }] },
    });

    expect(await run(() => true)).toMatchObject({ done: false, compactedRows: 0 });
    expect(stored('row').toolResultDetails.assets[0].url).toBe(dataUrl);

    expect(await run()).toMatchObject({ done: true, compactedRows: 1 });
    expect(kvValues.get(MEDIA_METADATA_MIGRATION_KEY)).toMatchObject({ done: true });

    db.prepare('UPDATE cowork_messages SET metadata = ? WHERE id = ?').run(JSON.stringify({
      toolResultDetails: { mediaType: 'image', assets: [{ type: 'image', url: dataUrl, filePath: savedPath }] },
    }), 'row');
    expect(await run()).toMatchObject({ done: true, compactedRows: 0 });
    expect(stored('row').toolResultDetails.assets[0].url).toBe(dataUrl);
  });
});
