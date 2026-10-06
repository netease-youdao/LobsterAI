# Share Deployment Persistence

Node service deployments can now opt into lightweight filesystem persistence. The v1 backend implementation uses a shared Volcengine NAS file system mounted into veFaaS through a configured VPC.

## Client Manifest

The desktop client does not expose NAS or VPC concepts to users. During project analysis it marks common local data paths as cloud-saved data:

- `*.db`, `*.sqlite`, `*.sqlite3` files at the project root or one level below it.
- Root-level `data/`, `uploads/`, and `storage/` directories.

When candidates exist, the deployment manifest includes:

```json
{
  "persistence": {
    "enabled": true,
    "provider": "filesystem",
    "quotaBytes": 104857600,
    "bindings": [
      { "appPath": "db.sqlite", "dataPath": "db.sqlite", "kind": "file" },
      { "appPath": "uploads", "dataPath": "uploads", "kind": "directory" }
    ]
  }
}
```

If no candidates exist, the manifest omits `persistence` and the function is deployed without NAS.

## Server Behavior

The server stores persistence on each `share_deployments` version:

- `persistence_enabled`
- `persistence_provider`
- `persistence_mount_path`
- `persistence_remote_root`
- `persistence_bindings_json`
- `persistence_quota_bytes`
- `persistence_used_bytes`
- `persistence_status`

The server validates that all bindings are project-relative and rejects absolute paths, `..`, `.env`, `.git`, and `node_modules`. The default per-deployment quota is 100 MiB.

## Volcengine Configuration

When `persistence_enabled=true`, the veFaaS `CreateFunction` request:

- Enables `VpcConfig` with configured VPC, subnet, and security group IDs.
- Adds `NasStorage.EnableNas=true` and one `NasConfigs` item. The NAS remote path is mounted from `/`; each deployment then writes under `persistence.remote-root/{shareId}` inside the mounted directory.
- Sets `MaxConcurrency=10`, the minimum allowed value for veFaaS non-exclusive web functions.
- Injects `LOBSTER_PERSISTENCE=filesystem`, `LOBSTER_DATA_DIR`, `LOBSTER_PERSISTENCE_REMOTE_ROOT`, `LOBSTER_SHARE_ID`, and `LOBSTER_DEPLOYMENT_ID`.

Relevant server properties:

```yaml
share-deployment:
  persistence:
    enabled: true
    provider: filesystem
    mount-path: /data
    remote-root: /lobster-share-data/{env}/shares
    default-quota-bytes: 104857600
    max-bindings: 8
  volcengine:
    vpc:
      enabled: true
      vpc-id: vpc-1urf4ng1rsow51j8e69oi1gs
      subnet-id: subnet-1c0ddemli7ny85e8j70q0nhd8
      security-group-id: sg-1urf4td53ym851j8e75fkbg4
      shared-internet-access: true
    nas:
      enabled: true
      file-system-id: enas-cnbja0637e792875ce
      mount-point-id: mount-6105be89
      remote-path: /
```

The checked-in profiles separate data roots:

- `local`: `/lobster-share-data/dev/shares`
- `test`: `/lobster-share-data/test/shares`
- `prod`: `/lobster-share-data/prod/shares`

The checked-in profiles use subnet `subnet-1c0ddemli7ny85e8j70q0nhd8` by default. Override `SHARE_DEPLOYMENT_VOLCENGINE_SUBNET_ID` if a target environment moves to a different subnet.

## Runtime Data Handling

The generated `run.sh` copies the immutable code package to `/tmp/lobster-share-runtime-{deploymentId}` as before. It mounts NAS at `/data`, derives the actual data root from `LOBSTER_PERSISTENCE_REMOTE_ROOT`, for example `/data/lobster-share-data/test/shares/{shareId}`, and for each persistence binding it then:

1. Creates the NAS-mounted data directory.
2. Copies the packaged seed file or directory only if the NAS target does not exist.
3. Removes the runtime-local path.
4. Creates a symlink from the app path to the NAS target.

Redeploying code does not overwrite existing NAS data. New seed files are imported only on first creation.

## Migration Policy

Schema-changing app updates should be handled as data migrations, not file overwrites:

- Before migration, back up the NAS share directory.
- For major changes, pull a snapshot of the online data and validate migration locally.
- Run final migration in cloud before routing the new deployment live.
- If migration fails, keep the old deployment active and restore from the backup if data was modified.

## Local API Tests

The server includes gated Volcengine tests:

- `SHARE_DEPLOYMENT_VOLCENGINE_API_TEST=true` runs a real `ListFunctions` API smoke test.
- `SHARE_DEPLOYMENT_PERSISTENCE_CLOUD_INTEGRATION_TEST=true` creates a minimal persistent veFaaS function with NAS/VPC, verifies HTTP access, and deletes it unless `SHARE_DEPLOYMENT_CLOUD_TEST_KEEP_FUNCTION=true`.
- `SHARE_DEPLOYMENT_BROTATO_PERSISTENCE_CLOUD_TEST=true` packages `/Users/admin/lobsterai/project/brotato-clone`, uploads through TOS by default, creates a persistent veFaaS function, writes a leaderboard entry, redeploys a second function with the same share data root, and verifies the second function can read the persisted leaderboard from NAS.

Credentials must be provided through environment variables, not checked into code:

- `SHARE_DEPLOYMENT_VOLCENGINE_CREDENTIAL_JSON`
- or `SHARE_DEPLOYMENT_VOLCENGINE_ACCESS_KEY_ID` and `SHARE_DEPLOYMENT_VOLCENGINE_SECRET_ACCESS_KEY`

The NAS/VPC integration test also requires:

- `SHARE_DEPLOYMENT_VOLCENGINE_VPC_ID`
- `SHARE_DEPLOYMENT_VOLCENGINE_SUBNET_ID`
- `SHARE_DEPLOYMENT_VOLCENGINE_SECURITY_GROUP_ID`
- `SHARE_DEPLOYMENT_VOLCENGINE_NAS_FILE_SYSTEM_ID`
- `SHARE_DEPLOYMENT_VOLCENGINE_NAS_MOUNT_POINT_ID`

Recommended local commands:

```bash
# Real Volcengine OpenAPI smoke test. No cloud resource is created.
SHARE_DEPLOYMENT_VOLCENGINE_API_TEST=true \
SHARE_DEPLOYMENT_VOLCENGINE_CREDENTIAL_JSON='{"accessKeyId":"...","secretAccessKey":"..."}' \
./gradlew test --tests com.youdao.lobsterai.service.sharedeployment.VolcengineVefaasCloudIntegrationTest.listFunctionsThroughVolcengineOpenApiClient --rerun-tasks

# End-to-end NAS functional test with brotato-clone.
SHARE_DEPLOYMENT_BROTATO_PERSISTENCE_CLOUD_TEST=true \
SHARE_DEPLOYMENT_VOLCENGINE_CREDENTIAL_JSON='{"accessKeyId":"...","secretAccessKey":"..."}' \
./gradlew test --tests com.youdao.lobsterai.service.sharedeployment.VolcengineVefaasCloudIntegrationTest.deployBrotatoProjectWithNasPersistenceAndRedeployKeepsLeaderboard --rerun-tasks
```

Use TOS upload for the brotato test unless the package is known to be small enough for direct zip JSON upload. A 6 MiB zip becomes roughly 8 MiB after base64 encoding and may hit OpenAPI request parsing limits.
