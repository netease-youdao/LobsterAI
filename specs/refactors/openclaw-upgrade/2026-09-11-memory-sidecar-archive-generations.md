# Memory sidecar archive collisions during gateway startup

Base: LobsterAI `feat/openclaw-v2026.8.1`,
`92d9eca81c6cdb8b2568e9ea6f599466cec15048`; OpenClaw `v2026.8.1`,
`ea806575e6450e4d1efdfc72c19f04be982a1b9b`.

## Evidence and cause

The Windows diagnostic archive `lobsterai-logs-20260910-190511.zip` shows two
separate migration stages:

- At 19:01:43 (UTC+8), `main-2026-09-10.log:97146` records successful quarantine
  of the corrupt workspace attestation. The next line confirms workspace setup
  migration to SQLite. The earlier attestation fix worked.
- At 19:01:58, `gateway-2026-09-10.log:35398` reports that the legacy Memory Core
  sidecar cannot be retired because `openclaw/state/memory/main.sqlite.migrated`
  already exists. The migration has already resolved derived-index conflicts by
  keeping the canonical per-agent SQLite rows.
- `gateway-2026-09-10.log:35420` reports that startup migrations did not complete
  cleanly. Every subsequent attempt rediscovers the retained legacy source and
  fails again. The five-attempt/model-configuration UI message hides this cause.

This is an archive-name collision, not evidence that the memory database is
corrupt. The supplied logs do not establish why the legacy file and its earlier
archive coexist. The previous workspace diagnostic ZIP did not collect the
legacy memory directory or per-agent database, so this regression uses synthetic
SQLite fixtures matching the observed state; it is not a replay of those QA DBs.

The owner is `extensions/memory-core/src/migration/doctor-memory-sidecar.ts`.
Its fixed `.migrated` target causes a recoverable archive collision to produce a
warning. Gateway startup deliberately treats migration warnings as fatal.
Rebuilding `openclaw.json` does not remove this persisted-state collision.

## Recovery contract

`openclaw-memory-sidecar-archive-generations.patch` changes the upstream plugin
owner. It retains the existing import policy, including canonical-row precedence
for conflicting derived indexes and blocking warnings for unresolved imports.
There is no separate cleanup in LobsterAI's state helper or config repair path.

The generic upstream `archiveLegacyStateSource` already supports numbered
archives. Memory sidecars need a single generation for the entire SQLite family:

```text
main.sqlite.migrated.2
main.sqlite-wal.migrated.2
main.sqlite-shm.migrated.2
main.sqlite-journal.migrated.2
```

The first generation still uses `.migrated`. If any of the four candidate paths
exists, the migration selects the first entirely free generation, even when a
particular companion is absent from the current source. `lstat` also recognizes
occupied directory/symlink names. Unexpected inspection errors are blocking.

Earlier backups are never compared, overwritten or deleted. All present source
files move through `@openclaw/fs-safe` with its default no-overwrite policy,
including destinations created after selection. If a later companion cannot
move, already moved files are rolled back without overwriting a newly created
source. Archive/rollback failures retain warnings and stop startup. This keeps
the existing best-effort rollback semantics; it is not an atomic multi-file
transaction or a new guarantee about process/power loss during archival.

The success log includes the actual archive path. After a completed archive,
legacy discovery finds no source, so another startup creates no extra backup.
Both imported and previously backed-up data remain available for inspection.

## Verification

- The new public migration regression fails on the pinned unpatched owner with
  the same archive-exists warning as QA, then passes with the fix.
- Added cases cover canonical conflicts, import without a canonical index,
  identical backups, all four family-member name collisions, multiple archive
  generations, an occupied directory, inspection failure/retry, concurrent
  destination creation, and a real SQLite persistent journal with rollback.
- After applying the complete patch set, all 52 selected memory/index/archive
  contract tests passed, including the 11 added cases. Command, from the pinned
  source checkout:

  ```text
  node node_modules/vitest/vitest.mjs run --config test/vitest/vitest.extension-memory.config.ts extensions/memory-core/doctor-contract-api.test.ts --maxWorkers=1 -t "sidecar|index|archive|canonical|SQLite journal"
  ```

- All 29 version patches apply to an isolated pinned OpenClaw checkout and pass
  the build script's strong source validation.
- LobsterAI patch and startup-wrapper tests passed: 85 tests, with 20 gated
  tests skipped (the runtime integration suite was not enabled in this command).
  Changed-file ESLint, type-aware Oxlint for the two patched upstream files,
  `npm run compile:electron`, and `git diff --check` passed.
- A temporary Windows runtime rebuilds the Memory Core doctor entry from the
  patched source against the pinned packaged SDK. A live gateway fixture with
  conflicting canonical rows and an existing valid SQLite archive reproduces
  the original fatal warning. The patched gateway serves `/startupz` and
  `config.get` on the first start and restart, without creating another archive.
  Byte hashes of both archives, canonical memory rows and the generated
  configuration are checked. Temporary gateways use private state,
  disabled schedules/channels/browser, and their own loopback ports.
- The full upstream doctor-contract test run before adding the journal cases
  had 66 passes, 2 skips and one timeout in the unchanged oversized host-event
  log import test (120-second limit). No full-suite pass is claimed.

The source patch is shipped through the normal runtime build. The development
runtime under `vendor/openclaw-runtime/current` is not modified by the isolated
smoke test. This does not claim an installer rebuild, Electron UI test, or a
successful run on the QA computer.

If the upgraded QA build still fails, collect both directories while LobsterAI
is closed, including SQLite companion files and existing archives:

```text
%APPDATA%\LobsterAI\openclaw\state\memory\
%APPDATA%\LobsterAI\openclaw\state\agents\main\agent\
```

These are also needed to investigate the original file reappearance separately.
