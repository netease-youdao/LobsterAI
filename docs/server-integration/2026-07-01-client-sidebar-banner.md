# 2026-07-01 Client Sidebar Banner

## Change Summary

lobsterai-server exposes public client banner endpoints for the desktop sidebar invitation ad. As of 2026-07-03, the desktop client should use the list endpoint and rotate multiple active banners in the left-bottom sidebar slot.

## Endpoint Details

`GET /api/client-banners/active?placement=desktop_sidebar`

Returns one active banner, selected by backend weight. Kept for compatibility.

`GET /api/client-banners/active-list?placement=desktop_sidebar`

Returns every active banner for the placement. Auth: public. Do not send user identity just for this banner request; login status and invitation history must not affect whether banners are returned.

Response:

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "id": 1,
      "placement": "desktop_sidebar",
      "activityDescription": "邀请好友赚积分",
      "weight": 1,
      "status": 1,
      "linkUrl": "https://lobsterai.youdao.com/portal#/invitation",
      "imageUrl": "https://nos.example.com/banner.png",
      "imageWidth": 800,
      "imageHeight": 250,
      "updatedAt": "2026-07-01T10:00:00"
    }
  ]
}
```

For `active-list`, `data` is an empty array when no active configured banner should be shown for the placement.

## Frontend Action Items

- Fetch active banners for `desktop_sidebar` from `active-list`.
- Display it above the sidebar account/settings row.
- If multiple banners are returned, rotate them in the same sidebar slot.
- Store close state in the client SQLite `kv` store by the current sidebar slot version: placement plus every active banner id and `updatedAt`; do not include user identity in the key.
- Show by default and hide that sidebar slot version permanently after the user manually clicks close.
- When any active banner is added or updated, the sidebar slot version changes and the client should show the slot again.

## Auth Requirements

Anonymous calls are allowed. Logged-in clients should call the endpoint the same way as anonymous clients.

## Notes & Caveats

The sidebar slot should render with each banner's returned `imageWidth` / `imageHeight` ratio. The recommended image source size is `800x250`; SVG is not supported for this rollout.
