# OpenClaw configuration delivery

IM account, channel, binding, skill, and agent edits should not force a complete
gateway restart when the runtime can apply them live. A channel plugin may still
reconnect its own transport when its credentials or connection settings change.

## Delivery and user-visible status

- With a live gateway, the desktop generates an immutable configuration candidate
  in memory. Enterprise overrides are merged before submission. Only the runtime
  writes the watched configuration file.
- `config.get` advertises `configMutationReceipts: 1`. Managed `config.set` and
  `config.patch` requests include a mutation ID, the base hash, and
  `allowRestart: false`. A restart-required candidate is rejected before it reaches
  the file watcher.
- A write acknowledgement proves persistence, not application. The desktop reports
  `applied` only when the runtime receipt matches the requested mutation and
  revision. Pending and rejected results stay distinct through IM IPC and Settings.
  An IM fingerprint is marked synchronized only after application is confirmed.
- Lost acknowledgements trigger read-only reconciliation at 1, 3, 10, and 30 seconds.
  They do not authorize a duplicate write or a restart. A confirmed base-hash
  conflict permits one regenerated candidate retry.
- When the gateway is stopped, the desktop may atomically write configuration, but
  the receipt remains pending until a running gateway attests to the saved revision.
  Cached success is revalidated against current persisted and applied identities.

## Necessary process replacement

Referenced inherited secrets, system proxy changes, plugin installation changes,
and runtime-classified restart requirements can still need a new process. The host
waits for its workloads and obtains a runtime lease that checks idleness and closes
write admission atomically. It commits that lease and waits for the exact process
to exit before writing the new configuration and spawning its replacement.

A lost commit acknowledgement remains uncertain: the host waits for exit and never
escalates it to a forced kill or a second commit. Process generation checks and the
restart owner prevent concurrent connection attempts from spawning a replacement
too early. Shutdown cancels pending reconciliation and prevents late connections.

Gateway reconnects join an in-progress handshake, keep a valid connection to the
current process, and ignore events from older client/process generations. Explicit
connection requests can resume after a deliberate disconnect, including restoring
IM session discovery and history polling.

## Runtime compatibility

This change requires the paired version-scoped runtime patch:

`scripts/patches/v2026.8.1/zzzz-openclaw-config-mutation-receipts.patch`

Rebuild the bundled runtime through the normal OpenClaw build scripts. An older
runtime without receipt capability leaves live edits pending instead of writing
the file behind its back or guessing that a restart is needed. The patch preserves
legacy configuration RPC behavior for clients that do not opt into managed
mutations. Diagnostics and public receipts contain identities, not raw secrets.

## Validation

Desktop tests cover candidate generation without live disk writes, receipt
reconciliation, Settings status, restart ownership, connection races, existing IM
history recovery, and enterprise configuration merging. Run the corresponding
Vitest files together with the Electron and renderer builds.

In the pinned OpenClaw checkout with all LobsterAI patches applied:

```sh
node scripts/run-vitest.mjs run --config test/vitest/vitest.gateway.config.ts \
  src/gateway/config-mutation-receipts.test.ts \
  src/gateway/host-config-restart-lease.test.ts \
  src/gateway/server-methods/config.env-restart.test.ts

node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts \
  src/gateway/gateway.config-mutations.e2e.test.ts
```

The gateway end-to-end suite exercises actual RPCs and the configuration watcher,
including hot apply, restart refusal before persistence, duplicate IDs, invalid
writes, saved-candidate attestation, and lease expiry/commit. It does not substitute
for manual testing with signed-in IM accounts or an installed desktop release.
