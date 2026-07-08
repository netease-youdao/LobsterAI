# OpenClaw IM 插件升级与安装兼容设计文档

## 1. 概述

### 1.1 问题/动机

LobsterAI 在 OpenClaw `v2026.6.1` 基线上预装多个 IM 相关第三方插件。此次调整目标是升级部分插件到当前可用稳定版本，同时保持微信与 ClawEmail 不变：

| 插件 | 原版本 | 目标版本 | 处理 |
|------|--------|----------|------|
| DingTalk connector | `0.8.16` | `0.8.23` | 升级 |
| Lark/Feishu | `2026.4.8` | `2026.6.10` | 升级 |
| WeCom | `2026.4.22` | `2026.5.25` | 升级 |
| POPO | `2.1.8` | `2.1.13` | 升级 |
| Weixin | `2.4.3` | `2.4.3` | 不改动 |
| ClawEmail | `0.9.12` | `0.9.12` | 不改动 |
| NetEase Bee | `0.1.3` | `0.1.3` | 不升级，但需要安装兼容 |
| NIM channel | git tag `1.1.1` | git tag `1.1.1` | 不升级，仍为 optional |

实际从零安装时暴露出四个和插件安装链路相关的问题：

1. OpenClaw `v2026.6.1` 的 npm 插件安装布局发生变化，新版 CLI 会把 npm 插件放入临时 state 目录的 `npm/projects/.../node_modules/...`，而旧脚本只查找 `extensions/...`，导致“下载成功但被误判为失败”。
2. 新版 npm project 布局下，插件依赖位于 project 级 `node_modules`，例如 `image-size`、`dingtalk-stream` 是插件包目录的 sibling dependency。只复制插件包目录会导致 gateway runtime 加载时缺依赖。
3. OpenClaw CLI 在 LobsterAI 的构建子进程中没有稳定识别 bundled channel 目录，日志出现 `imessage` / `telegram` 的 `missing generated module` warning。Telegram 实际产物存在，但 setup/bundled metadata 扫描路径不确定。
4. `openclaw-netease-bee@0.1.3` npm 包只发布了 TypeScript runtime entry `./index.ts`，没有发布 `index.js` / `dist/index.js` 等编译产物。OpenClaw `v2026.6.1` 对 npm 包安装不再接受 TypeScript runtime fallback，因此从零构建会在 Bee 插件安装阶段失败。

### 1.2 目标

- 完成指定 IM 插件版本升级，不改动微信与 ClawEmail 版本。
- 兼容 OpenClaw 新旧插件安装布局，避免缓存缺失或从零构建时误判安装失败。
- 消除 OpenClaw CLI 安装阶段的 bundled channel 目录探测 warning，避免 Telegram setup 能力被误判。
- 为 Bee 提供 LobsterAI 侧临时兼容方案，直到上游发布带编译产物的新版本。
- 保持插件最终仍通过 `openclaw plugins install` 安装，不绕过 OpenClaw 的 manifest 校验、安全扫描与依赖安装流程。

## 2. 现状分析

### 2.1 OpenClaw 插件安装布局变化

旧版脚本假设 CLI 安装结果位于：

```text
{OPENCLAW_STATE_DIR}/extensions/{pluginId}
```

但 OpenClaw `v2026.6.1` 对 npm 插件会优先创建隔离 npm project：

```text
{OPENCLAW_STATE_DIR}/npm/projects/{projectId}/node_modules/{packageName}
```

这不是某个插件升级包单独引入的问题，而是 OpenClaw CLI 的安装布局变化。插件升级会让本地 `vendor/openclaw-plugins` 缓存失效，从而触发重新下载与新版布局，因此问题在升级时暴露；如果完全清空缓存，即使安装旧版本插件也可能触发同类问题。

### 2.2 本地缓存对问题的遮蔽

`vendor/openclaw-plugins` 和 `vendor/openclaw-runtime` 不进入 git。升级前已有本地缓存时，安装脚本直接复用缓存，不会调用新版 OpenClaw CLI 下载插件，因此不会经过 `npm/projects` 新布局，也就不会触发布局查找失败。

从零构建或插件版本变更后，缓存 miss 才会进入真实下载路径，暴露新版布局兼容问题。

如果在修复安装脚本前已经生成过缺依赖缓存，需要删除 `vendor/openclaw-plugins` 后重新执行安装脚本。该缓存清理属于本地修复动作，不应通过长期 cache schema 升级固化到代码中。

