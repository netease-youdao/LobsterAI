# OpenClaw 2026.8.1 Discord 配置导致网关启动失败

## 结论

当前截图中的启动失败由 LobsterAI 生成的 Discord 旧配置字段触发，已在配置同步层修复。
这不是 Windows 专有分支：macOS 截图中的错误路径也指向相同字段。

Windows 日志还暴露了一个独立问题：`openclaw.json.lock` 是长期残留的零字节文件。
已在隔离环境复现它导致配置写入超时，但它不是本次 Discord schema 报错的原因。
本次代码变更不自动清除所有者不明的锁；该机器还需要在所有相关进程退出后，备份残留空锁并复测配置写入。

## 证据与失败链路

输入：

- [PR #2625](https://github.com/netease-youdao/LobsterAI/pull/2625)。此前已改为官方 session SQLite 导入命令，并增加配置锁和旧会话文件诊断。
- [QA 日志包](https://ydschool-video.nosdn.127.net/1788869245354lobsterai-logs-20260908-200605.zip)。以下行号对应解压后的 `main-2026-09-08.log`。
- 当前分支 `feat/openclaw-v2026.8.1`，分析起点 `b0ef93ae2`。
- 本地 runtime：`v2026.8.1`，上游提交 `ea806575e6450e4d1efdfc72c19f04be982a1b9b`，Discord 插件 `@openclaw/discord@2026.8.1`。

19:37—20:04 的六次新增诊断记录中，官方 doctor 均退出为 1。典型记录：

| 日志位置 | 内容 | 含义 |
| --- | --- | --- |
| 142873—142885，19:37:05 | doctor 退出 1；两个 Discord 账户的 `dm` 不允许 `policy`、`allowFrom` | CLI 的配置校验先失败 |
| 149326—149349，20:04:08 | 同样的 schema 错误；JSON 结果为 `cli_error` | 并非已完成会话迁移后才报错 |
| 149385—149409，20:04:12 | 重试约 3.9 秒后失败；17 份旧会话文件的诊断元数据前后完全一致 | 该次尝试没有迁移这些旧会话文件 |
| 149383、149408 | `.lock` 为 0 字节，修改时间为 9 月 7 日 20:45:01，无法读取 PID，`.reclaim` 不存在 | 另有持续存在的无所有者信息锁 |

实际失败链路：

1. 启动先由 `OpenClawConfigSync.sync()` 从本地 IM 设置生成 `openclaw.json`。
2. Discord 账户仍使用旧写法：

   ```json
   { "dm": { "policy": "open", "allowFrom": ["*"] } }
   ```

3. 新版 Discord 发布包的 `openclaw.plugin.json` 中，`channelConfigs.discord.schema` 严格校验 `dm`：只允许 `enabled`、`groupEnabled`、`groupChannels`。
4. `doctor --session-sqlite import --session-sqlite-all-agents --json` 在配置预检阶段退出，LobsterAI 随之阻止网关启动。
5. 原“一键修复”重建配置时仍执行同一段旧字段生成逻辑，因此重试和重建都无法解决。

上游源码的 Discord Zod schema 虽然包含旧字段预处理逻辑，但发布包的 JSON schema 预检会更早拒绝这些字段。
因此验证必须包含实际发布插件与 CLI，不能仅直接调用源码 Zod schema。

## 修复范围

`src/main/libs/openclawConfigSync.ts` 改为在账户层输出：

```json
{ "dmPolicy": "open", "allowFrom": ["*"] }
```

- 先求有效 `dmPolicy`，再生成白名单；旧记录缺省策略时，默认 `open` 也会补上 `*`。
- 显式 `allowlist`、`pairing`、`disabled` 保持原策略；不向限制策略额外加入通配符。
- 配置重写替换所有启用账户的旧字段，停用账户被移除，重复同步保持稳定。
- 账户 ID、名称、token 环境变量索引、guild 设置保持一致。
- 在 `src/main/im/types.ts` 集中定义 `DiscordDmPolicy`，供默认配置、同步逻辑及测试使用。

没有修改上游源码、runtime 产物、会话存储或迁移命令，也没有引入上游补丁。

## 空锁问题与恢复

在相同 runtime 下，向隔离配置旁放置一个修改时间为一天前的零字节 `.lock`：

- 修正 Discord 配置后，官方会话迁移仍能成功。
- 网关 bundle 能启动；健康接口和历史消息 RPC 可以工作。
- `config set logging.level debug` 在约 22—23 秒后报 `file lock timeout`。
- 停止该隔离环境的所有 CLI/网关进程后，将空锁改名备份，再执行相同配置写入，退出码为 0。

上游 `src/infra/stale-lock-file.ts` 与 `src/plugin-sdk/file-lock.test.ts` 明确保留所有者不明的锁。
锁文件是在写入 PID 之前创建的，仅凭文件年龄无法排除暂停中的写入者；本次不把这种保护改成自动删除。
日志也不足以确定是谁、因何留下了最初的零字节锁。

该 QA Windows 机器的恢复步骤：

1. 完全退出 LobsterAI，并确认相关 OpenClaw 网关、doctor 和 CLI 进程均已结束。不要在网关运行或迁移过程中处理锁。
2. 检查 `%APPDATA%\LobsterAI\openclaw\state\openclaw.json.lock`，确认仍是日志中对应的零字节普通文件。
3. 将该文件改名为不冲突的备份名称，例如 `openclaw.json.lock.backup-20260909`。保留备份，不改动 SQLite、旧会话 JSON 或 transcript。
4. 安装包含本次配置修复的新包并启动；确认迁移完成、网关启动正常，随后在 UI 修改一项配置，核对不再出现 `file lock timeout`。

如果锁含有效 PID、内容发生变化或仍有相关进程，应先调查所有者，不能照搬空锁恢复步骤。
现有“一键修复”只备份 `openclaw.json`，不会处理这个独立的 `.lock` 文件。

## 验证

- 修复前：8 个新增/扩展的 Discord 回归用例失败；实际 CLI 重现与 QA 相同的 `additional properties` 错误。
- 修复后：`npm test -- src/main/libs/openclawConfigSync src/main/libs/openclawSessionLegacyMigration src/main/libs/openclawEngineManager`，6 个测试文件、157 项测试全部通过。
- 三个变更 TypeScript 文件的 CI 同等 ESLint 检查通过；`npm run compile:electron` 通过。
- 使用实际 Windows Electron 可执行文件、当前 gateway bundle、发布版 Discord 插件和临时隔离数据目录验证：
  - 用真实 `OpenClawConfigSync` 生成双账户配置；旧格式校验退出 1，重写后退出 0。
  - 官方迁移成功导入并归档 main 与已移除 agent 的两份合成旧会话存储；配置文件内容未被迁移器改写。
  - `/healthz` 返回 HTTP 200；`sessions.list` 保留原 UUID；`chat.history` 返回原历史消息。
  - 空锁写入超时和停机备份后的恢复均已复现。

隔离启动设置 `OPENCLAW_SKIP_CHANNELS=1`，未连接真实 Discord 账户或调用真实模型。
尚需 QA 在 Windows/macOS 原机器使用新包验证完整插件启动、原始历史数据、真实 IM 收发和配置写入。
本次没有生成安装包，也未创建提交。
