# 2026-07-03 Client Sidebar Banner Carousel

## Change Summary

lobsterai-server adds a public active banner list endpoint for the desktop sidebar ad slot. LobsterAI should rotate multiple active banners and persist manual close state for the whole slot version.

## Endpoint Details

`GET /api/client-banners/active-list?placement=desktop_sidebar`

Auth: public. Response `data` is an array of active banners sorted by backend configuration:

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
      "updatedAt": "2026-07-03T10:00:00"
    }
  ]
}
```

## Frontend Action Items

- Use `active-list` instead of the single-banner `active` endpoint for the sidebar slot.
- Rotate multiple returned banners in place.
- Persist manual close state by placement plus all active banner `id` / `updatedAt` values.
- Do not key close state by user identity or by the currently visible slide.
- Re-show the slot when a banner is added or an existing banner is updated.

## Auth Requirements

No login state is required. Logged-in and logged-out clients should call the endpoint the same way.

## Notes & Caveats

The old `active` endpoint remains available for compatibility but cannot support carousel behavior because it returns only one banner.
