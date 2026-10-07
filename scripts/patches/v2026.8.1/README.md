# OpenClaw v2026.8.1 patch notes

## Device identity conflicts without an import receipt

`openclaw-device-identity-preservation.patch` aligns the identity migration owner
with the runtime reader. A valid canonical SQLite identity remains authoritative
when a different valid retired `identity/device.json` exists without a migration
receipt. Startup and Doctor preserve both identities and report a notice instead
of refusing Gateway startup. Neither key material nor device auth/pairing rows
are changed, and no receipt is fabricated for an identity that was not imported.

The existing stopped-Gateway lease, identity coordinator, safe source validation,
native claim and simultaneous source/Doctor claim checks run before preservation.
A conflicting interrupted Doctor claim still follows the existing recovery error
path. Matching identities and invalid canonical repair retain their existing rules.
The startup helper bundler requires the patch. Rebuild both the Gateway/CLI runtime
and startup helpers; changing only the helper leaves Gateway's own preflight stale.

Verify upstream `state-migrations.device-identity.test.ts` and
`state-migrations.lock.test.ts`, then run LobsterAI's `openclawStartupStateMigration`
tests with `OPENCLAW_STARTUP_MIGRATION_RUNTIME` pointing to the rebuilt runtime.
Set `OPENCLAW_STARTUP_MIGRATION_GATEWAY=1` to exercise real Gateway restart with
a conflicting identity, no receipt and a cleared startup checkpoint. Also verify
startup, one-click repair and a cold restart through the Electron client.
Remove this patch when the pinned upstream owner provides equivalent preservation.

## Channel-scoped QR login

`openclaw-web-login-channel-routing.patch` adds optional `channel` selection to
both `web.login.start` and `web.login.wait`. A specified channel must match a
loaded QR provider; an omitted channel remains compatible only when at most one
provider is available. Ambiguous or unavailable selections fail before channel
stop/start or plugin login calls. Display ordering must not select an auth target.

LobsterAI sends `openclaw-weixin` in both requests. With QQ 2.0.1 and Weixin 2.4.3
loaded, the old first-provider routing selected QQ, stopped QQ accounts, and
returned a QR result without Weixin's session key. The separate QQ package
preparer patch observes credential rejections immediately, settles QR creation
failures, and prevents a cancelled old wait from deleting a newer session.
The app also sets the Gateway client's request deadline beyond the plugin's
login timeout: the RPC `timeoutMs` parameter alone does not override the client's
30-second default, which otherwise aborts a valid QR confirmation wait.

Run the upstream `web.start`, `web.channel`, and `channels.schema` tests, plus
LobsterAI's `imGatewayManager.weixin`, `weixinPluginActivation`, and
`prepare-openclaw-qqbot` tests. Rebuild the embedded runtime and verify WeChat
login with QQ enabled, retries/cancellation, real message delivery, and restart
persistence. Remove this patch when upstream provides equivalent explicit
provider selection and rejects ambiguous login requests.

## Marketplace clone failures during startup

`zz-openclaw-marketplace-clone-retry.patch` gives a failed marketplace source
`git clone` a typed error code before any plugin artifact is published. The
update path preserves the error code in its outcome. Doctor retains the install
record and reports this acquisition failure as a notice with retry guidance,
instead of turning an unavailable source repository into a global readiness
failure. Other install warnings are unchanged; no error-message matching is used.

The existing payload smoke check still runs. The later
`zzz-openclaw-plugin-degraded-startup.patch` supersedes this patch's narrow
startup disposition: repair warnings and pathless records no longer block the
whole Gateway. Install security and capability-consent checks still reject the
unsafe installation; failed acquisition cannot publish its partial clone.
Neither patch deletes user plugin records or changes plugin enable flags.

Validate with the upstream `marketplace`, `update`,
`missing-configured-plugin-install`, and `post-core-plugin-convergence` suites,
then rebuild the runtime. The LobsterAI startup compatibility helper separately
maps only retired `gateway.reload.mode` values `hot` and `restart` to `hybrid`
and removes only `gateway.reload.debounceMs` / `deferralTimeoutMs`, matching
the pinned Doctor's explicit retired-field rules. It uses an exact original
backup and the canonical config writer. Unknown config errors remain blocked
without removing their fields, and auth migration logs their paths without values.

