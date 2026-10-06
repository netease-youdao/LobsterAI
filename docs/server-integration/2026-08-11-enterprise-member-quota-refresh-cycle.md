# Enterprise member quota refresh-cycle integration

## Change Summary

`/api/enterprise/context` now carries optional quota-period metadata so a cached Team account can refresh exactly when a calendar-month or Monday-to-Sunday quota window ends. Existing quota limits and the legacy exhaustion reason remain compatible.

## Endpoint Details

`GET /api/enterprise/context` adds optional fields under `memberQuota`:

```json
{
  "limit": 5000,
  "used": 1200,
  "reserved": 300,
  "remaining": 3500,
  "refreshCycle": "natural_week",
  "periodStart": "2026-08-10T00:00:00+08:00",
  "periodEndExclusive": "2026-08-17T00:00:00+08:00"
}
```

The endpoint remains JWT Bearer authenticated. Error code `41606` and reason `member_monthly_quota_exhausted` are unchanged for protocol compatibility; the user-facing meaning is “current period quota exhausted.”

## Frontend Action Items

- Completed: shared context types and main-process normalization preserve the optional fields while accepting old responses.
- Completed: the renderer schedules a quota check for `periodEndExclusive`, including long-delay re-arming.
- Completed: a focused window forces a refresh if the boundary passed while the app was asleep.
- Completed: timers validate the account owner and enterprise before applying results and are cleared on logout/destroy.
- Completed: Chinese and English quota-exhaustion copy now says current period rather than monthly.

## Auth Requirements

JWT Bearer access token bound to `accountMode=enterprise` and the selected `enterpriseId`. The boundary callback must never reuse data after account generation or owner key changes.

## Notes & Caveats

- Older servers omit these optional fields; focus/quota-change refresh behavior continues to work.
- The end time is exclusive and includes an explicit `+08:00` offset. Clients must parse it as an instant, not as local wall-clock text.
- Keep recognizing `member_monthly_quota_exhausted` until a separate protocol migration is scheduled.
