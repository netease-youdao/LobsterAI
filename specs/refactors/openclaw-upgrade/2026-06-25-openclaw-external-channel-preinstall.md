# OpenClaw 外置 IM 插件预置设计文档

## 1. 概述

### 1.1 问题/动机

OpenClaw 升级到 `v2026.6.1` 后，QQ Bot 和 Discord 的源码仍在 OpenClaw 仓库 `extensions/` 下，但 OpenClaw 的 npm 分发包通过 `package.json` 的 `files` 排除规则移除了：

```text
!dist/extensions/qqbot/**
!dist/extensions/discord/**
```

这代表两者从核心 bundled extension 迁移为 official external channel plugin。LobsterAI 的 embedded runtime 通过 `npm pack` 产物生成，因此打出的安装包不再包含 `dist/extensions/qqbot` 和 `dist/extensions/discord`。

原有 LobsterAI 配置同步仍会写入 `plugins.entries.qqbot` 和 `channels.qqbot`。当 runtime 中没有对应插件时，OpenClaw 会报：

```text
plugins.entries.qqbot: plugin not installed: qqbot
```

用户预期是 QQ/Discord 与其它 IM 一样，启用配置后重启网关即可使用，不应在首次启用时再执行网络下载。

同时，NIM 多实例配置在升级后暴露出配置和环境变量不同步的问题：配置会写入未启用实例或不同索引的 `${LOBSTER_NIM_TOKEN_*}`，但运行时注入的环境变量只覆盖启用实例，导致 NIM 插件启动时报缺失环境变量。

### 1.2 目标

- 将 OpenClaw 6.1 的官方外置 QQ/Discord channel 插件纳入现有 `openclaw.plugins` 构建期预装流程。
- 在构建期把 QQ/Discord 作为 LobsterAI 随包预置的 OpenClaw official external channel plugins 安装到 `third-party-extensions`，而不是恢复到 OpenClaw 核心 `dist/extensions`。
- 运行期用户启用 QQ/Discord 后只需要同步配置和重启 gateway，不触发下载安装流程。
- 让 OpenClaw 配置显式信任这些预置外置插件，避免非 bundled 插件自动加载警告。
- 修复 NIM 配置实例和 secret env var 索引不一致的问题。

## 2. 现状分析

### 2.1 OpenClaw 6.1 的插件分发变化

OpenClaw `v2026.6.1` 保留 `extensions/qqbot` 和 `extensions/discord` 源码，但发布包排除了它们的 `dist/extensions` 产物，并在 official external channel catalog 中声明：

| Channel | Plugin ID | NPM spec |
| --- | --- | --- |
| QQ Bot | `qqbot` | `@openclaw/qqbot` |
| Discord | `discord` | `@openclaw/discord` |

OpenClaw CLI 的标准修复方式是：

```bash
openclaw plugins install @openclaw/qqbot
openclaw plugins install @openclaw/discord
```

LobsterAI 不应把该动作推迟到用户启用 IM 时执行，否则首次启用会依赖网络并增加等待时间。由于现有 `openclaw.plugins` 已经表示 LobsterAI 构建期预装到 `third-party-extensions` 的插件，因此 QQ/Discord 可以直接纳入该清单，复用既有安装、缓存、打包校验和隐藏用户插件列表的逻辑。

### 2.2 LobsterAI 构建链路

当前 runtime 构建链路为：

```text
OpenClaw source -> pnpm build -> npm pack -> extract package -> npm install -> gateway.asar
```

由于 `npm pack` 遵循 OpenClaw 的 `files` 排除规则，QQ/Discord 不会自然进入 `vendor/openclaw-runtime/current/dist/extensions`。

LobsterAI 已有 `ensure-openclaw-plugins.cjs`，会读取 `openclaw.plugins`，用 OpenClaw CLI 在构建期安装插件，并复制到：

```text
vendor/openclaw-runtime/current/third-party-extensions/{pluginId}
```

该机制适合复用。此次使用的是 OpenClaw 官方外置包 `@openclaw/qqbot` 和 `@openclaw/discord`，不是恢复旧的 `@tencent-connect/openclaw-qqbot` 外置包，因此不会回到历史上的旧插件形态。

