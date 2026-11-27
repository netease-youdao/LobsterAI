import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function readEntries(file) {
  if (!file) return [];
  try {
    const values = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!values || typeof values !== 'object' || Array.isArray(values)) return [];
    return Object.entries(values).filter(([key, value]) => key && typeof value === 'string' && value);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[Channels] Cannot read saved private recipients:', error.code ?? error.name);
    return [];
  }
}

/** Account-scoped routing data needed when a timer fires after the driver restarted. */
export class DirectRecipientStore {
  constructor(platform, accountKey, { legacyFile, limit = Infinity } = {}) {
    const home = process.env.DSH_HOME;
    const digest = createHash('sha256').update(accountKey).digest('hex');
    this.file = home && accountKey ? path.join(home, 'channel-state', platform, digest + '.json') : null;
    const saved = new Map(readEntries(this.file));
    const legacy = readEntries(legacyFile).filter(([key]) => !saved.has(key));
    this.entries = new Map([...legacy, ...saved].slice(-limit));
    this.limit = limit;
    this.pendingWrite = false;
  }

  remember(key, value) {
    if (!key || !value) return;
    if (this.entries.get(key) !== value) this.pendingWrite = true;
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    if (!this.file || !this.pendingWrite) return;

    const temp = this.file + '.' + randomUUID() + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
      this.pendingWrite = false;
    } catch (error) {
      console.warn('[Channels] Cannot persist private recipient:', error.code ?? error.name);
      try { fs.unlinkSync(temp); } catch { /* May not have been created. */ }
    }
  }
}
