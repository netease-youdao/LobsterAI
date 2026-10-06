# POPO 插件 SDK 加载竞态修复设计文档

## 1. 概述

### 1.1 问题

升级到 OpenClaw `v2026.8.1` 后，QA 反馈 POPO 不再回复消息。日志显示，原本正常运行的 POPO 账号在 Gateway 重启后未恢复监听，插件加载阶段出现以下错误：

```text
ERR_REQUIRE_ESM_RACE_CONDITION: Cannot require() ES Module .../dist/plugin-sdk/channel-status.js because it is not yet fully loaded
```

Gateway 可以继续启动，但 POPO 插件未完成通道注册，各账号无法接收和处理消息。单独出现 `Fabric tools registered` 日志不能证明账号监听器已经启动。

### 1.2 根因

当前固定使用的 `moltbot-popo` 版本为 `2.1.13`。其 `src/openclaw-sdk.ts` 适配层通过私有 `createRequire()` 同步加载 OpenClaw SDK，并在模块求值阶段立即读取 `channel-status`、`reply-history` 等模块中的常量。

当宿主对同一个 SDK 模块的异步 `import()` 尚未完成时，这条同步加载路径会触发 ESM 加载竞态。插件私有的 `createRequire()` 绕过了宿主加载器的转换回退路径。相同条件在 Node `24.15.0` 下表现为 `ERR_INTERNAL_ASSERTION`，在 Electron 内置的 Node `24.19.0` 下表现为日志中的 `ERR_REQUIRE_ESM_RACE_CONDITION`。

修复位置为 POPO 插件的 SDK 适配层，由 LobsterAI 现有的插件打包补丁流程交付。

## 2. 用户场景

1. 用户已经正确配置一个或多个 POPO 账号。应用启动或 Gateway 重启后，各账号应恢复监听，并能够接收和处理后续消息。
2. 用户修改配置导致通道重载后，各账号应重新建立连接，SDK 加载竞态不得导致 POPO 通道缺失。
3. 构建流程复用插件缓存或重复准备运行时时，应稳定生成相同的修复产物。

## 3. 功能需求

- POPO SDK 依赖在插件求值前完成链接，支持冷启动和宿主 SDK 并发加载。
- SDK 保持外部依赖，通过宿主解析器或 LobsterAI SDK 桥接共享模块状态；保留原有常量、函数参数和返回值语义。
- 补丁限定插件版本及适配层结构。发现不支持的版本、边界或公共绑定时，构建应明确失败，避免覆盖未知实现。
- 重复应用补丁应保持幂等，并与已有 Fabric CLI 异步启动补丁兼容。

## 4. 实现方案

### 4.1 替换 SDK 适配层

在 `scripts/openclaw-plugin-patches/popo.cjs` 中增加 `patchPopoSdkImports()`，由现有 `patchPopo()` 入口调用。

处理步骤：

1. 校验 `moltbot-popo` 版本为 `2.1.13`，定位唯一包含 `src/openclaw-sdk.ts` 标记的产物。
2. 使用 `src/openclaw-sdk.ts` 与相邻 `src/stomp-client.ts` 标记确定替换范围。
3. 校验原适配层的 10 个公共绑定及 6 个 SDK 子路径；已与目标内容一致时直接返回。
4. 将适配层替换为静态 ESM 命名导入，保留相邻代码，由宿主加载器处理依赖链接。

涉及的 SDK 子路径为 `core`、`channel-core`、`channel-status`、`channel-reply-pipeline`、`channel-feedback` 和 `reply-history`。插件注册继续采用同步接口，SDK 仍由宿主统一提供。

### 4.2 构建交付与维护

`scripts/ensure-openclaw-plugins.cjs` 在复制固定版本插件后，通过现有插件补丁入口应用修复。发布前需执行目标平台的运行时准备流程，使打包产物包含补丁；已有安装包需要通过包含新运行时的版本更新获得修复。

后续升级 POPO 时，应检查新版本的 SDK 导入方式。如果上游已提供等效修复，在完成加载与通道回归后移除本 SDK 补丁；已有 Fabric CLI 补丁按各自的适用条件维护。

### 4.3 涉及文件

| 文件 | 职责 |
|------|------|
| `scripts/openclaw-plugin-patches/popo.cjs` | SDK 导入替换、版本及结构校验、构建入口接入 |
| `tests/fixtures/moltbot-popo-2.1.13-sdk.txt` | 保留原始 SDK 适配层，复现加载竞态 |
| `tests/openclaw-plugin-patches-popo-sdk.test.ts` | 验证加载行为、宿主状态共享、幂等及异常结构处理 |
| `tests/openclaw-plugin-patches-popo.test.ts` | 更新公共版本校验的错误断言 |

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 运行时未包含 POPO 插件 | 沿用现有逻辑，跳过 POPO 补丁 |
| 插件版本变化 | 构建失败，提示维护者复核补丁 |
| 适配层边界缺失、重复或公共绑定变化 | 拒绝改写该 SDK 文件 |
| SDK 适配层已经修复 | 保持文件内容不变 |
| 产物使用 CRLF 换行 | 正常识别边界，保留相邻源码 |
| 宿主正在异步加载 SDK | 通过静态依赖链接完成加载，并共享宿主 SDK 状态 |

## 6. 验收标准

### 6.1 已完成的本地验证

- 原始适配层能在独立进程复现竞态；修复后冷启动、单个及多个 SDK 并发加载通过。
- 回归测试覆盖宿主模块状态共享、函数参数传递、构建入口、重复应用、CRLF 和不支持的源码结构。
- `npm test -- openclaw-plugin-patches`：30 项通过，其中 POPO 相关测试 17 项。
- `npm test -- openclaw-plugin-sdk-bridge openclaw-im-sdk-compat`：15 项通过。
- 修改的 TypeScript 测试文件通过 ESLint，补丁脚本通过 `node --check`，`npm run compile:electron` 通过。
- 真实插件产物在 Node `24.15.0` 和 Electron 内置 Node `24.19.0` 下的 6 个加载场景通过。
- Windows 隔离 Gateway 配合本地模拟 POPO 服务，5 个账号在冷启动、配置重载、进程重启后均能建立订阅并分发模拟入站消息。

上述模拟验证未覆盖真实 POPO 和模型回复。额外运行的旧 `tests/openclawConfigSync.test.mjs` 有 7 项失败，已在未修改的 `e1f573fa3` 基线上复现；未执行全量测试。

### 6.2 发布前 QA 验收

- [ ] Mac、Windows 新运行时下，真实账号能够接收消息并回复。
- [ ] 多账号及 Discord 同时启用时，冷启动、配置触发的重启后，各 POPO 账号监听正常。
- [ ] 私聊、群聊、配对和媒体收发通过回归。
- [ ] 日志中各账号的监听启动、STOMP 连接及订阅均成功，未出现本次 SDK 加载竞态错误。