### 2.3 NIM 配置和环境变量问题

升级后的 NIM 插件会校验配置中的 secret env var。旧逻辑存在两个风险：

- `channels.nim.accounts` 会写入有凭据但未启用的实例。
- `collectSecretEnvVars()` 只按启用且有 `token` 的实例注入 env，和 channel accounts 的实例列表、索引不完全一致。

当账号配置使用 `${LOBSTER_NIM_TOKEN}` 但 env 未注入时，gateway 启动阶段会报缺失环境变量。

## 3. 方案设计

### 3.1 将官方外置 channel 加入现有预装清单

在 `package.json` 的 `openclaw` 下新增：

```json
"plugins": [
  "... existing plugins ...",
  {
    "id": "qqbot",
    "npm": "@openclaw/qqbot",
    "version": "2026.6.1"
  },
  {
    "id": "discord",
    "npm": "@openclaw/discord",
    "version": "2026.6.1"
  }
]
```

两者仍通过 LobsterAI 的构建期插件安装流程进入 `third-party-extensions`，不会被放回 OpenClaw core package 的 `dist/extensions`。

### 3.2 构建期安装

`scripts/ensure-openclaw-plugins.cjs` 继续读取 `openclaw.plugins`。QQ/Discord 走同一套 OpenClaw CLI 安装、缓存、依赖复制和 runtime 写入流程。最终 QQ/Discord 会随安装包存在于：

```text
Resources/cfmind/third-party-extensions/qqbot
Resources/cfmind/third-party-extensions/discord
```

### 3.3 打包校验

`scripts/electron-builder-hooks.cjs` 已经校验 `openclaw.plugins` 中的预装插件目录存在。QQ/Discord 加入该清单后自动纳入校验。如果缺失，打包直接失败并提示重新执行包含 `openclaw:plugins` 的 runtime 构建命令。

### 3.4 OpenClaw 配置同步

`openclawConfigSync.ts` 将 QQ/Discord 纳入受管插件：

- `qqbot` 的启用状态跟随已启用且有 `appId` 的 QQ 实例。
- `discord` 的启用状态跟随已启用且有 `botToken` 的 Discord 实例。
- `plugins.allow` 写入预置插件和已启用用户插件 ID，避免 OpenClaw 把随包外置插件当作未受信任的非 bundled 自动加载。

### 3.5 NIM 配置修复

抽取统一判断：

```text
enabled && (nimToken || (appKey && account && token))
```

`channels.nim.accounts` 和 `collectSecretEnvVars()` 使用同一份启用实例列表。对于完整 `nimToken` 形式不再注入额外 env；对于 `appKey/account/token` 形式，env var 索引和 account 索引保持一致。

## 4. 实施步骤

1. 在 `package.json` 的 `openclaw.plugins` 中新增 `qqbot` 和 `discord`。
2. 复用 `ensure-openclaw-plugins.cjs` 的现有构建期安装流程。
3. 复用 `electron-builder-hooks.cjs` 的现有打包前预装插件校验。
4. 修改 `openclawConfigSync.ts`，生成 `plugins.entries.discord`、修正 QQ 匹配，并写入 `plugins.allow`。
5. 修复 NIM accounts/env var 同步逻辑。
6. 补充 Vitest 覆盖配置输出。

## 5. 涉及文件

- `package.json`
- `src/main/libs/openclawConfigSync.ts`
- `src/main/libs/openclawConfigSync.runtime.test.ts`

## 6. 验证计划

- 运行 `npx vitest run src/main/libs/openclawConfigSync.runtime.test.ts`。
- 运行 touched TypeScript 文件 ESLint：

```bash
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/openclawConfigSync.ts src/main/libs/openclawConfigSync.runtime.test.ts
```

- 运行 Electron main TypeScript 编译：

```bash
npx tsc --project electron-tsconfig.json
```

- 构建 runtime 后检查：

```text
vendor/openclaw-runtime/current/third-party-extensions/qqbot
vendor/openclaw-runtime/current/third-party-extensions/discord
```

- 启用 QQ/Discord 后重启 gateway，确认不再出现 `plugin not installed: qqbot` 或非 bundled 自动加载警告。
