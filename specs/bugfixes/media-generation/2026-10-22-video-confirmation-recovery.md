# Recoverable video confirmation and media analytics v3

Date: 2026-10-22
Base: release/2026.10.19, febf529d1

## Behavior

- Video confirmation has a two-minute review window starting when its card is visible in the focused renderer. Queue time and time in another conversation do not start that window.
- Review expiry invalidates approval, retains the original description/references, and offers "Refresh cost and confirm again". Refresh reads the current model catalogue, keeps the selected model and request parameters, and requires another explicit approval.
- A request remains available for at most 30 minutes from creation. Renderer reload and conversation switching recover the live request through the existing pending-questions snapshot. This is in-process recovery: quitting the app, stopping the runtime/tool, losing the callback connection, changing account/server, or the retention limit ends the request without submitting it.
- Renewal has a new revision. Stale/duplicate answers cannot submit. Transport sequence numbers prevent a stale snapshot replacing a newer UI state.
- The plugin confirmation budget is configured separately from its submission timeout. Its AbortSignal closes the HTTP callback when the tool is stopped.
- Image confirmation and ordinary AskUser questions retain their existing behavior.
- No quota preflight or automatic model replacement is introduced.

## Analytics contract

Action remains `lobsterai_media_lifecycle`. `schemaVersion=3` distinguishes this implementation from v2 even when app_version is unchanged. This identifies the event contract/feature, not an exact Git build.

**No new warehouse fields are required.** New local IPC metadata (revision, sequence, expiry) is not sent as new analytics columns.

| Existing field | Meaning |
| --- | --- |
| stage | confirmation, accepted, submit, etc. retain their lifecycle meaning |
| outcome | Additional confirmation values: shown, expired, renewed, refresh_failed |
| failureCode | Closed reasons listed below; no prompts, answer text, URLs or raw responses |
| failureStage | confirmation for confirmation failures; prepare for local model gates; submit for definitive server rejections |
| blockedReason | Numeric server code as server_40204, or a closed local model-gate reason |
| count | For confirmation events only: renewal ordinal, starting at 0 |
| durationMs | Elapsed since the initial confirmation request; join shown/decision for the same mediaJobId and count to measure actual displayed wait |
| schemaVersion | 3 |

Confirmation outcomes:
- requested: once per media job.
- shown: once per review round, after the renderer reports visibility/focus.
- expired: recoverable two-minute expiry, **not** a cancelled/failed generation and not a terminal confirmation.
- renewed: catalogue refresh succeeded; a fresh review is required.
- refresh_failed: refresh failed; request remains expired and retryable (deduplicated within the same round).
- allowed: explicit matching approval; submission may proceed.
- denied: explicit cancellation, skipped or invalid answer.
- failed: missing display route.
- interrupted: stopped tool/connection or invalidated scope.
- timeout: maximum retention elapsed.

failureCode values:
- user_cancelled
- confirmation_expired
- confirmation_timeout
- confirmation_not_displayed (retention elapsed before any display)
- confirmation_no_route
- confirmation_account_changed
- confirmation_interrupted
- confirmation_invalid_answer
- confirmation_skipped
- confirmation_refresh_failed

Existing analytics opt-out/account/server isolation remains authoritative. Events from an invalidated owner/scope may be suppressed rather than attributed to the next account.

Definitive submit rejections retain one accepted/failed event with failureStage=submit and blockedReason=server_<numeric code>. Known quota/subscription codes keep their broad failureCode; other server codes remain unknown but are directly queryable by blockedReason. Uncertain 5xx submissions keep the existing recovery path and are not declared rejected.

Local media selection failures use failureStage=prepare and blockedReason in MEDIA_NOT_ENABLED / WRONG_MEDIA_TYPE / MEDIA_MODEL_UNAVAILABLE.

## Measurement

Deduplicate eventid, correlate by mediajobid, and filter schemaVersion=3 plus production. Compare:
1. Distinct jobs with shown / requested (display coverage).
2. Review rounds with expired / shown (use mediajobid + count).
3. Distinct jobs allowed after any renewed / jobs with expired (recovery).
4. accepted/succeeded jobs / confirmation/allowed jobs (post-confirmation acceptance).
5. Final timeout, denied and failed by failureCode, separately from recoverable expired.
6. Submit rejections by blockedReason.

Do not count every expired event as a lost job: the same job can later renew and succeed. Keep observation-window censoring separate.

Example Hive/Trino inspection (replace dates with the deployed observation window):

```sql
WITH e AS (
  SELECT *, row_number() OVER (PARTITION BY eventid ORDER BY ts) AS rn
  FROM hive.dso.wisdom
  WHERE day BETWEEN '2026-10-22' AND '2026-10-25'
    AND environment = 'production'
    AND action = 'lobsterai_media_lifecycle'
    AND mediatype = 'video'
    AND schemaversion = '3'
)
SELECT stage, outcome, failurecode, failurestage, blockedreason,
       count(*) AS events, count(DISTINCT mediajobid) AS jobs
FROM e WHERE rn = 1
GROUP BY 1, 2, 3, 4, 5
ORDER BY jobs DESC
LIMIT 100;
```
