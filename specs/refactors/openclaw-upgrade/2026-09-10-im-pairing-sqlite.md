# IM 配对接入 OpenClaw SQLite

## 问题和边界

OpenClaw v2026.8.1 已将 IM 待配对请求及已批准名单保存在共享 SQLite。其启动迁移会处理旧 `credentials/*-pairing.json`、`*-allowFrom.json`，但 LobsterAI 的 `imPairingStore.ts` 此前仍持续读写这些 JSON：新请求不会进入旧文件，界面批准后写出的旧文件也不会成为运行时即时使用的授权数据。

这是一处运行期间的读写接口遗漏。修复后，LobsterAI 不再拥有第二套配对存储，也不再自行删除请求或写入授权名单；首次升级的旧数据导入仍由上游原有迁移 owner 负责。

实现基于 LobsterAI `92d9eca81c6cdb8b2568e9ea6f599466cec15048`，OpenClaw 固定版本源码 `ea806575e6450e4d1efdfc72c19f04be982a1b9b`。

## 实现

1. 列表通过现有 Gateway `channels.pairing.list` 获取。上游默认返回不含人类配对码的请求身份，也不返回授权名单；版本补丁增加可选 `includeCodes`、`includeAllowFrom`，默认响应和 `operator.pairing` 权限不变。
2. LobsterAI 在当前机器人账号内查找用户输入的配对码，只在唯一匹配时，将上游返回的 `channel/accountId/requestId` 交给官方 `channels.pairing.approve` 或 `channels.pairing.dismiss`。不重算请求身份，不复制 SQLite schema，也不改写官方审批事务。
3. 上游事务重新检查请求身份、账号及过期时间，由渠道的配对 adapter 决定实际存储的授权标识。请求在查询后过期或被处理时，向界面返回失败；超时或断线不能被当作操作未执行或成功。
4. 平台 ID 通过共享 `PlatformRegistry` 映射到实际渠道 ID。Telegram、Discord、飞书、QQ、钉钉、POPO、企业微信实例页均传入与配置同步一致的 `instanceId.slice(0, 8)`。企业微信的输入及反馈状态也按账号区分。
5. 网关不可用时明确报错，不回退旧 JSON。批准后移除 `syncOpenClawConfig`；不重启网关、不自动赋予 command owner 身份、不发送配对通知。

无账号过滤的列表仍保留旧 DTO 的 `allowFrom` 展示用并集，同时返回分账号的 `accounts`；这个并集不参与授权判断。

## 测试

- `npm test -- imPairingStore`：平台映射、账号范围、缺失/过期/重复码、异常响应、离线、审批竞态及官方 RPC 参数。
- 上游 `node scripts/run-vitest.mjs src/gateway/server-methods/channel-pairing.test.ts`：默认不泄露配对码、显式请求码和名单、保留既有审批/拒绝行为。
- 显式设置 `OPENCLAW_PAIRING_RUNTIME` 为带补丁的构建产物，再运行 `npm test -- imPairingStore`，启用真实网关集成。只使用临时目录与合成机器人，验证官方插件 API 写入请求、界面 adapter 审批/拒绝、不同账号隔离、过时 JSON 不参与读写、SQLite 与插件授权 reader 一致、重启后数据保留、配置不变。
- 修改文件 ESLint、`npm run build`、`npm run compile:electron`；真实 IM 消息端到端仍需 QA 的测试机器人。

本次包含上游版本补丁，验收须先运行 `npm run electron:dev:openclaw` 更新内置运行时。仅编译 Electron 或启动已有旧运行时不会获得新增的 RPC 字段。

本地已验证：适配层 21 项、上游接口 6 项通过；修改文件 ESLint、OpenClaw 完整 `pnpm build`、`npm run compile:electron` 和 `npm run build` 均通过。启用上述集成测试后，使用新构建的 OpenClaw 和桌面端同一公共 SDK 客户端，完成两次真实 Gateway 启动及全部配对断言（1 项通过，约 93 秒）。测试首次加载模拟渠道的 runtime API 使用独立的较长等待时间；生产配对接口仍使用 10 秒超时。本轮未更新 `vendor/openclaw-runtime/current`，也未使用真实 IM 账号发送消息。

## 已识别的第三方插件限制

以下是当前固定插件版本自身的能力缺口，不能通过更新配对存储接口解决，本次不绕过官方渠道能力检查：

| 插件 | 源码证据 | 影响 |
| --- | --- | --- |
| `@tencent-connect/openclaw-qqbot` 2.0.1 | `src/channel.ts` 未注册 `pairing` adapter；`src/adapter/pairing.ts` 还动态依赖旧 conversation runtime API | 官方管理 RPC 不接受该渠道；需要单独适配 QQ 插件的配对契约，不能据本次通过测试就宣称 QQ 配对可用 |
| `@dingtalk-real-ai/dingtalk-connector` 0.8.26 | 当前包 `dist/message-handler-BUoLSylZ.mjs:1369` 明确将 `dmPolicy="pairing"` 按 `open` 处理 | 插件没有完整实施配对门禁 |
| `moltbot-popo` 2.1.13 | 当前包 `dist/chunk-ACEMKB45.js:834` 的 `checkDmAllowed` 只区分 open/allowlist，其余返回 true | pairing 策略没有实施预期门禁 |

这些限制与“整个网关无法启动”不同；尤其钉钉和 POPO 的 pairing 策略不可作为访问控制保障。渠道真实收发和策略需要单独修复与验收。