### 2.3 npm project sibling dependencies

在 OpenClaw `v2026.6.1` 的隔离 npm project 中，插件包和它的依赖位于同一个 project 级 `node_modules`：

```text
{OPENCLAW_STATE_DIR}/npm/projects/{projectId}/node_modules/@larksuite/openclaw-lark
{OPENCLAW_STATE_DIR}/npm/projects/{projectId}/node_modules/image-size
```

以及：

```text
{OPENCLAW_STATE_DIR}/npm/projects/{projectId}/node_modules/@dingtalk-real-ai/dingtalk-connector
{OPENCLAW_STATE_DIR}/npm/projects/{projectId}/node_modules/dingtalk-stream
```

因此如果 LobsterAI 只复制插件包目录到：

```text
vendor/openclaw-runtime/current/third-party-extensions/{pluginId}
```

运行时会报：

```text
Cannot find module 'image-size'
Cannot find package 'dingtalk-stream'
```

这不是 Lark 或 DingTalk 插件本身漏声明依赖，而是 LobsterAI 从 staging 复制到 runtime 时丢失了 project 级 sibling dependencies。

### 2.4 bundled channel warning

构建日志中曾出现：

```text
[channels] failed to load bundled channel setup entry imessage: missing generated module for bundled channel imessage
[channels] failed to load bundled channel setup entry telegram: missing generated module for bundled channel telegram
```

复核 runtime 后确认 Telegram 的入口与 setup entry 文件存在：

```text
vendor/openclaw-runtime/current/dist/extensions/telegram/index.js
vendor/openclaw-runtime/current/dist/extensions/telegram/setup-entry.js
```

因此该 warning 不是 Telegram 插件产物缺失，也不代表 Telegram runtime 一定不可用。它反映的是 OpenClaw CLI 子进程未稳定定位 bundled plugins 根目录，可能影响 setup/onboarding/config metadata 扫描，并造成构建日志噪声。

### 2.5 Bee 包发布形态不满足 OpenClaw 6.1 npm 安装要求

`openclaw-netease-bee@0.1.3` 的 npm 包内容包含：

```text
index.ts
src/*.ts
openclaw.plugin.json
package.json
```

但缺少：

```text
index.js
index.mjs
dist/index.js
dist/index.mjs
```

其 `package.json` 中声明：

