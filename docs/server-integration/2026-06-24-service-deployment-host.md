# Service Deployment Host Integration

## Change Summary

Node service deployment shares now use a dedicated host instead of the regular HTML share path.

Regular artifact shares still use:

- `http://lobsterai-server-dev.inner.youdao.com/s/{shareId}/`

Service deployment shares now use:

- `http://shr-b25df9ca33df4d5f-share-service.lobsterai-server-dev.inner.youdao.com/`

The backend no longer supports service deployment access through `/s/{shareId}/`.

## Endpoint Details

Existing create, status, redeploy, and detail endpoints remain unchanged. Responses that include the service deployment URL now return the dedicated host URL.

Expected URL shape:

```text
{scheme}://{shareId-with-dashes}-share-service.{serviceHostSuffix}/
```

Example:

```text
http://shr-b25df9ca33df4d5f-share-service.lobsterai-server-dev.inner.youdao.com/
```

The service host handles all paths for the deployed app:

- `/`
- `/index.html`
- `/api/comments`
- `/assets/app.js`

## Frontend Action Items

- Display and copy the `url` returned by the backend as-is.
- Do not derive a service deployment URL from `/s/{shareId}/`.
- Treat service deployment links as full app origins, not artifact preview paths.
- Keep regular HTML/image/markdown/mermaid share handling unchanged.
- Redeploy UI can continue to call the existing redeploy endpoint; the visible link should stay the backend-returned dedicated host URL.
- Treat `expiresAt` as nullable. New service deployments currently do not expire by time, so hide the default expiry text when `expiresAt` is missing/null.
- Service deployment settings should reuse the existing HTML share controls for access mode and open/close sharing:
  - `htmlShare:updateAccessMode` with the deployment `shareId`
  - `htmlShare:updateStatus` with the deployment `shareId`
- Deployment query responses include the current share state fields: `status`, `accessMode`, `shareCode`, `shareCodeUnavailable`, and `disabledSource`.

## Auth Requirements

No auth changes. Electron client deployment APIs still require JWT Bearer auth.

## Notes & Caveats

The dedicated host lets user apps keep root-relative API paths and cookies scoped to their own share host. This avoids collisions with LobsterAI server APIs such as `/api/*`.

Retention policy update: each user keeps at most three active service deployments. When a new deployment becomes live and the limit is exceeded, the backend stops the oldest active deployment for that user.
