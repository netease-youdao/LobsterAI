import { LibraryErrorCode, LibraryLimits } from './constants';
import type { LocalArtifactItem } from './types';

const MAX_TIMESTAMP = 8_640_000_000_000_000;
const ASCII_PATTERN = /^[\x00-\x7f]*$/;
const textEncoder = new TextEncoder();

export class LibraryLocalDataError extends Error {
  constructor(readonly code: LibraryErrorCode, message: string) {
    super(message);
    this.name = 'LibraryLocalDataError';
  }
}

export interface LibraryLocalOrderKey {
  sessionUpdatedAt: number;
  sessionCreatedAt: number;
  sessionId: string;
  artifactSortTime: number;
  itemId: string;
}

export const isLibraryTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP
);

export const isLibraryIdentifier = (value: unknown): value is string => (
  typeof value === 'string'
  && value.trim().length > 0
  && value.length <= LibraryLimits.MaxIdentifierLength
);

/** Ascending SQLite BINARY order, including historical non-ASCII identifiers. */
export const compareLibraryBinaryStrings = (left: string, right: string): number => {
  if (left === right) return 0;
  if (ASCII_PATTERN.test(left) && ASCII_PATTERN.test(right)) return left < right ? -1 : 1;
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] < rightBytes[index] ? -1 : 1;
  }
  return leftBytes.length < rightBytes.length ? -1 : leftBytes.length > rightBytes.length ? 1 : 0;
};

export const isLibraryLocalOrderKey = (value: unknown): value is LibraryLocalOrderKey => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Partial<LibraryLocalOrderKey>;
  return isLibraryTimestamp(key.sessionUpdatedAt)
    && isLibraryTimestamp(key.sessionCreatedAt)
    && isLibraryTimestamp(key.artifactSortTime)
    && isLibraryIdentifier(key.sessionId)
    && isLibraryIdentifier(key.itemId);
};

export const getLibraryLocalOrderKey = (item: LocalArtifactItem): LibraryLocalOrderKey => {
  const key = {
    sessionUpdatedAt: item.latestSession?.updatedAt,
    sessionCreatedAt: item.latestSession?.createdAt,
    sessionId: item.latestSession?.sessionId,
    artifactSortTime: item.sortTime,
    itemId: item.itemId,
  };
  if (!isLibraryLocalOrderKey(key)) {
    throw new LibraryLocalDataError(LibraryErrorCode.InvalidLocalData, 'Invalid local library ordering data.');
  }
  return key;
};

const compareDescendingNumbers = (left: number, right: number): number => (
  left > right ? -1 : left < right ? 1 : 0
);

/** Negative means left precedes right in the task-first display order. */
export const compareLibraryLocalOrderKeys = (
  left: LibraryLocalOrderKey,
  right: LibraryLocalOrderKey,
): number => (
  compareDescendingNumbers(left.sessionUpdatedAt, right.sessionUpdatedAt)
  || compareDescendingNumbers(left.sessionCreatedAt, right.sessionCreatedAt)
  || compareLibraryBinaryStrings(right.sessionId, left.sessionId)
  || compareDescendingNumbers(left.artifactSortTime, right.artifactSortTime)
  || compareLibraryBinaryStrings(right.itemId, left.itemId)
);

export const compareLibraryLocalItems = (left: LocalArtifactItem, right: LocalArtifactItem): number => (
  compareLibraryLocalOrderKeys(getLibraryLocalOrderKey(left), getLibraryLocalOrderKey(right))
);
