const fs = require('fs');
const path = require('path');

const MAX_ATTACHMENT_FILENAME_BYTES = 240;
const MAX_ATTACHMENT_EXTENSION_BYTES = 32;
const INVALID_FILENAME_CHARS_PATTERN = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const TRAILING_DOT_OR_SPACE_PATTERN = /[. ]+$/g;
const WINDOWS_RESERVED_FILENAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  let result = '';
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += charBytes;
  }
  return result;
}

function sanitizeAttachmentFilename(filename, fallbackIndex = 1) {
  const normalizedIndex = Number.isInteger(fallbackIndex) && fallbackIndex > 0
    ? fallbackIndex
    : 1;
  const fallback = `attachment-${normalizedIndex}`;
  const original = typeof filename === 'string' ? filename : '';
  const leafName = original.replace(/\\/g, '/').split('/').pop() || '';

  let safeName = leafName
    .replace(INVALID_FILENAME_CHARS_PATTERN, '_')
    .replace(TRAILING_DOT_OR_SPACE_PATTERN, '');

  if (!safeName || safeName === '.' || safeName === '..') {
    safeName = fallback;
  }

  if (WINDOWS_RESERVED_FILENAME_PATTERN.test(safeName)) {
    safeName = `_${safeName}`;
  }

  safeName = truncateUtf8(safeName, MAX_ATTACHMENT_FILENAME_BYTES)
    .replace(TRAILING_DOT_OR_SPACE_PATTERN, '');

  return safeName || fallback;
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertSafeDirectorySegment(value, label) {
  const segment = String(value ?? '');
  if (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes('/')
    || segment.includes('\\')
    || path.isAbsolute(segment)
  ) {
    throw new Error(`Unsafe ${label} path segment`);
  }
  return segment;
}

function lstatIfExists(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function ensureRealSubdirectory(parentRealPath, segment, label) {
  const targetPath = path.join(parentRealPath, segment);
  const existing = lstatIfExists(targetPath);

  if (existing?.isSymbolicLink()) {
    throw new Error(`Unsafe ${label} directory: symbolic links are not allowed`);
  }
  if (existing && !existing.isDirectory()) {
    throw new Error(`Unsafe ${label} directory: expected a directory`);
  }
  if (!existing) {
    fs.mkdirSync(targetPath);
  }

  const realTargetPath = fs.realpathSync(targetPath);
  if (!isPathInside(parentRealPath, realTargetPath)) {
    throw new Error(`Unsafe ${label} directory: path escapes the download directory`);
  }
  return realTargetPath;
}

function appendFilenameSuffix(filename, suffixNumber) {
  const extension = path.extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  const suffix = `-${suffixNumber}`;
  const safeExtension = truncateUtf8(extension, MAX_ATTACHMENT_EXTENSION_BYTES);
  const stemBudget = Math.max(
    1,
    MAX_ATTACHMENT_FILENAME_BYTES
      - Buffer.byteLength(suffix, 'utf8')
      - Buffer.byteLength(safeExtension, 'utf8'),
  );
  const safeStem = truncateUtf8(stem, stemBudget) || 'attachment';
  return `${safeStem}${suffix}${safeExtension}`;
}

function allocateUniqueFilename(filename, usedFilenames, nextSuffixes) {
  let candidate = filename;
  const filenameKey = filename.toLowerCase();
  let suffix = nextSuffixes.get(filenameKey) || 2;

  while (usedFilenames.has(candidate.toLowerCase())) {
    candidate = appendFilenameSuffix(filename, suffix);
    suffix += 1;
  }

  usedFilenames.add(candidate.toLowerCase());
  nextSuffixes.set(filenameKey, suffix);
  return candidate;
}

function writeRegularFile(targetPath, content) {
  const existing = lstatIfExists(targetPath);
  if (existing?.isSymbolicLink()) {
    throw new Error('Unsafe attachment target: symbolic links are not allowed');
  }
  if (existing && !existing.isFile()) {
    throw new Error('Unsafe attachment target: expected a regular file');
  }

  // Windows does not consistently support O_NOFOLLOW. The lstat check above
  // protects normal Windows writes; POSIX platforms also get an atomic
  // no-follow guard against a last-moment symlink replacement.
  const noFollowFlag = process.platform === 'win32'
    ? 0
    : (fs.constants.O_NOFOLLOW || 0);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_TRUNC
    | noFollowFlag;
  const descriptor = fs.openSync(targetPath, flags, 0o666);

  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error('Unsafe attachment target: expected a regular file');
    }
    fs.writeFileSync(descriptor, content);
  } finally {
    fs.closeSync(descriptor);
  }
}

function storeEmailAttachments({
  attachments,
  outputDir,
  accountId,
  uid,
  specificFilename = null,
}) {
  const accountSegment = assertSafeDirectorySegment(accountId, 'account');
  const uidSegment = assertSafeDirectorySegment(uid, 'UID');
  const logicalOutputDir = outputDir || '.';
  const logicalAccountOutputDir = path.join(logicalOutputDir, accountSegment, uidSegment);
  const resolvedOutputDir = path.resolve(logicalOutputDir);
  const resolvedAccountOutputDir = path.resolve(logicalAccountOutputDir);

  if (!isPathInside(resolvedOutputDir, resolvedAccountOutputDir)) {
    throw new Error('Unsafe attachment directory: path escapes the download directory');
  }

  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const realOutputDir = fs.realpathSync(resolvedOutputDir);
  const realAccountDir = ensureRealSubdirectory(
    realOutputDir,
    accountSegment,
    'account',
  );
  const realAttachmentDir = ensureRealSubdirectory(
    realAccountDir,
    uidSegment,
    'UID',
  );
  const usedFilenames = new Set();
  const nextSuffixes = new Map();
  const downloaded = [];

  attachments.forEach((attachment, index) => {
    const originalFilename = attachment.filename;
    if (specificFilename && originalFilename !== specificFilename) {
      return;
    }
    if (!attachment.content) {
      return;
    }

    const safeFilename = allocateUniqueFilename(
      sanitizeAttachmentFilename(originalFilename, index + 1),
      usedFilenames,
      nextSuffixes,
    );
    const resolvedFilePath = path.resolve(realAttachmentDir, safeFilename);
    if (!isPathInside(realAttachmentDir, resolvedFilePath)) {
      throw new Error('Unsafe attachment path: path escapes the attachment directory');
    }

    writeRegularFile(resolvedFilePath, attachment.content);

    const logicalFilePath = path.join(
      logicalAccountOutputDir,
      safeFilename,
    );
    const result = {
      filename: safeFilename,
      path: logicalFilePath,
      size: attachment.size,
    };
    if (typeof originalFilename === 'string' && originalFilename !== safeFilename) {
      result.originalFilename = originalFilename;
    }
    downloaded.push(result);
  });

  return downloaded;
}

module.exports = {
  MAX_ATTACHMENT_FILENAME_BYTES,
  isPathInside,
  sanitizeAttachmentFilename,
  storeEmailAttachments,
};
