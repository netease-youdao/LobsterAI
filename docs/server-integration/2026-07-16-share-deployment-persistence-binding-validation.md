# Share Deployment Persistence Binding Validation

## Change Summary

Node service deployments now reject persistence bindings whose paths are duplicated, nested, or cross-overlapping. This prevents deployment bootstrap scripts from replacing a parent path with a NAS symlink before processing one of its children.

## Endpoint Details

The existing deployment endpoint and request shape are unchanged:

```text
POST /api/share-deployments/node
```

For every pair of different bindings, the server compares `appPath` with `appPath`, `dataPath` with `dataPath`, and both cross-field combinations. Equal paths and parent-child paths are rejected case-insensitively on complete path-segment boundaries.

Example error response:

```json
{
  "code": 4000,
  "message": "Persistence binding paths overlap: binding 1 appPath \"data\" conflicts with binding 2 appPath \"data/app.sqlite\".",
  "data": null
}
```

Validation runs before a share record, source archive, or deployment record is created.

## Frontend Action Items

The Electron client now:

- groups database files below recognized `data`, `uploads`, and `storage` directories into the parent directory binding;
- blocks conflicting manual selections immediately;
- validates the final binding list again before packaging and upload;
- displays a localized instruction to keep only one overlapping location.

## Auth Requirements

Authentication is unchanged. The endpoint continues to use the existing JWT Bearer authentication.

## Notes And Caveats

- A single binding may still use the same value for `appPath` and `dataPath`.
- Similar prefixes that do not share a path boundary, such as `data` and `database`, remain valid.
- Existing live services continue running. An existing overlapping configuration must be adjusted before its next deployment.
- The Provider also rejects overlapping bindings loaded from stored deployment records, so queued legacy records fail closed instead of generating an unsafe startup script.
- Roll out the updated client with or before strict server enforcement where possible; older clients may otherwise receive `code=4000` until the user removes an overlapping location.
