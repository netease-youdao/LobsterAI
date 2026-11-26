import fs from 'fs';
import path from 'path';

import type { ArtifactFileAccess } from '../../shared/artifactPreview/types';
import type { LibraryLocalAccessData } from '../../shared/library/types';
import type { RemoteOwner } from '../../shared/remote/constants';
import { sameAgentOwner } from '../agentOwnership';
import { t } from '../i18n';
import type { LibraryLocalStore } from './libraryLocalStore';

export interface LibraryFileAccessLease {
  assertAllowed: (filePath?: string) => void;
}

export class LibraryFileAccessError extends Error {
  constructor() {
    super(t('libraryFileUnavailable'));
  }
}

/** Application-level visibility for indexed artifacts; ordinary local files retain their existing behavior. */
export class LibraryFileAccessPolicy {
  constructor(
    private readonly store: Pick<LibraryLocalStore, 'resolvePath' | 'getFileAccess'>,
    private readonly getOwner: () => RemoteOwner | null,
    private readonly getAccountEpoch: () => string,
  ) {}

  authorize(itemId: string): LibraryLocalAccessData {
    const filePath = this.store.resolvePath(itemId, this.getOwner());
    if (!filePath) this.unavailable();
    const access = { itemId, accountEpoch: this.getAccountEpoch() };
    this.capture(filePath, access);
    return { filePath, access };
  }

  capture(filePath: string, access?: ArtifactFileAccess): LibraryFileAccessLease {
    if (typeof filePath !== 'string' || !filePath.trim()) this.unavailable();
    if (access !== undefined && (!access || typeof access.itemId !== 'string'
      || !access.itemId || typeof access.accountEpoch !== 'string')) this.unavailable();
    const epoch = this.getAccountEpoch();
    const actor = this.getOwner();
    const owner = actor ? { ...actor } : null;
    const requestedPath = path.resolve(filePath);
    const entryPath = access ? this.store.resolvePath(access.itemId, owner) : requestedPath;
    if (!entryPath || (access && access.accountEpoch !== epoch)) this.unavailable();
    const entryRealPath = this.realPath(entryPath);
    const assertAllowed = (targetPath = requestedPath): void => {
      if (epoch !== this.getAccountEpoch() || !sameAgentOwner(owner, this.getOwner())) this.unavailable();
      if (access) {
        const currentPath = this.store.resolvePath(access.itemId, owner);
        if (!currentPath || this.realPath(currentPath) !== entryRealPath) this.unavailable();
      }
      // Preview resources may be siblings of the entry file, but cannot escape its directory
      // or read an indexed file belonging only to another account.
      const resolved = path.resolve(targetPath);
      const real = this.realPath(resolved);
      if (access && real !== entryRealPath) {
        const relative = path.relative(path.dirname(entryRealPath), real);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) this.unavailable();
      }
      for (const candidate of new Set([resolved, real])) {
        const visibility = this.store.getFileAccess(candidate, owner);
        if (visibility.tracked && !visibility.visible) this.unavailable();
      }
    };
    assertAllowed();
    return { assertAllowed };
  }

  private realPath(filePath: string): string {
    try { return fs.realpathSync.native(filePath); }
    catch { return this.unavailable(); }
  }

  private unavailable(): never {
    throw new LibraryFileAccessError();
  }
}
