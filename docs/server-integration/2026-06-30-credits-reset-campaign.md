# Credits Reset Campaign

## Change Summary

`GET /api/user/profile-summary` now includes July credits reset campaign fields. The desktop client can use them to show the account-menu entry and once-per-day floating prompt.

## Endpoint Details

### GET `/api/user/profile-summary`

New fields:

```json
{
  "availableResetCount": 1,
  "availablePromoSubscriptionCount": 0,
  "creditsResetCampaign": {
    "active": true,
    "registeredEligible": true,
    "participated": false,
    "identity": "subscription",
    "availableResetCount": 1,
    "availablePromoSubscriptionCount": 0,
    "endAt": "2026-07-31T23:59:59"
  }
}
```

Subscriber users see `availableResetCount > 0`. Non-subscriber users see `availablePromoSubscriptionCount > 0`.

## Frontend Action Items

Show the account-menu entry and once-per-day floating prompt when either count is positive. Both entry points should open Portal:

```text
/profile?activity=credits_reset
```

After close, suppress the floating prompt for the current user and local date.

## Auth Requirements

Uses existing Electron JWT Bearer auth through the main-process profile-summary IPC.

## Notes & Caveats

The campaign is restricted by server-side registration cutoff, activity window, current entitlement status, and one participation record per campaign. The client should only hide or show UI; all eligibility and participation checks stay server-side.