```json
{
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

OpenClaw `v2026.6.1` 对 npm 包安装要求 runtime entry 指向已编译 JavaScript。TypeScript fallback 只支持源码 checkout 或本地开发路径，不支持 registry npm 包。因此 Bee 当前失败属于插件发布包缺少编译产物，不是 LobsterAI 本地配置错误。

日志中的：

```text
Also not a valid hook pack: Error: package.json missing openclaw.hooks
```

是 OpenClaw CLI 在插件安装失败后尝试按 hook pack 解释同一包产生的附带信息，不是另一个独立根因。

## 3. 方案设计

### 3.1 插件版本升级

在 `package.json` 的 `openclaw.plugins` 中只升级指定插件：

- `@dingtalk-real-ai/dingtalk-connector` -> `0.8.23`
- `@larksuite/openclaw-lark` -> `2026.6.10`
- `@wecom/wecom-openclaw-plugin` -> `2026.5.25`
- `moltbot-popo` -> `2.1.13`

保持以下插件版本不变：

- `@tencent-weixin/openclaw-weixin@2.4.3`
- `@clawemail/email@0.9.12`
- `openclaw-netease-bee@0.1.3`
- `openclaw-nim-channel` git tag `1.1.1`

### 3.2 兼容新旧安装布局

`scripts/ensure-openclaw-plugins.cjs` 不再硬编码只读取 `extensions/{pluginId}`，而是按以下顺序查找实际安装目录：

1. 旧布局精确路径：`extensions/{plugin.id}`。
2. 旧布局扫描：`extensions/*`，按 `openclaw.plugin.json#id` 或 `package.json#name` 匹配。
3. 新布局扫描：`npm/projects/*/node_modules/*`，支持 scoped package，按 manifest id 或 npm 包名匹配。

这样同一脚本可以兼容 OpenClaw 旧版 `extensions` 布局与 `v2026.6.1` 的隔离 npm project 布局。

对于新布局，复制缓存时不能只复制插件包目录，还需要将 project 级 `node_modules` 中除插件自身和 `openclaw` peer 链接以外的依赖复制到插件缓存的 `node_modules` 下，使 runtime 从插件目录解析依赖时仍能命中。

### 3.3 避免复制 OpenClaw host peerDependency

OpenClaw CLI 安装插件时会把插件的 peerDependency `openclaw` 链接到 LobsterAI bundled runtime：

```text
node_modules/openclaw -> vendor/openclaw-runtime/...
```

如果直接 `fs.cpSync` 复制安装目录，Windows 下 junction/symlink 可能导致复制整个 runtime，造成单个插件缓存膨胀到数百 MB。

安装脚本复制插件缓存时需要过滤：

```text
node_modules/openclaw
```

该过滤只移除 host runtime peer 链接，不影响插件自己的真实 dependencies。

### 3.4 固定 bundled plugins 根目录

`runOpenClawCli()` 调用 OpenClaw CLI 时，如果 runtime 中存在：

```text
vendor/openclaw-runtime/current/dist/extensions
```

则注入：

```text
OPENCLAW_BUNDLED_PLUGINS_DIR=vendor/openclaw-runtime/current/dist/extensions
```

这让 OpenClaw CLI 在插件安装期间稳定使用正确的 bundled channel 根目录，避免把 bundled channels 错误解析到不存在 generated module 的位置。

### 3.5 TypeScript runtime entry 临时兼容脚本

Bee 与 NIM 上游包都只提供 TypeScript runtime entry。通用的解包、编译、元数据修正与重打包逻辑位于：

```text
scripts/openclaw-plugin-preparers/typescript-plugin.cjs
```

两个插件分别通过薄包装声明允许处理的 npm 包名：

```text
scripts/openclaw-plugin-preparers/netease-bee.cjs
scripts/openclaw-plugin-preparers/nim-channel.cjs
```

主安装脚本只对 `openclaw-netease-bee` 和 `openclaw-nim-channel` 调用兼容脚本，不自动修改其他第三方插件包。

兼容流程：

1. Bee 通过 `npm pack openclaw-netease-bee@0.1.3` 得到原始 tgz；NIM 从固定 Git ref clone 后执行 `npm pack`。
2. 解压 tgz 到临时目录。
3. 校验包内 `package.json#name`，并读取 `package.json.openclaw.extensions`。
4. 如果 runtime entry 已经是 JavaScript，则不处理。
5. 如果 runtime entry 指向 `.ts`，用 esbuild 编译为 `.mjs`。
6. 更新包内 `package.json`：
   - `openclaw.extensions` 从 `["./index.ts"]` 改为 `["./index.mjs"]`
   - `main` 从 `./index.ts` 改为 `./index.mjs`
   - `files` 增加 `index.mjs`
7. 对修补后的目录重新 `npm pack`。
8. 将修补后的 tgz 交给 `openclaw plugins install`。

该方案保留 OpenClaw CLI 的最终安装、依赖安装与校验职责，只在 CLI 之前补齐上游包缺失的编译产物。

## 4. 实施步骤

1. 修改 `package.json`，升级 DingTalk、Lark/Feishu、WeCom、POPO，保持微信与 ClawEmail 不变。
2. 修改 `scripts/ensure-openclaw-plugins.cjs`：
   - 支持新旧插件安装布局查找。
   - 复制缓存时过滤 `node_modules/openclaw` host peer 链接。
   - 调用 OpenClaw CLI 时注入 `OPENCLAW_BUNDLED_PLUGINS_DIR`。
   - Bee 和 NIM 插件安装前调用对应的预处理包装。
3. 新增通用 TypeScript 插件包准备器，并由 Bee、NIM 薄包装限制允许处理的包名。
4. 新增/补充测试：
   - 旧 `extensions` 布局查找。
   - 新 `npm/projects/.../node_modules` 布局查找。
   - 新 npm project 布局下 sibling dependencies 复制。
   - 复制插件时不复制 OpenClaw host peer 链接。
   - Bee、NIM TypeScript runtime entry 编译与 package metadata 更新。
   - 已经是 JavaScript runtime entry 时不重复处理。
5. 清理本地插件/runtime 缓存后复测从零构建路径。

## 5. 涉及文件

| 文件 | 作用 |
|------|------|
| `package.json` | 更新指定 OpenClaw IM 插件版本 |
| `scripts/ensure-openclaw-plugins.cjs` | 插件安装主流程；兼容新旧布局；设置 bundled plugins 目录；接入 Bee/NIM 预处理 |
| `scripts/openclaw-plugin-preparers/typescript-plugin.cjs` | TypeScript runtime entry 的通用编译、元数据修正和重打包逻辑 |
| `scripts/openclaw-plugin-preparers/netease-bee.cjs` | Bee 包名约束与通用准备器包装 |
| `scripts/openclaw-plugin-preparers/nim-channel.cjs` | NIM 包名约束与通用准备器包装 |
| `tests/ensure-openclaw-plugins.test.ts` | 覆盖安装布局查找与 peer 链接过滤 |
| `tests/prepare-openclaw-netease-bee.test.ts` | 覆盖 Bee 预处理脚本 |
| `tests/prepare-openclaw-nim-channel.test.ts` | 覆盖 NIM 预处理脚本与 scoped 包名校验 |

## 6. 验证计划

### 6.1 静态检查

```bash
node --check scripts/ensure-openclaw-plugins.cjs
node --check scripts/openclaw-plugin-preparers/typescript-plugin.cjs
node --check scripts/openclaw-plugin-preparers/netease-bee.cjs
node --check scripts/openclaw-plugin-preparers/nim-channel.cjs
```

### 6.2 单元测试

```bash
npm test -- ensure-openclaw-plugins prepare-openclaw-netease-bee prepare-openclaw-nim-channel
```

预期：

- 所有安装脚本相关测试通过。
- Bee 与 NIM 编译测试生成 `index.mjs`，并更新 `openclaw.extensions`。

### 6.3 插件安装验证

```bash
npm run openclaw:plugins
```

预期：

- DingTalk、Lark/Feishu、WeCom、POPO 安装目标版本。
- 微信与 ClawEmail 版本保持不变。
- 不再出现 `telegram` / `imessage` 的 bundled channel `missing generated module` warning。
- Bee 安装成功，最终 runtime 中：

```text
third-party-extensions/openclaw-netease-bee/package.json
third-party-extensions/openclaw-netease-bee/index.mjs
```

并且 `package.json.openclaw.extensions` 指向：

```json
["./index.mjs"]
```

- NIM 安装成功，最终 runtime 中包含：

```text
third-party-extensions/openclaw-nim-channel/package.json
third-party-extensions/openclaw-nim-channel/index.mjs
third-party-extensions/openclaw-nim-channel/node_modules/@yxim/nim-bot
```

- Lark 与 DingTalk 的运行时依赖可从插件目录解析：

```text
openclaw-lark/node_modules/image-size
dingtalk-connector/node_modules/dingtalk-stream
```

### 6.4 预编译与构建验证

```bash
npm run openclaw:precompile
npm run build
```

预期：

- `openclaw:precompile` 不因 Bee 的 TypeScript runtime entry 失败。
- `npm run build` 通过。

## 7. 已知限制与后续处理

### 7.1 TypeScript 插件包兼容方案是临时方案

Bee 与 NIM 的根因都是上游包没有发布已编译 runtime JavaScript。LobsterAI 当前方案只用于保证 OpenClaw `v2026.6.1` 从零构建可用。对应上游发布修复版本后，应移除插件包装；没有插件使用通用准备器时，再移除通用实现。

### 7.2 NIM 上游版本元数据不一致

NIM Git tag 为 `1.1.1`，但该 tag 的包内 `package.json#version` 仍为 `1.0.3`；其 npm 包名是 `@nimsuite/openclaw-nim-channel`，manifest id 是 `nimsuite-openclaw-nim-channel`。安装缓存继续使用 LobsterAI 声明的 Git ref 版本，运行时配置继续使用 manifest id，不在临时兼容层内改写上游版本或 manifest id。

### 7.3 POPO suspicious code pattern warning

POPO 安装时可能提示：

```text
Plugin "moltbot-popo" has suspicious code pattern(s)
```

这是 OpenClaw CLI 的安全扫描 warning；当前安装命令使用 `--dangerously-force-unsafe-install` 允许继续安装。该 warning 与本次布局兼容、Bee 编译兼容无直接关系。如需进一步确认，应单独运行 OpenClaw security audit 并评估 POPO 插件内容。