Remove the patch when the pinned upstream carries the same typed acquisition
failure routing and passes the retained payload and unknown-owner regressions.

## Plugin availability and degraded startup

`zzz-openclaw-plugin-degraded-startup.patch` backports the global availability
policy from upstream [#150016](https://github.com/openclaw/openclaw/pull/150016)
and configured-path preservation from
[#150312](https://github.com/openclaw/openclaw/pull/150312), both included in
v2026.9.5. It also adapts pure config-hook isolation from
[#154543](https://github.com/openclaw/openclaw/pull/154543), which is not in 9.5.
This is a semantic backport for 8.1's startup, discovery, validation, and Doctor
interfaces. It retains loader quarantine and core integrity refusals.

Repair failures remain warnings; active payload failures are quarantined even
without an install path. Missing or uninspectable configured paths preserve
authored config and report typed diagnostics through Doctor. Failed plugin
Doctor registration suppresses stale owner callbacks for that invocation.
Pure config hooks work on a clone, so a throw cannot publish partial changes.

This does not port the entire deferred-migration ledger and state/config
protocol changes in [#147711](https://github.com/openclaw/openclaw/pull/147711).
State-writing migration errors, invalid core config, lease failure, and changed
migration inputs remain fatal. Do not downgrade arbitrary migration exceptions.

Rebuild both Gateway/CLI and the startup helpers. Run the tests embedded in the
patch and the real Electron acceptance described in the
[Chinese spec](../../../specs/bugfixes/openclaw-plugin-degraded-startup/2026-09-23-plugin-degraded-startup-design.md).
The spec records upstream commit IDs, version membership, acceptance evidence,
and removal criteria. After upgrading to 9.5, remove only the equivalent
150016/150312 portions after regression; retain or reassess 154543 until the
target contains that change. Review the marketplace acquisition patch separately.

## Manual lock-owner recovery

`zz-openclaw-lock-owner-recovery.patch` adds an optional asynchronous
`inspectOwner` hook to native gateway lock acquisition. LobsterAI's manual
repair helper uses it to distinguish stale PID references from live owners.
Native SQLite coordination and the file lock manager's remove-if-unchanged
checks remain authoritative; other callers retain the default owner policy.

The patch also uses `.NET Process.StartTime` for Windows process creation
identity and gives gateway lock queries a 5-second budget. An unavailable
identity remains unknown. LobsterAI may stop an orphan only after verifying
its executable, runtime entry, state/config ownership, creation identity,
parent exit and protection window; healthy gateways stay protected.

Rebuild startup/repair helpers before the opt-in Windows integration checks:

```powershell
$env:LOBSTERAI_TEST_LOCK_RECOVERY='1'
$env:OPENCLAW_LOCK_RECOVERY_SOURCE='<patched-openclaw-checkout>'
npm test -- openclawLockRecovery.runtime
```

The build rejects a source checkout missing the hook. Keep this patch until
the pinned upstream provides an equivalent native manual-recovery boundary.
See [the design and acceptance record](../../../specs/bugfixes/openclaw-lock-owner-recovery/2026-09-17-lock-owner-recovery-design.md).

## LobsterAI provider cooldown

`openclaw-lobsterai-provider-cooldown.patch` adds `lobsterai-server` to the
existing provider-managed auth cooldown bypass. LobsterAI's local token proxy
owns login refresh, and its server enforces user quota and selects upstream
model credentials. A billing/auth failure from one upstream model must not
disable the shared proxy credential and block other models for the agent.

The shared predicate covers both failure persistence and auth availability,
including already-persisted `inline-api-key:lobsterai-server` cooldowns. No
credential or SQLite migration is needed. Other providers retain their existing
cooldowns; real login and quota errors still reach the user.

After applying the patch, run the two owning upstream suites:

```sh
pnpm test src/agents/auth-profiles/usage.test.ts src/agents/model-auth.profiles.test.ts
```

Regression cases cover auth/billing failure writes and existing billing state
with both literal and environment-backed proxy credentials. The runtime build
fingerprint includes this patch; rebuild through `npm run electron:dev:openclaw`
before testing the fix in the desktop app. Remove this patch when the pinned
upstream provides an equivalent provider-managed cooldown contract.

## Auth migration config commit

`openclaw-auth-migration-config-commit.patch` adds an optional
`persistConfig(cfg): Promise<void>` callback to the upstream auth migration
owner. LobsterAI uses it to persist migrated auth metadata before the owner
archives the original credential files. This boundary is internal to the owner;
writing configuration after the function returns is too late to preserve retry
behavior when the config write fails.

The callback runs only when the current candidate changes configuration, after
any required SQLite import has been verified. It also covers AWS SDK markers
that have no credential rows and config-only credentials that have no source
JSON files. The original source and its existing archive history remain intact
if the callback rejects. Existing callers without the callback are unchanged.

The host callback must persist with optimistic concurrency checks, surface a
failed commit, and retry with freshly loaded configuration. It must not replace
the owner's credential parser or write authentication SQLite tables itself.
LobsterAI holds the upstream stopped-Gateway maintenance lock around this work.

Validation from the LobsterAI checkout, after applying patches and rebuilding
the startup migration helper:

```sh
OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime-dir> npm test -- openclawAuthProfileMigration
```

Fixtures use temporary state and synthetic credentials. Required cases include
ordinary non-main-agent migration, marker-only config persistence, failed config
commit followed by retry, and repeated startup without unrelated config changes.
Remove the patch once the pinned upstream owner provides an equivalent commit
boundary.

## Subagent collaboration lifecycle

- `openclaw-sessions-spawn-agent-id-schema.patch` makes `agentId` required in the
  model-visible native spawn schema when the requesting agent's effective
  `subagents.requireAgentId` policy requires explicit selection. The field also
  explains `agents_list` discovery. ACP and configured collector defaults retain
  their existing optional-target contract. Execution-time target allowlists are
  unchanged. Regression tests cover per-agent overrides and default policies.
- `openclaw-subagent-shared-gateway-context.patch` accepts distinct resolver
  closures that resolve to the same live Gateway context during batch completion.
  Every resolver is checked on each dispatch. Missing, retired or different
  Gateway owners remain rejected; no ambient fallback is introduced. Regression
  tests cover simultaneous children, owner retirement and incompatible bindings.
- `openclaw-subagent-settle-failure-event.patch` publishes a session-scoped
  `lobsterai.subagent.settle_failed` event after a terminal requester wake failure
  is persisted, before releasing its live Gateway binding. It contains only the
  requester session/run identity. LobsterAI accepts it only for that exact waiting
  request, shows a localized retry hint, and never reports completion. The durable
  upstream task delivery failure remains intact.

## Browser DNS failure and Gateway process recovery

Three independent patches contain browser failures at their owners. A DNS
failure in a Playwright document route must finish the affected request rather
than leak an unhandled rejection or terminate the Gateway. Restoring the global
handler alone keeps the process alive but can leave navigation waiting for its
timeout.

| Patch | Purpose and upstream source |
| --- | --- |
| `openclaw-gateway-fast-path-rejection-handler.patch` | Backports [#141163](https://github.com/openclaw/openclaw/pull/141163), commit `1ddd53680b6bbc1d725fd67edc9ffa31944dfe86`: install existing process error handlers before the Gateway fast path, without duplicate registration on full CLI fallback. |
| `openclaw-browser-navigation-error-containment.patch` | Change only `gotoPageWithNavigationGuard` in `pw-session-navigation.ts`, own all route callback failures, terminate failed requests, and contain late asynchronous work. Adds `pw-session-navigation.rejection.test.ts`. |
| `openclaw-browser-cdp-dispatch-rejection.patch` | Backports [#150177](https://github.com/openclaw/openclaw/pull/150177), commit `22572027ded601e128335c45c537a37113b384d5`: catch rejected CDP message dispatch promises and close the affected connection using its existing lifecycle. |

The navigation fix covers Playwright-based navigation in managed Chrome,
extension relay, and direct CDP profiles. The default LobsterAI in-app browser
uses `existing-session` through the MCP bridge and Electron navigation; it does
not execute this route callback. Inspect the actual profile/driver when testing
fallbacks or explicitly selected profiles.

Only known transient network errors from `assertBrowserNavigationAllowed` are
isolated to a subframe; unknown errors and `continue` failures still fail the
operation. DNS failures do not quarantine or close an existing page. Error
precedence is top-level policy denial, then ordinary `guardError`, then
`page.goto` failure, then cleanup failure. A `stopSignal` ends the wait for DNS;
late resolution/rejection remains observed and cannot continue the stale route.
Only the exact handler is removed. The full unroute-and-in-flight-drain cleanup
chain shares a 1000ms grace period, independent of the remaining goto timeout.
The patch adds no diagnostic logs and leaves adjacent navigation guards alone.

Apply the patch set through `npm run openclaw:patch`, run the owning upstream
startup, navigation, and CDP regression suites, and rebuild the runtime through
the normal OpenClaw runtime build flow. Verify real-browser DNS failure,
Gateway PID/readiness continuity, and subsequent browser operations on that
runtime. A source test or an isolated Chrome experiment does not establish
packaged-app, IM, or cross-platform coverage. The full scope and validation
record live in the [bugfix design](../../../specs/bugfixes/openclaw-browser-dns-recovery/2026-09-17-openclaw-browser-dns-recovery-design.md).

### Validation record (2026-09-17)

| Check | Result |
| --- | --- |
| Complete patch reapplication | Two complete runs of all 42 patches; each reported `Applied 42 / Skipped 0`. |
| LobsterAI patch suite | 20 files; 69 passed, 1 skipped (70 total). |
| Host checks | Changed-file strict ESLint, `node --check scripts/apply-openclaw-patches.cjs`, and `compile:electron` passed. |
| OpenClaw browser regression | 3 files, all 65 tests passed, including 13 new navigation cases, CDP, and existing navigation guard coverage. |
| OpenClaw process error policy | All 54 `unhandled-rejections` and all 10 `fatal-detection` tests passed. |
| Full OpenClaw CLI regression | Patched: 252 passed, 3 failed (255 total). Original `run-main.ts` and `exit.test.ts` restored: 248 passed, the same 3 failed with identical assertions (251 total). |
| Independent read-only navigation review | No outstanding finding. |
| Final QA runtime build | All `qaRuntime` phases passed; final build completed in 2m19.6s. |
| Real Gateway + managed Chrome | Six required scenarios passed; a separate client-side top-level redirect returned raw Node `ENOTFOUND` from the route guard in 1177ms. All 76 health checks passed on the same PID and WebSocket; zero unexpected disconnects. |

The three CLI failures reproduce on the original source and concern POSIX path
fixtures on Windows; they were left unchanged. The total differs by the four
new fast-path tests, which are absent from the original test file. This is not a
claim that the full CLI suite passed. The initial navigation red run covered
11 cases (9 failed, 2 passed); two boundary cases were added afterward, so the
current 13 cases were not all rerun against the original implementation.

Automated review was launched but its preflight rejected before sending because
TruffleHog is unavailable locally. No automated review conclusion was obtained;
this is neither a product failure nor a completed review. Ordinary oxlint
(warnings as errors) and oxfmt passed for all six changed upstream files.
The upstream changed gate passed conflict-marker and max-lines checks, then
stopped on assertion-SAFETY violations in seven files modified by existing
patches outside these three fixes. Broad type-aware lint and scoped tsgo could
not complete under local memory pressure; full OpenClaw type validation remains
a build-machine follow-up. The final live run used fresh Windows state/profile
and the rebuilt checkout, with LobsterAI's default proxy-compatible network
setting and blocked-host policy still active. A bad iframe was aborted while
its main page loaded, the same tab recovered, and policy denial remained effective.
The HTTP 302 case returned a Chromium DNS error and is distinct from the Node
route-guard case. Source/entry hashes matched; logs had no unhandled rejection
or uncaught exception. All four owned ports closed during cleanup; the final
Windows taskkill exit code is intentional cleanup. Actual user extension/attached
profiles, in-app MCP, packaged-app, real IM, and cross-platform acceptance are
not recorded as complete; see the design record.

### Retirement when upgrading OpenClaw

**Upgrading to `v2026.9.4` allows removal of only the fast-path handler patch
after equivalence and regression checks; do not remove all three patches.**

| Patch | Decision for `v2026.9.4` | Later removal condition |
| --- | --- | --- |
| Gateway fast-path handler | May remove: [that tag's `run-main.ts`](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/cli/run-main.ts#L1506) already contains #141163. | Confirm handlers are installed before actual Gateway work and only once on every shipped startup path, then pass the owning regression. |
| Browser navigation containment | Retain and port to the target source. The inspected [main navigation implementation](https://github.com/openclaw/openclaw/blob/5d1389f2c8a3546e2c6dd52bafe90a09e1667460/extensions/browser/src/browser/pw-session-navigation.ts#L409) still rethrows ordinary route DNS errors. | Remove only the portions covered by equivalent upstream route failure, request completion, and late-callback cleanup behavior; retain the regression contracts. |
| Browser CDP dispatch | Retain: #150177 merged on 2026-09-16 UTC / 2026-09-17 Asia/Shanghai, after `v2026.9.4` was published. | A later pinned release must contain #150177 or equivalent behavior and pass synchronous/asynchronous dispatch and connection-close regressions. |

Upstream inspection is fixed at main commit
`5d1389f2c8a3546e2c6dd52bafe90a09e1667460` on 2026-09-17. Recheck the exact
upgrade tag, update patch manifests/validators and this record, then rebuild;
a closed PR, patch conflict, or global rejection listener alone is not evidence
that all three fixes are obsolete.

## Reappeared workspace setup state

`openclaw-workspace-setup-recovery.patch` handles a retired setup JSON file that
reappears after a completed migration. This can block both startup migration and
Doctor with `legacy workspace setup conflicts with canonical SQLite state`, even
when the canonical setup state still matches its previous migration receipt.
The workspace migration owner handles recovery under its existing stopped-Gateway
lock, so startup and one-click repair use the same rules.

Recovery requires the same canonical workspace identity, a completed receipt
that confirms the previous source was removed, and a matching canonical setup
fingerprint. The incoming file must pass the existing version, field and
timestamp validation and contain only milestones already present in SQLite.
Different milestone timestamps in that narrow case are archived without changing
the canonical workspace row or bootstrap, identity, memory and session files.
Other conflicts retain the existing migration checks.

Before cleanup, the owner saves the original bytes in an independent regular file
under `OPENCLAW_STATE_DIR/workspace-setup-quarantine/<source-key-hash>/<sha256>.json`,
verifies its size and SHA-256, and records its path and the new source digest in a
non-authoritative migration receipt. The backup rejects symlink/hardlink traversal
and preserves a UTF-8 BOM and whitespace. A workspace alias or Windows junction
continues to use the canonical workspace identity; the backup lives in the local
state directory. The owner updates only migration bookkeeping, not the SQLite
workspace setup facts.

The receipt is committed before removing the claimed source. Cleanup retries
verify the backup, canonical fingerprint and claim again, including when the file
was removed before the final receipt update. Concurrent source changes, damaged
backups, alias changes and source/claim collisions remain blocked and preserve
the available files. Backup failure restores a source claimed by the current run.
The startup helper bundler requires this patch to prevent shipping a stale helper.

Validation uses the owning upstream workspace suites and a bundled integration
fixture with the same old/new milestone timestamps and a non-authoritative
`merged` receipt as the reported incident. All state is temporary:

```sh
# In the patched OpenClaw checkout:
TMPDIR=/private/tmp node node_modules/vitest/vitest.mjs run \
  --config test/vitest/vitest.infra.config.ts \
  src/infra/state-migrations.workspace-setup-recovery.test.ts \
  src/infra/state-migrations.workspace-setup.test.ts \
  src/infra/state-migrations.workspace-attestation-recovery.test.ts

# In LobsterAI, using the rebuilt runtime:
OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime> npm test -- openclawWorkspaceSetupRecovery
OPENCLAW_STARTUP_MIGRATION_RUNTIME=<runtime> OPENCLAW_STARTUP_MIGRATION_GATEWAY=1 \
  npm test -- openclawWorkspaceSetupRecovery
```

The Gateway fixture verifies authenticated health/history calls, shutdown and a
second successful startup. Host tests do not establish Windows package or customer
machine acceptance. Rebuild the pinned runtime when distributing this patch.

Validation on macOS, 2026-09-18: the same bundled regression reproduces the exact
original conflict with the existing runtime helper and passes with the rebuilt
helper. The three upstream workspace suites pass all 81 tests. The LobsterAI
startup, workspace, repair and patch suites pass 117 tests (one opt-in Gateway
test skipped in that run); the new integration suite passes its two migration
cases and its separately enabled Gateway/restart case. Electron compilation,
changed-file ESLint, upstream changed-file oxlint and script syntax checks pass.
All 44 patches apply successfully to a clean pinned checkout and on reapplication.
The isolated Gateway proof uses the rebuilt startup helper with the existing
mac-arm64 Gateway payload; a full runtime rebuild, Windows package, actual app UI
and provider request against the customer's environment have not been validated.

## Scheduling from admitted IM conversations

`zz-openclaw-channel-scheduling-authority.patch` adds the opt-in
`cron.allowChannelScheduling` setting. LobsterAI enables it for fresh user turns
that have already passed the IM channel's access policy. OpenClaw v2026.8.1
ignores wildcard command owners, so the previous `ownerAllowFrom: ["*"]`
integration did not expose the native `automations` tool to these conversations.
The gateway RPC methods remain named `cron.*`.

The patch admits a scheduling capability for the exact channel run. It uses the
existing final executable tool surface and cron authority resolver, leaving
explicit tool policies and other owner-only tools unchanged. Non-owner channel
capabilities cannot acquire operator-turn authority. Missing senders, internal
sources, heartbeats, room events, relayed inputs, spawned sessions and replayed
turns remain excluded; the capability expires when its originating run settles.
The setting is disabled by default outside LobsterAI. The `zz-` prefix places
the patch after the existing cron schema patches.

The built-in embedded executor must also bind that capability when constructing
tools, as the Codex executor already does. Its resolver reads the completed tool
capture at execution time, so scheduling stays unavailable until the final
callable surface is known and retained tool callbacks cannot outlive the run.

Creator grants and scheduling-only capability markers share process-local
registries across the gateway bundle and plugin SDK chunks. Otherwise an SDK
grant cannot be redeemed by the gateway, and a capability can lose its
scheduling-only restriction when transported between module copies. Grant
consumption stays single-use and gateway lifecycle resets revoke pending grants.

Native creation also retains the active channel account when a model supplies
an explicit recipient on that same channel. Explicit accounts and other channels
remain unchanged, and no thread is inherited for an explicit recipient. Without
this, a multi-account Feishu reminder can be created successfully but then try
to send through the unconfigured `default` account.

This belongs in a version-scoped patch because capability admission is internal
to OpenClaw's reply runner; marking every IM user as a global command owner would
also expose unrelated administrative tools. When upgrading, remove this patch
only after verifying equivalent channel scheduling admission and authority
isolation. Rebuild the runtime and gateway bundle before validating or shipping.

Regression coverage lives in the patch's admission, capability and schema tests.
LobsterAI config-sync tests verify the opt-in and removal of the ineffective
wildcard. Validate the complete flow with a real channel message, the Electron
scheduled-task view, native `automations` calls, and the reminder's delivery to
the originating channel account.

## Native Windows private directories

`openclaw-windows-private-directory-native.patch` backports upstream commit
d1175e88b4 (PR #140593, first released in v2026.9.3). v2026.8.1 creates private
Windows SQLite staging directories by spawning `powershell.exe` with an
`Add-Type` compiler step. Security software or policy that denies that child
process (CreateProcess `ERROR_ACCESS_DENIED`, surfaced by Node as `spawn EPERM`)
breaks legacy session import, device-identity migration, the Gateway
write-admission preflight and Doctor itself, so neither Quick Repair nor a
reinstall can recover. The patch creates the directory through Koffi and the
Win32 security APIs with the same atomic protected DACL and exclusive creation.

LobsterAI adds one guard on top of upstream: when the native helper cannot load
(stubbed Koffi or a blocked addon), roots inside `%USERPROFILE%` fall back to an
exclusive `mkdir` that inherits the owner/SYSTEM/Administrators ACL of the
profile; every other root remains fail-closed with the load error as its cause.
The upstream restart-helper changes are not included.

Windows runtimes must ship the real `koffi` package and its
`@koromix/koffi-win32-*` binary: `prune-openclaw-runtime.cjs` keeps them (and
trims build-only koffi content) when `runtime-build-info.json` reports a `win-*`
target. The runtime payload then keeps exactly the target's platform package
and refuses to package a real loader without it; a stubbed `koffi` still drops
every platform binary. The startup helper bundler refuses a source tree without
the native helper, and every bundle is checked for the removed PowerShell
implementation.

Verify with upstream `sqlite-private-directory.test.ts`,
`windows-private-directory.test.ts` and, on Windows,
`sqlite-private-directory.windows.test.ts`, then LobsterAI's
`openclawNativePrivateDirectory`, `pruneOpenClawRuntime`,
`openclawWindowsPayload` and `openclawSqliteWorkerProtocol.runtime` tests.
Rebuild the runtime (`OPENCLAW_FORCE_BUILD=1` if the patch hash did not change)
and, on a Windows machine, simulate the block by denying execute on
`powershell.exe` for the test user (`icacls ... /deny <user>:(X)`) before running
a legacy session import, Quick Repair and a cold Gateway start. Remove this
patch when the pinned upstream includes the native helper.

## Active exec sessions below the system prompt cache boundary

`openclaw-active-exec-sessions-runtime-context.patch` moves the per-turn
`Active exec sessions:` snapshot out of the `## Runtime` section of the system
prompt and into the hidden runtime-context carrier of the current user turn,
mirroring upstream `#140799` (shipped in v2026.9.3). The stable guidance line
(`Before input: process log; ...`) stays in the system prompt whenever the
`process` tool is callable. The carrier block is emitted only when the session
scope has running background processes, so idle turns add no bytes; upstream
still emits a `none` placeholder there (`#150286`, fix PR `#150290` open).

Why: on the OpenAI Completions route the whole system prompt is one message in
front of the history, so a background process starting or finishing between
turns rewrote the first bytes of the request and the provider prefix cache
missed on the entire history. The 2026-09-22 credit report showed each such
miss re-billing ~850K tokens at full price; within one run the snapshot was
built once per attempt, so in-run calls were already stable.

Behavior kept: runtime-only turns (heartbeat/cron without a user message) never
install the carrier in v2026.8.1, so they no longer see the process list; raw
model probes and settled tool finalization skip it too. Compaction hooks keep
the structured `activeProcessSessions` data. `prepareEmbeddedAttemptPromptContext`
now requires `capabilityToolNames` and `sandboxSessionKey`, supplied by the
settled phase from the prepared tool catalog and attempt setup.

Verify with upstream `runtime-facts-prompt.test.ts`,
`embedded-agent-runner/system-prompt.test.ts` and
`run/attempt-prompt-context.test.ts`, then in the Electron client confirm that
`systemPromptChars` in `[context-diag] pre-prompt` stays constant across turns
while a background `exec` is running and that the gateway log no longer reports
`[prompt-cache] cache read dropped` at run boundaries. Remove this patch when
the pinned upstream includes `#140799`.

## Startup and accepted-work continuity

Three patches backport selected OpenClaw improvements without changing the
`v2026.8.1` runtime pin:

- `zzzz-openclaw-worker-startup-checkpoints.patch` separates the model-catalog
  worker's serialized contract from host orchestration and combines startup/state
  migration checkpoint reads into one integrity-checked database observation.
  Credential fingerprints, lease-time rechecks, and invalidation remain intact.
- `zzzz-openclaw-parent-owned-recovery.patch` makes the parent own interrupted
  child recovery, with exact source-run claims and delivery receipts. Legacy
  receipts are reconciled without blindly relaunching children. Stop persists
  cancellation before acknowledgement, including the completed-child/pending-wake
  window. Commentary, errors, reasoning and silent replies cannot certify final
  delivery, even with explicit visibility metadata.
- `zzzz-openclaw-compaction-admission.patch` captures the predecessor before the
  send ACK and follows verified compaction lineage through admission, session
  initialization and abort ownership. It preserves the accepted run ID only
  within the same physical SQLite database. Reset, restart, cancellation and
  replaced databases remain routing boundaries.

The recovery and compaction patches address the same session ownership boundary
and should be reviewed together. Regression tests are included inside the source
patches, including real SQLite handoffs and cancellation/restart races.

References: OpenClaw [#154293](https://github.com/openclaw/openclaw/pull/154293),
[#153243](https://github.com/openclaw/openclaw/pull/153243), and
[#152958](https://github.com/openclaw/openclaw/pull/152958). These are selective
adaptations for the pinned runtime, not a complete runtime upgrade.

These changes affect the bundled runtime and require a rebuilt desktop package;
a renderer-only update cannot deliver them.
