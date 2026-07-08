# Static Service Deployment Integration

## Summary

Local service sharing now supports two deployment kinds behind the same client interaction:

- `node_service`: uploaded to `POST /api/share-deployments/node`, deployed as a dynamic Node runtime.
- `static_site`: uploaded to `POST /api/share-deployments/static`, stored as static files and served from the service share host.

The renderer does not need a separate user entry point. The main process decides which endpoint to use after local build output inspection.

## Client Contract

Static deployment upload uses multipart form data:

| Field | Value |
| --- | --- |
| `sessionId` | Cowork session id |
| `artifactId` | local-service artifact id |
| `title` | share title |
| `accessMode` | `code` or `public` |
| `clientSourceKey` | stable key for `static_service_deployment` |
| `sourceSha256` | zip SHA-256 |
| `manifest` | JSON manifest |
| `sourceArchive` | zip containing static output files at archive root |

Manifest example:

```json
{
  "schemaVersion": 1,
  "deploymentKind": "static_site",
  "runtimeLanguage": "static",
  "packageManager": "npm",
  "installCommand": "npm ci",
  "buildCommand": "npm run build",
  "startCommand": "",
  "listenPort": 0,
  "healthPath": "/",
  "entryFile": "index.html",
  "spaFallback": true,
  "projectRootName": "my-app",
  "includedFileCount": 12,
  "estimatedSourceArchiveBytes": 34567,
  "localServiceUrl": "http://localhost:5173/"
}
```

The static zip must contain `index.html` at the root by default:

```text
index.html
assets/app.abc12345.js
assets/app.abc12345.css
favicon.ico
manifest.webmanifest
```

Do not upload `package.json`, lock files, `node_modules`, `.next/standalone`, `.output/server`, `.env*`, or secret-like files in static deployments.

## Response Mapping

Server response still maps to `ShareDeploymentRecord`.

| Response field | Static value |
| --- | --- |
| `deploymentKind` | `static_site` |
| `runtimeLanguage` | `static` |
| `deploymentStatus` | normally `live` after upload |
| `provider` | `nos` |
| `startCommand` | empty |
| `listenPort` | `0` |
| `url` | `https://{shareId}-share-service.{suffix}/` |

## Lookup Compatibility

For `getByLocalService`, the client should check:

1. `static_service_deployment` with the static source key.
2. `node_service_deployment` with the current v3 source key.
3. Existing v2 and legacy Node source keys.

This keeps old dynamic deployment records visible while allowing the next redeploy to move static builds to the static endpoint.

## Quotas

Static deployments count only toward the user's total share limit, the same pool as HTML/image/markdown/mermaid shares. They do not count toward the dynamic Volcengine service deployment limit. Dynamic Node deployments keep the separate active deployment limit of 3 per user.
