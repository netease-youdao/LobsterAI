import fs from 'fs';
import path from 'path';

import type { RemoteOwner } from '../../shared/remote/constants';
import { sameOwner } from './canonical';
import type { RemoteStore } from './remoteStore';

export function filterOwnedInstances<T extends { instanceId: string }>(instances: T[], platform: string, store: RemoteStore, owner: RemoteOwner | null): T[] {
  return instances.filter(instance => {
    const source = store.sourceOwner(`im:${platform}:${instance.instanceId}`);
    return !source || sameOwner(source, owner);
  });
}

/** Called only after the Gateway has stopped, before credentials for another owner are written. */
export function fenceCronJobs(stateDirectory: string, store: RemoteStore, owner: RemoteOwner | null): void {
  const filename = path.join(stateDirectory, 'cron', 'jobs.json');
  if (!fs.existsSync(filename)) return;
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!Array.isArray(data.jobs)) throw new Error('Cannot verify scheduled task ownership');
  let changed = false;
  const restored: string[] = [];
  for (const job of data.jobs) {
    if (typeof job.id !== 'string') throw new Error('Cannot verify scheduled task identity');
    const source = store.sourceOwner(`cron:${job.id}`);
    if (!source) continue;
    const key = `pausedCron:${job.id}`;
    if (!sameOwner(source, owner)) {
      if (job.enabled !== false) { store.put(key, true); job.enabled = false; changed = true; }
    } else if (store.get<boolean>(key)) {
      job.enabled = true; changed = true; restored.push(key);
    }
  }
  if (!changed) return;
  const temporary = `${filename}.remote-tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  if (process.platform !== 'win32') { const fd = fs.openSync(path.dirname(filename), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  for (const key of restored) store.remove(key);
}
