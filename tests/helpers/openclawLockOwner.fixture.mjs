// Opt-in integration fixture: hold the real native lease before the entry runs.
import fs from 'node:fs';
import { acquireGatewayLock } from '#openclaw-gateway-lock';

// A failed assertion or process-inspection timeout must not leave an indefinite
// detached test writer on the developer's machine.
const watchdog = setTimeout(() => {
  console.error('Lock-owner fixture lifetime expired.');
  process.exit(1);
}, 300_000);
const lease = await acquireGatewayLock({ env: process.env, role: 'sqlite-maintenance', timeoutMs: 2_000 });
if (!lease) throw new Error('Fixture requires a real native lease.');
fs.writeFileSync(process.env.LOBSTERAI_LOCK_FIXTURE_READY, JSON.stringify({ pid: process.pid, parentPid: process.ppid }));
const timer = setInterval(() => {}, 1_000);
process.on('SIGTERM', async () => { await lease.release(); clearInterval(timer); clearTimeout(watchdog); });
await new Promise(() => {});
