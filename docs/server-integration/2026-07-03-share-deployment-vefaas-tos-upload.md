# Share Deployment veFaaS TOS Upload

## Change Summary

lobsterai-server has changed the Volcengine share deployment provider to use server-managed TOS upload by default.

The client-facing API is unchanged. The server still receives the source archive from LobsterAI, builds the deployment zip, uploads that zip to Volcengine TOS internally, and creates the veFaaS function with `SourceType=tos`.

The server no longer automatically falls back to direct zip. `direct_zip` remains an explicit server-side compatibility mode only; `GetCodeUploadAddress` has been removed from the server implementation.

## Endpoint Details

No request or response schema changes are required for LobsterAI.

The client should continue to:

1. Upload the source archive with the existing API.
2. Start deployment with the existing API.
3. Poll deployment status.
4. Display `failureMessage` when deployment fails.
5. Use `runtimeUrl` when deployment succeeds.

The generated server deployment package is now limited by server config. Current default:

```text
30 MiB
```

Example failure text:

```text
Deployment package exceeds configured limit. Package size is 72.45 MiB, configured limit is 30.00 MiB. Reduce production dependencies or static assets before retrying.
```

## Frontend Action Items

No required code change.

Recommended behavior:

- Continue showing the exact server-provided deployment failure message.
- Do not hard-code the limit in client logic unless a server config endpoint is added later.
- Treat TOS upload URLs, buckets, and credentials as server-internal details.

## Auth Requirements

Unchanged. Share deployment APIs continue to use the existing Electron JWT Bearer authentication.

## Notes & Caveats

- The deployment may fail before calling Volcengine if the generated deployment zip exceeds the server limit.
- If the server is missing TOS bucket configuration, deployment fails server-side with a clear provider error.
- A successful deployment should still return the same public share service URL shape.
