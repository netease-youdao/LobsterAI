import { createHash, randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { RemoteOwner } from '../../shared/remote/constants';
import type { IdentityCipher, RemoteIdentity } from './installationIdentity';

export interface RemoteRegistrationIdentity extends RemoteIdentity { registrationScope?: string }
export interface RegistrationIdentities {
  get(owner: RemoteOwner, route: string): RemoteRegistrationIdentity;
  replace(owner: RemoteOwner, route: string): RemoteRegistrationIdentity;
}

/** Transport credentials may change; the database security journal identity must not. */
export class RemoteRegistrationIdentityStore implements RegistrationIdentities {
  private readonly directory: string;
  constructor(appData: string, userData: string, private readonly cipher: IdentityCipher, private readonly original: RemoteIdentity) {
    const profile = createHash('sha256').update(fs.realpathSync(userData)).digest('hex');
    this.directory = path.join(appData, 'LobsterAI-remote-identity', profile, 'registrations');
  }
  private filename(owner: RemoteOwner, route: string): string {
    const scope = createHash('sha256').update(JSON.stringify([owner.userId, owner.scopeKey, route])).digest('hex');
    return path.join(this.directory, `${scope}.bin`);
  }
  get(owner: RemoteOwner, route: string): RemoteRegistrationIdentity {
    const filename = this.filename(owner, route);
    if (!fs.existsSync(filename)) return this.original;
    if (!this.cipher.isEncryptionAvailable()) throw new Error('Secure device credential storage is unavailable');
    const value = JSON.parse(this.cipher.decryptString(fs.readFileSync(filename))) as RemoteRegistrationIdentity;
    if (!/^[a-f0-9-]{36}$/u.test(value.installationId) || !/^[A-Za-z0-9_-]{43}$/u.test(value.deviceKey)
      || value.registrationScope !== value.installationId || value.databaseId !== this.original.databaseId) {
      throw new Error('Invalid remote registration identity');
    }
    return value;
  }
  replace(owner: RemoteOwner, route: string): RemoteRegistrationIdentity {
    if (!this.cipher.isEncryptionAvailable()) throw new Error('Secure device credential storage is unavailable');
    const installationId = randomUUID();
    const value: RemoteRegistrationIdentity = { installationId, registrationScope: installationId,
      deviceKey: randomBytes(32).toString('base64url'), databaseId: this.original.databaseId };
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const filename = this.filename(owner, route), temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, this.cipher.encryptString(JSON.stringify(value))); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, filename);
      if (process.platform !== 'win32') {
        const directoryFd = fs.openSync(this.directory, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return value;
  }
}
