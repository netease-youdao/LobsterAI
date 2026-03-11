# 沙箱镜像构建（macOS + Docker）

本目录包含 Cowork 沙箱模式的 VM 镜像构建流程。

## 产物

- `linux-amd64.qcow2`
- `linux-arm64.qcow2`

产物输出到 `sandbox/image/out/`。Docker 构建脚本会在容器内执行 `build.sh`。

## 说明

- 镜像启动后会运行 `agentd` 服务。
- `agentd` 必须完成：
  - 挂载 host IPC（tag `ipc`）到 `/workspace/ipc`
  - 挂载 host 工作目录（tag 来自请求）到指定 guest 路径
  - 监听 `/workspace/ipc/requests` 并向 `/workspace/ipc/streams` 写 JSONL
  - 从 `/workspace/ipc/responses` 读取权限响应
- 镜像内的 agent runner 来源于 `sandbox/agent-runner`。

## Alpine 构建流程

使用 Alpine minirootfs，安装运行时依赖（Node、OpenRC、Linux kernel），生成可启动的 qcow2 镜像（GRUB 引导）。

## Agent Runner

将 runner 源码放在 `sandbox/agent-runner`。构建时会复制到 `/opt/agent-runner`，并可选执行：

- `npm ci --omit=dev`
- `npm run build --if-present`

如入口不为 `/opt/agent-runner/dist/index.js`，请更新
`sandbox/image/overlay/etc/conf.d/agentd` 中的 `AGENTD_ENTRY`。

## macOS 上构建（Docker）

需要 Docker Desktop。构建示例：

```bash
cd <repo-root>
./scripts/build-sandbox-image-docker.sh
```

如果你在 macOS 上只需要构建 Windows 沙箱使用的镜像（`linux-amd64.qcow2`），可直接执行：

```bash
./scripts/build-sandbox-image-win-on-mac.sh
```

指定容器工具：

```bash
./scripts/build-sandbox-image-win-on-mac.sh --tool docker
./scripts/build-sandbox-image-win-on-mac.sh --tool podman
```

完整步骤：
1. 将 agent runner 源码放到 `sandbox/agent-runner`。
2. 如 runner 需要编译，执行：
   `AGENT_RUNNER_BUILD=1 ./scripts/build-sandbox-image-docker.sh`
3. 在 `sandbox/image/out/` 查看产物。
4. 如需发布，执行下方的发布脚本。

## 指定架构

```bash
ARCHS=amd64 ./scripts/build-sandbox-image-docker.sh
ARCHS=arm64 ./scripts/build-sandbox-image-docker.sh
```

说明：
- Apple Silicon 可直接构建 `arm64`。
- `amd64` 建议在 x86_64 机器或 CI 上构建。

## 发布

构建完成后，执行发布脚本生成 CDN 目录结构和校验文件：

```bash
cd <repo-root>
./scripts/publish-sandbox-image.sh v0.1.5
python scripts/upload-sandbox-image.py --arch all --version v0.1.5
```

会生成：

```
sandbox/image/publish/v0.1.5/
image-linux-amd64.qcow2
image-linux-arm64.qcow2
SHA256SUMS
upload-manifest.json
```

`upload-sandbox-image.py` 会输出：

- `src/main/libs/coworkSandboxRuntime.ts` 需要更新的 TypeScript 片段
- 可选环境变量覆盖（`COWORK_SANDBOX_IMAGE_VERSION`、`COWORK_SANDBOX_IMAGE_URL_*`、`COWORK_SANDBOX_IMAGE_SHA256_*`）

## 可配置项

- `ALPINE_BRANCH`（默认 `v3.20`）
- `ALPINE_VERSION`（默认 `3.20.3`）
- `IMAGE_SIZE`（默认 `4G`）
- `AGENT_RUNNER_BUILD`（`auto`、`1`、`0`）
