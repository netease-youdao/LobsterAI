import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireFileLock } from '@openclaw/fs-safe/file-lock';
import { isPidDefinitelyDead } from '#openclaw-pid-alive';

function legacyPid(raw) {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const pid = Number(raw);
  return Number.isSafeInteger(pid) && pid <= 0x7fffffff ? pid : null;
}

// Called only inside the stopped-Gateway migration lease. Old LobsterAI xAI
// writers used this one fixed path and stored a bare PID instead of an object.
export async function recoverLegacyXaiAuthLock(stateDir) {
  const authPath = path.join(stateDir, 'agents', 'main', 'agent', 'auth-profiles.json');
  const lockPath = `${authPath}.lock`;
  let stat;
  try {
    stat = fs.lstatSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  // Leave unknown lock formats, links, directories and active owners untouched.
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 10) return [];
  const raw = fs.readFileSync(lockPath, 'utf8');
  const pid = legacyPid(raw);
  if (pid === null) return [];
  if (!isPidDefinitelyDead(pid)) {
    throw new Error(`Legacy xAI auth lock owner is still active or cannot be verified (pid=${pid}): ${lockPath}. Close the older LobsterAI/OpenClaw process and retry.`);
  }
  const backupPath = `${lockPath}.legacy-pid-${randomUUID()}.bak`;
  let backedUp = false;
  const lock = await acquireFileLock(authPath, {
    managerKey: 'lobsterai.legacy-xai-auth-lock',
    retry: { retries: 0 },
    staleMs: 0,
    staleRecovery: 'remove-if-unchanged',
    payload: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
    parsePayload: value => ({ legacyPid: legacyPid(value) }),
    shouldReclaim: ({ payload }) => payload?.legacyPid === pid && isPidDefinitelyDead(pid),
    shouldRemoveStaleLock: snapshot => {
      if (snapshot.raw !== raw || !isPidDefinitelyDead(pid)) return false;
      if (!backedUp) {
        fs.writeFileSync(backupPath, raw, { flag: 'wx', mode: 0o600 });
        backedUp = true;
      }
      return true;
    },
  });
  // fs-safe rechecks the sidecar identity and bytes under its reclaim guard.
  // Release our replacement using its ownership token, never by blind unlink.
  await lock.release();
  return backedUp ? [`Recovered legacy xAI auth lock (pid=${pid}; backup: ${backupPath}).`] : [];
}
