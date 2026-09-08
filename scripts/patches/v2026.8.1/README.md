# Cron compatibility patches

These patches address the scheduled-task failures reported during the
OpenClaw v2026.8.1 upgrade. The separate duplicate-conversation fix belongs in
LobsterAI's runtime adapter: it uses the `chat.history` response `sessionId`
to identify a transcript consistently across base and run-scoped aliases.

## `openclaw-windows-process-identity.patch`

Backports upstream commit
[`97bc908f`](https://github.com/openclaw/openclaw/commit/97bc908f8850872b960c36dfb58752f6c3a3b653).
It shares the Windows process-start reader across cron receipts, gateway locks,
port inspection, and node workers. CIM/PowerShell gets a bounded timeout and
WMIC fallback; successful identity reads for the current process are cached.
The durable receipt still requires a real process identity.

The patch includes the upstream implementation and regression tests. Upstream
CI routing and smoke-test command changes are omitted; run the Windows E2E
explicitly as described below. Upstream v2026.8.2 includes the commit. Remove
this patch when upgrading to a version containing it, after rerunning the
Windows process-identity and actual gateway cron tests.

## `openclaw-cron-preparation-failure-state.patch`

This local OpenClaw fix settles failures that occur while preparing a durable
run receipt, before a reservation exists. The shared admission boundary covers
manual runs, timer runs, and startup catch-up. It persists the error outcome
before emitting a finished event, so `cron.list` and `cron.runs` agree even
after restarting the service.

A transaction checks that the job's definition and prior run state are still
current and that no queued/running marker or active receipt owns it. A stale
failure cannot overwrite an edited, deleted, or newly claimed job. An accepted
manual request still gets one terminal event with its original `runId`.
Manual force runs preserve future cadence; automatic runs use the existing
OpenClaw error/backoff policy. No schema, synthetic receipt, or LobsterAI status
cache is introduced.

There is no corresponding upstream commit yet. Keep this patch version-scoped;
remove it after an equivalent upstream fix passes the bundled admission-failure
regressions, including first failure, failure after success, concurrent owners,
timer/catch-up, and failed persistence.

## Verification

Apply the full patch set to a disposable checkout of the pinned tag with
`node scripts/apply-openclaw-patches.cjs <checkout>` before testing. In that
OpenClaw checkout, use `node scripts/run-vitest.mjs run <test files>` for the
included unit tests. Run
`test/e2e/windows-cron-process-identity.e2e.test.ts` on Windows with the E2E
configuration `test/vitest/vitest.e2e.config.ts`; it starts its own gateway and
state directory and checks the completed job's durable owner identity.
