# Share Deployment Persistence Recovery

## Change Summary

Persistent Node service deployments now recover a missing per-service NAS directory once and report NAS availability failures separately from general provider failures.

## Endpoint Details

Existing share deployment responses may now return these `failureCode` values:

- `persistence_unavailable`: the NAS mount, network, or temporary persistence manager was unavailable.
- `persistence_invalid`: the service data root was not a valid directory.
- `persistence_data_missing`: cloud data was not present for a read operation.

No request shape or endpoint path changed.

## Frontend Action Items

The Electron client maps `persistence_unavailable` and `persistence_invalid` to localized deployment-status messages. Existing generic provider error handling remains the fallback.

When archive download reports that the cloud data directory does not exist, the client shows its existing empty-data state and does not write the JSON error response as a ZIP file.

## Auth Requirements

Authentication requirements are unchanged. Share deployment APIs continue to require the existing JWT authentication.

## Notes And Caveats

The backend never retries a persistent deployment without NAS. Missing service directories are recreated and initialized from the current local project, but deleted cloud data cannot be recovered. Automatic recovery is limited to one redeployment attempt.
