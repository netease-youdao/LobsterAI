import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

interface EmailAttachment {
  filename?: string;
  content?: Buffer;
  size?: number;
}

interface StoredAttachment {
  filename: string;
  originalFilename?: string;
  path: string;
  size?: number;
}

interface StoreEmailAttachmentsOptions {
  attachments: EmailAttachment[];
  outputDir: string;
  accountId: string;
  uid: string | number;
  specificFilename?: string | null;
}

interface AttachmentStorageModule {
  MAX_ATTACHMENT_FILENAME_BYTES: number;
  isPathInside: (parentPath: string, candidatePath: string) => boolean;
  sanitizeAttachmentFilename: (filename: unknown, fallbackIndex?: number) => string;
  storeEmailAttachments: (options: StoreEmailAttachmentsOptions) => StoredAttachment[];
}

const require = createRequire(import.meta.url);
const {
  MAX_ATTACHMENT_FILENAME_BYTES,
  isPathInside,
  sanitizeAttachmentFilename,
  storeEmailAttachments,
} = require('../SKILLs/imap-smtp-email/scripts/attachment-storage.js') as AttachmentStorageModule;

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-email-attachment-'));
  temporaryDirectories.push(directory);
  return directory;
}

function tryCreateSymbolicLink(
  targetPath: string,
  linkPath: string,
  type: fs.symlink.Type,
): boolean {
  try {
    fs.symlinkSync(targetPath, linkPath, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      return false;
    }
    throw error;
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('sanitizeAttachmentFilename', () => {
  test('preserves normal English, Chinese, spaces, and extensions', () => {
    expect(sanitizeAttachmentFilename('report.pdf')).toBe('report.pdf');
    expect(sanitizeAttachmentFilename('季度报告.xlsx')).toBe('季度报告.xlsx');
    expect(sanitizeAttachmentFilename('photo 01.final.jpg')).toBe('photo 01.final.jpg');
  });

  test('removes POSIX, Windows, drive, UNC, and mixed traversal paths', () => {
    expect(sanitizeAttachmentFilename('../../../../../../hack')).toBe('hack');
    expect(sanitizeAttachmentFilename('..\\..\\Startup\\evil.cmd')).toBe('evil.cmd');
    expect(sanitizeAttachmentFilename('C:\\Windows\\win.ini')).toBe('win.ini');
    expect(sanitizeAttachmentFilename('\\\\server\\share\\payload.cmd')).toBe('payload.cmd');
    expect(sanitizeAttachmentFilename('../..\\mixed/path\\payload.txt')).toBe('payload.txt');
    expect(sanitizeAttachmentFilename('/etc/cron.d/payload')).toBe('payload');
  });

  test('produces a single safe path segment under Windows path semantics', () => {
    const windowsRoot = 'C:\\Users\\tester\\project\\default\\42';
    const unsafeFilenames = [
      '../../../../../../hack',
      '..\\..\\Startup\\evil.cmd',
      'C:\\Windows\\win.ini',
      '\\\\server\\share\\payload.cmd',
      '../..\\mixed/path\\payload.txt',
    ];

    for (const unsafeFilename of unsafeFilenames) {
      const safeFilename = sanitizeAttachmentFilename(unsafeFilename);
      const candidate = path.win32.resolve(windowsRoot, safeFilename);
      const relative = path.win32.relative(windowsRoot, candidate);

      expect(safeFilename).not.toMatch(/[\\/]/);
      expect(relative).not.toBe('..');
      expect(relative.startsWith(`..${path.win32.sep}`)).toBe(false);
      expect(path.win32.isAbsolute(relative)).toBe(false);
    }
  });

  test('replaces invalid names, control characters, and Windows device names', () => {
    expect(sanitizeAttachmentFilename(undefined, 3)).toBe('attachment-3');
    expect(sanitizeAttachmentFilename('', 2)).toBe('attachment-2');
    expect(sanitizeAttachmentFilename('.', 4)).toBe('attachment-4');
    expect(sanitizeAttachmentFilename('..', 5)).toBe('attachment-5');
    expect(sanitizeAttachmentFilename('file\u0000name?.txt')).toBe('file_name_.txt');
    expect(sanitizeAttachmentFilename('file.txt:payload')).toBe('file.txt_payload');
    expect(sanitizeAttachmentFilename('trailing. ')).toBe('trailing');
    expect(sanitizeAttachmentFilename('CON')).toBe('_CON');
    expect(sanitizeAttachmentFilename('nul.txt')).toBe('_nul.txt');
    expect(sanitizeAttachmentFilename('COM9.log')).toBe('_COM9.log');
    expect(sanitizeAttachmentFilename('LPT1')).toBe('_LPT1');
  });

  test('limits long ASCII and Unicode filenames by UTF-8 byte length', () => {
    const longAscii = sanitizeAttachmentFilename(`${'a'.repeat(400)}.txt`);
    const longUnicode = sanitizeAttachmentFilename(`${'文'.repeat(200)}.txt`);

    expect(Buffer.byteLength(longAscii, 'utf8')).toBeLessThanOrEqual(
      MAX_ATTACHMENT_FILENAME_BYTES,
    );
    expect(Buffer.byteLength(longUnicode, 'utf8')).toBeLessThanOrEqual(
      MAX_ATTACHMENT_FILENAME_BYTES,
    );
    expect(longUnicode).not.toContain('\uFFFD');
  });
});

describe('isPathInside', () => {
  test('accepts descendants and rejects equality, siblings, and parent traversal', () => {
    const root = path.resolve('/tmp/lobsterai-attachment-root');

    expect(isPathInside(root, path.join(root, 'account', '42'))).toBe(true);
    expect(isPathInside(root, root)).toBe(false);
    expect(isPathInside(root, `${root}-sibling`)).toBe(false);
    expect(isPathInside(root, path.resolve(root, '..', 'escaped'))).toBe(false);
  });
});

describe('storeEmailAttachments', () => {
  test('preserves normal download paths and file content', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const downloaded = storeEmailAttachments({
      attachments: [{
        filename: '季度报告.xlsx',
        content: Buffer.from('report-content'),
        size: 14,
      }],
      outputDir,
      accountId: 'account-1',
      uid: 42,
    });

    expect(downloaded).toEqual([{
      filename: '季度报告.xlsx',
      path: path.join(outputDir, 'account-1', '42', '季度报告.xlsx'),
      size: 14,
    }]);
    expect(fs.readFileSync(downloaded[0].path, 'utf8')).toBe('report-content');
  });

  test('contains the reported traversal filename inside the account and UID directory', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const downloaded = storeEmailAttachments({
      attachments: [{
        filename: '../../../escaped.txt',
        content: Buffer.from('proof'),
        size: 5,
      }],
      outputDir,
      accountId: 'default',
      uid: '123',
    });

    expect(downloaded).toEqual([{
      filename: 'escaped.txt',
      originalFilename: '../../../escaped.txt',
      path: path.join(outputDir, 'default', '123', 'escaped.txt'),
      size: 5,
    }]);
    expect(fs.readFileSync(downloaded[0].path, 'utf8')).toBe('proof');
    expect(fs.existsSync(path.join(root, 'escaped.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'escaped.txt'))).toBe(false);
  });

  test('contains Windows traversal on every platform', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const downloaded = storeEmailAttachments({
      attachments: [{
        filename: '..\\..\\Startup\\evil.cmd',
        content: Buffer.from('safe'),
        size: 4,
      }],
      outputDir,
      accountId: 'default',
      uid: '124',
    });

    expect(downloaded[0].filename).toBe('evil.cmd');
    expect(downloaded[0].originalFilename).toBe('..\\..\\Startup\\evil.cmd');
    expect(path.resolve(downloaded[0].path)).toBe(
      path.join(outputDir, 'default', '124', 'evil.cmd'),
    );
  });

  test('matches --file against the original filename before storing safely', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const maliciousFilename = '../../hack';
    const downloaded = storeEmailAttachments({
      attachments: [
        { filename: 'normal.txt', content: Buffer.from('normal'), size: 6 },
        { filename: maliciousFilename, content: Buffer.from('selected'), size: 8 },
      ],
      outputDir,
      accountId: 'default',
      uid: '125',
      specificFilename: maliciousFilename,
    });

    expect(downloaded).toHaveLength(1);
    expect(downloaded[0].filename).toBe('hack');
    expect(downloaded[0].originalFilename).toBe(maliciousFilename);
    expect(fs.readFileSync(downloaded[0].path, 'utf8')).toBe('selected');
  });

  test('keeps all attachments when safe filenames collide', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const downloaded = storeEmailAttachments({
      attachments: [
        { filename: 'report.pdf', content: Buffer.from('one'), size: 3 },
        { filename: '../report.pdf', content: Buffer.from('two'), size: 3 },
        { filename: 'REPORT.PDF', content: Buffer.from('three'), size: 5 },
      ],
      outputDir,
      accountId: 'default',
      uid: '126',
    });

    expect(downloaded.map(item => item.filename)).toEqual([
      'report.pdf',
      'report-2.pdf',
      'REPORT-3.PDF',
    ]);
    expect(downloaded[1].originalFilename).toBe('../report.pdf');
    expect(downloaded[2].originalFilename).toBe('REPORT.PDF');
    expect(downloaded.map(item => fs.readFileSync(item.path, 'utf8'))).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  test('allocates deterministic names efficiently for many duplicate attachments', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const attachmentCount = 100;
    const downloaded = storeEmailAttachments({
      attachments: Array.from({ length: attachmentCount }, (_, index) => ({
        filename: 'duplicate.txt',
        content: Buffer.from(String(index)),
        size: String(index).length,
      })),
      outputDir,
      accountId: 'default',
      uid: 'duplicate-load',
    });

    expect(downloaded).toHaveLength(attachmentCount);
    expect(downloaded[0].filename).toBe('duplicate.txt');
    expect(downloaded[1].filename).toBe('duplicate-2.txt');
    expect(downloaded.at(-1)?.filename).toBe('duplicate-100.txt');
    expect(new Set(downloaded.map(item => item.filename)).size).toBe(attachmentCount);
  });

  test('allows repeat downloads to update an existing regular file', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const baseOptions = {
      outputDir,
      accountId: 'default',
      uid: '127',
    };

    storeEmailAttachments({
      ...baseOptions,
      attachments: [{ filename: 'report.txt', content: Buffer.from('old'), size: 3 }],
    });
    const downloaded = storeEmailAttachments({
      ...baseOptions,
      attachments: [{ filename: 'report.txt', content: Buffer.from('new'), size: 3 }],
    });

    expect(fs.readFileSync(downloaded[0].path, 'utf8')).toBe('new');
  });

  test('preserves relative output paths in returned results', () => {
    const root = createTemporaryDirectory();
    const absoluteOutputDir = path.join(root, 'downloads');
    const relativeOutputDir = path.relative(process.cwd(), absoluteOutputDir);
    const downloaded = storeEmailAttachments({
      attachments: [{ filename: 'relative.txt', content: Buffer.from('ok'), size: 2 }],
      outputDir: relativeOutputDir,
      accountId: 'default',
      uid: '128',
    });

    expect(path.isAbsolute(downloaded[0].path)).toBe(false);
    expect(path.resolve(downloaded[0].path)).toBe(
      path.join(absoluteOutputDir, 'default', '128', 'relative.txt'),
    );
  });

  test('allows the explicitly selected output directory itself to be a symbolic link', () => {
    const root = createTemporaryDirectory();
    const realOutputDir = path.join(root, 'real-downloads');
    const linkedOutputDir = path.join(root, 'linked-downloads');
    fs.mkdirSync(realOutputDir);
    if (!tryCreateSymbolicLink(
      realOutputDir,
      linkedOutputDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    )) {
      return;
    }

    const downloaded = storeEmailAttachments({
      attachments: [{ filename: 'linked-root.txt', content: Buffer.from('ok'), size: 2 }],
      outputDir: linkedOutputDir,
      accountId: 'default',
      uid: 'linked-root',
    });

    expect(downloaded[0].path).toBe(
      path.join(linkedOutputDir, 'default', 'linked-root', 'linked-root.txt'),
    );
    expect(fs.readFileSync(
      path.join(realOutputDir, 'default', 'linked-root', 'linked-root.txt'),
      'utf8',
    )).toBe('ok');
  });

  test('rejects unsafe account or UID directory segments', () => {
    const root = createTemporaryDirectory();
    const options = {
      attachments: [{ filename: 'file.txt', content: Buffer.from('content'), size: 7 }],
      outputDir: path.join(root, 'downloads'),
      accountId: 'default',
      uid: '129',
    };

    expect(() => storeEmailAttachments({
      ...options,
      accountId: '../escaped',
    })).toThrow('Unsafe account path segment');
    expect(() => storeEmailAttachments({
      ...options,
      uid: '..\\escaped',
    })).toThrow('Unsafe UID path segment');
  });

  test('rejects an existing symbolic-link file target', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    storeEmailAttachments({
      attachments: [{ filename: 'seed.txt', content: Buffer.from('seed'), size: 4 }],
      outputDir,
      accountId: 'default',
      uid: '130',
    });

    const outsideFile = path.join(root, 'outside.txt');
    const linkedFile = path.join(outputDir, 'default', '130', 'linked.txt');
    fs.writeFileSync(outsideFile, 'outside');
    if (!tryCreateSymbolicLink(outsideFile, linkedFile, 'file')) {
      return;
    }

    expect(() => storeEmailAttachments({
      attachments: [{ filename: 'linked.txt', content: Buffer.from('attack'), size: 6 }],
      outputDir,
      accountId: 'default',
      uid: '130',
    })).toThrow('symbolic links are not allowed');
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside');
  });

  test('rejects a symbolic-link account directory that escapes the output root', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const outsideDirectory = path.join(root, 'outside');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(outsideDirectory);
    if (!tryCreateSymbolicLink(
      outsideDirectory,
      path.join(outputDir, 'default'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )) {
      return;
    }

    expect(() => storeEmailAttachments({
      attachments: [{ filename: 'file.txt', content: Buffer.from('attack'), size: 6 }],
      outputDir,
      accountId: 'default',
      uid: '131',
    })).toThrow('symbolic links are not allowed');
    expect(fs.existsSync(path.join(outsideDirectory, '131', 'file.txt'))).toBe(false);
  });

  test('rejects a directory at the final file path and skips attachments without content', () => {
    const root = createTemporaryDirectory();
    const outputDir = path.join(root, 'downloads');
    const targetDirectory = path.join(outputDir, 'default', '132', 'folder.txt');
    fs.mkdirSync(targetDirectory, { recursive: true });

    expect(() => storeEmailAttachments({
      attachments: [{ filename: 'folder.txt', content: Buffer.from('attack'), size: 6 }],
      outputDir,
      accountId: 'default',
      uid: '132',
    })).toThrow('expected a regular file');

    expect(storeEmailAttachments({
      attachments: [{ filename: 'empty.txt', size: 0 }],
      outputDir,
      accountId: 'default',
      uid: '133',
    })).toEqual([]);
  });
});

describe('email Skill security release metadata', () => {
  test('bumps both bundled and published Skill versions', () => {
    const skillMarkdown = fs.readFileSync(
      path.resolve('SKILLs/imap-smtp-email/SKILL.md'),
      'utf8',
    );
    const metadata = JSON.parse(
      fs.readFileSync(path.resolve('SKILLs/imap-smtp-email/_meta.json'), 'utf8'),
    ) as { version: string };

    expect(skillMarkdown).toMatch(/^version: 1\.0\.7$/m);
    expect(metadata.version).toBe('0.0.8');
  });
});
