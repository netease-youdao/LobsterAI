# Sandbox Image Build

This directory contains the VM image build pipeline for Cowork's sandbox mode.
For Chinese documentation, see `README.zh-CN.md`.

## Expected Outputs

- `linux-amd64.qcow2`
- `linux-arm64.qcow2`

Outputs are written to `sandbox/image/out/` by `build.sh`.
The Docker build script runs `build.sh` inside the container.

## Notes

- The image should boot and run the `agentd` service on startup.
- `agentd` must:
  - Mount the host IPC share (tag `ipc`) at `/workspace/ipc`.
  - Mount the host work share (tag from request) at the provided guest path.
  - Watch `/workspace/ipc/requests` and write JSONL event streams to `/workspace/ipc/streams`.
  - Read permission responses from `/workspace/ipc/responses`.

Use the `sandbox/agent-runner` sources as the Node runtime payload inside the VM image.

## Alpine Build Pipeline

The build uses Alpine minirootfs, installs the runtime dependencies (Node, OpenRC,
Linux kernel), and produces a bootable qcow2 image with GRUB.

### Agent Runner Payload

Place the agent runner source under `sandbox/agent-runner`. The build copies it
to `/opt/agent-runner` and (optionally) runs:

- `npm ci --omit=dev`
- `npm run build --if-present`

Update the default entry point in `sandbox/image/overlay/etc/conf.d/agentd` if
your runner uses a different path.

### Build on macOS (Docker)

This uses a Linux container to run the build (Docker Desktop required).

```bash
cd <repo-root>
./scripts/build-sandbox-image-docker.sh
```

If you are on macOS and only need the Windows sandbox image (`linux-amd64.qcow2`), run:

```bash
./scripts/build-sandbox-image-win-on-mac.sh
```

Choose container runtime explicitly:

```bash
./scripts/build-sandbox-image-win-on-mac.sh --tool docker
./scripts/build-sandbox-image-win-on-mac.sh --tool podman
```

Step-by-step:
1. Put the agent runner sources in `sandbox/agent-runner`.
2. If the runner needs a build step, run the Docker build with:
   `AGENT_RUNNER_BUILD=1 ./scripts/build-sandbox-image-docker.sh`
3. Confirm outputs in `sandbox/image/out/`.
4. Optionally run the publish script (see below).

### Build (specific arch)

```bash
ARCHS=amd64 ./scripts/build-sandbox-image-docker.sh
ARCHS=arm64 ./scripts/build-sandbox-image-docker.sh
```

Notes:
- The container runs with `--privileged` to allow `losetup` and `mount`.
- Outputs land in `sandbox/image/out/` on the host.
- The build context ignores `sandbox/image/.work` via `.dockerignore` to avoid
  permission errors from previous root-owned files.

### Architecture Notes

- Apple Silicon can build `arm64` images locally.
- `amd64` images should be built on an x86_64 host (or a CI runner).
  Cross-arch builds are not enabled by default.

### Publish

After building, run the publish script to rename images and generate checksums:

```bash
cd <repo-root>
./scripts/publish-sandbox-image.sh v0.1.5
python scripts/upload-sandbox-image.py --arch all --version v0.1.5
```

This creates a versioned directory under `sandbox/image/publish/` that matches
the CDN layout expected by the app:

```
sandbox/image/publish/v0.1.5/
image-linux-amd64.qcow2
image-linux-arm64.qcow2
SHA256SUMS
upload-manifest.json
```

`upload-sandbox-image.py` will print:

- TypeScript snippet for `src/main/libs/coworkSandboxRuntime.ts`
- Optional environment overrides (`COWORK_SANDBOX_IMAGE_VERSION`, `COWORK_SANDBOX_IMAGE_URL_*`, `COWORK_SANDBOX_IMAGE_SHA256_*`)

### Customization

- `ALPINE_BRANCH` (default `v3.20`)
- `ALPINE_VERSION` (default `3.20.3`)
- `IMAGE_SIZE` (default `4G`)
- `AGENT_RUNNER_BUILD` (`auto`, `1`, or `0`)
