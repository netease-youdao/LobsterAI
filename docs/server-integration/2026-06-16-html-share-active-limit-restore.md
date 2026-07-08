# HTML Share Active Limit Restore

## Change Summary

`lobsterai-server` now distinguishes HTML shares closed by the active share limit from shares closed by users, admins, moderation, or other system reasons.

When a share was automatically closed because the user's active share count exceeded the configured limit, Electron may update that existing share with `PUT /api/html-shares/{shareId}`. The server updates the content, reopens that share, and closes the oldest other active share to keep the active count within the limit.

Production active share limit is now `100`; test and local profiles remain `10`.

## Endpoint Details

### Lookup Existing Share

```http
GET /api/html-shares/source?sourceType=<type>&clientSourceKey=<key>&includeDisabled=true
Authorization: Bearer <accessToken>
```

Response may include disabled metadata:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "shareId": "shr_xxxxxxxxxxxxxxxx",
    "url": "https://lobsterai.youdaosmart.com/s/shr_xxxxxxxxxxxxxxxx/",
    "accessMode": "code",
    "status": "disabled",
    "disabledAt": "2026-06-16T10:00:00",
    "disabledReason": "active share limit exceeded",
    "disabledSource": "active_limit"
  }
}
```

`disabledSource` values:

| Value | Meaning |
| --- | --- |
| `active_limit` | Closed automatically by active share count enforcement. |
| `user` | Closed by the user. |
| `admin` | Closed by an admin. |
| `moderation` | Closed by content review. |
| `system` | Other system closure. |

### Update Existing Share

```http
PUT /api/html-shares/{shareId}
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

For `status=live`, behavior is unchanged.

For `status=disabled` and `disabledSource=active_limit`, the server updates content and reopens this share. It may return:

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "shareId": "shr_xxxxxxxxxxxxxxxx",
    "url": "https://lobsterai.youdaosmart.com/s/shr_xxxxxxxxxxxxxxxx/",
    "accessMode": "code",
    "status": "live",
    "disabledAt": null,
    "disabledReason": null,
    "disabledSource": null,
    "restoredByUpdate": true
  }
}
```

For user/admin/moderation/system disabled shares, the server returns `HTML_SHARE_FORBIDDEN`.

### Update Share Status

```http
PATCH /api/html-shares/{shareId}/status
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "status": "live" }
```

This endpoint still does not auto-close another share. If the user is already at the active limit, it returns `HTML_SHARE_ACTIVE_LIMIT_EXCEEDED`.

## Frontend Action Items

- Parse and persist `disabledSource` on `HtmlShareResult`.
- Do not block all disabled share updates in the Electron main process. Let the server decide based on the real disabled source.
- In the Artifact share dialog, when `disabledSource === "active_limit"`:
  - Show `此分享因开启数量达到上限被自动关闭`.
  - Enable the update action.
  - Use button text `更新并开启`.
  - Show that updating will reopen this share and automatically close the oldest other active share.
- Keep update disabled for `user`, `admin`, `moderation`, and `system` disabled shares.
- Keep the explicit "open sharing" action mapped to `PATCH /status`; do not make it auto-close other shares.

## Auth Requirements

No auth change. All endpoints require the Electron JWT:

```http
Authorization: Bearer <accessToken>
```

## Notes & Caveats

- New server is backward compatible with old Electron clients, but old clients still cannot use the active-limit restore path because they block disabled updates locally.
- Full user-facing fix requires both the server and Electron updates.
- The active share limit is shared across all HTML share source types; it is not per `sourceType`.
