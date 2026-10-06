# Client Sidebar Banner Schedule

## Change Summary

lobsterai-server now schedules sidebar banners with second-precision UTC online and offline times and supports an optional minimum client version per banner. LobsterAI persists the latest server-confirmed snapshot, removes expired or incompatible banners locally, and reconciles Admin changes at least every five minutes while active.

## Endpoint Details

`GET /api/client-banners/snapshot?placement=desktop_sidebar&clientVersion=2026.8.26`

Auth: public. The response is not cacheable.

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "serverTime": "2026-08-27T04:00:00Z",
    "nextRefreshAt": "2026-08-27T05:00:00Z",
    "banners": [
      {
        "id": 1,
        "placement": "desktop_sidebar",
        "activityDescription": "活动说明",
        "minClientVersion": "2026.8.26",
        "onlineAt": "2026-08-27T04:00:00",
        "offlineAt": "2026-08-27T05:00:00",
        "linkUrl": "https://example.com",
        "imageUrl": "https://example.com/banner.png",
        "updatedAt": "2026-08-27T03:30:00"
      }
    ]
  }
}
```

`banners` contains only currently effective entries compatible with `clientVersion`. A null or blank `minClientVersion` means all versions are eligible. When a banner has a minimum version, a missing, malformed, or lower `clientVersion` makes that banner ineligible. `nextRefreshAt` is the next compatible enabled online or offline boundary and can be present while `banners` is empty. The legacy `/active` and `/active-list` endpoints remain available and apply the same time-window and version filters.

## Frontend Action Items

- Send the Electron `app.getVersion()` value as `clientVersion` to the snapshot and both legacy endpoints.
- Persist `serverTime`, `nextRefreshAt`, `clientVersion`, the compatible banner list, and the client save time in the SQLite key `client_sidebar_banner.schedule.desktop_sidebar.v2`; do not reuse the v1 cache.
- Apply the same numeric version comparison locally before displaying or persisting a banner, and re-filter a restored cache using the currently running app version so a downgraded client cannot reuse a higher-version result.
- Calculate timer delays from server-relative time, remove a banner locally when `offlineAt` arrives, and then refresh the snapshot.
- Refresh on focus/visibility recovery and every 4.5 to 5 minutes; discard cache older than ten minutes when the server cannot be reached.
- Fall back to `/active-list` when running against a server version without the snapshot endpoint.

## Auth Requirements

No login state or user identity is required.

## Notes & Caveats

An offline client cannot observe an Admin schedule or minimum-version change until connectivity returns. Local expiry is fail-closed: expired, incompatible, or stale cached banners remain hidden even if the boundary refresh fails. The version parameter is a compatibility signal rather than an authorization control.
