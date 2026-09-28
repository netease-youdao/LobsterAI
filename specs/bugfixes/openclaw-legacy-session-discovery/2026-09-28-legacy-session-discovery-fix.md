# 9.23 表第 2 行：旧会话迁移目录判定不一致

提交基线：`origin/release/2026.9.24`，提交 `c8d30f2a9f0b8381dd3f96374dea7212194cf4b3`。分支：`fix/openclaw-legacy-session-discovery`。

提交前复核发现，同类生产修复已通过 [#2772](https://github.com/netease-youdao/LobsterAI/pull/2772) 合入 release。本分支已更新到该基线，删除重复的生产实现，只补充迁移目录边界、成功/带警告迁移的数据保留、一键修复预检的数据保留测试及验收记录。

## 问题与边界

反馈日志中，Doctor 已返回 `code=0`、`targets=[]`、`issues=0`，宿主却继续报 `OpenClaw doctor completed but 2 legacy session store(s) remain.`。残留位于 `agents/内容创作/sessions/sessions.json` 和 `agents/设计专家/sessions/sessions.json`，重复启动及一键修复都无法解除门禁。

宿主原先枚举所有 Agent 子目录；固定的 OpenClaw v2026.8.1 则通过 `normalizeAgentId()` 和 `shouldSkipDiscoveredAgentDirName()` 排除不可表示的目录名，以及归一化到 `main` 的非 `main` 别名。对应上游文件为 `packages/normalization-core/src/agent-id.ts`、`src/config/sessions/targets-path-validation.ts` 和 `src/config/sessions/targets.ts`。

#2772 已在 LobsterAI 的旧会话扫描中对齐该目录名规则，复用于迁移前检查、迁移后残留检查和一键修复预检。本 PR 沿用该实现，没有改动生产代码、OpenClaw 补丁、退出码判定、归档验证或实际迁移过程。

- `内容创作`、`设计专家` 等 Doctor 不会发现的目录保留原文件，不再阻塞网关，也不被一键修复预检改写或隔离。
- `Worker Space`、`内容-worker` 等可归一化目录仍按**原始磁盘路径**交给 Doctor 迁移。
- `main-` 是有效 ID；`main-内容` 会归一化到 `main`，属于需跳过的别名。测试区分这两种情形。
- 有效目录迁移失败、迁移后仍有残留、归档缺失、未知错误等继续阻塞启动。

这是启动门禁修复，不会把不可表示目录下的历史会话自动归属给主 Agent。原始索引和 JSONL 留在原处，便于后续明确归属后恢复。

## 自动验证

更新到 #2772 后，两个测试文件共 68 项通过。以下编译、构建和改动文件 lint 也在提交基线上重新执行：

```text
npm test -- src/main/libs/openclawSessionLegacyMigration.test.ts src/main/libs/openclawRepairPreflight.test.ts
npm run compile:electron
npm run build
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 src/main/libs/openclawSessionLegacyMigration.test.ts src/main/libs/openclawRepairPreflight.test.ts
```

新增覆盖大小写、下划线、混合中文、超长 ID、归一化到 main 的别名；将已有迁移测试扩展为 code=0/1 两种完成情况，并校验中文目录索引和 JSONL 逐字节不变；补充一键修复不改写或隔离不可发现目录的损坏索引及历史文件。

## Electron 实操环境

Windows、Electron 43.5.0，真实 main/preload/renderer 和固定版本 OpenClaw v2026.8.1。使用现有 `win-x64` 运行时（构建时间 `2026-09-24T05:03:23.089Z`）。

下面的首次完整实操基于 `191aae85dfb4e1f65e8670df5726695a01a5b0cc` 和提交前的等价宿主修复，证明原始故障及迁移/修复全流程。更新到 #2772 后的实际客户端复核单独记录，避免混淆测试版本。

证据目录：`D:/tmp/lobster-legacy-e2e-20260928`。使用独立 `LOBSTERAI_DEV_USER_DATA_DIR`；只复用已有测试账号登录配置，未复制 IM、定时任务或真实用户会话。原反馈只提供日志，因此通过合成会话重建同名目录及故障条件。

通过 renderer CDP 19633 和 main inspector 19634 操作：DOM 按钮、输入框及应用原有 IPC；使用 `Page.captureScreenshot` 留证。没有 computer-use、全局键鼠或模拟网关/模型。测试 bootstrap 仅隔离配置路径并抑制窗口抢焦点。

## 实操记录

| 场景 | 实际结果 | 证据（上述证据目录内） |
| --- | --- | --- |
| 未修复基线启动 | Doctor `code=0`，客户端报两个旧会话库残留，网关 `error` | `01-baseline-failure.png` / `.json`；主日志 14:53:42、14:53:50 |
| 基线界面点击一键修复 | 通用 `doctor --fix --non-interactive` 运行 300 秒后被终止；修复失败。这次实操还遇到了独立于残留检查的诊断阶段失败，不能把它记为会话迁移残留的重复复现 | `02-baseline-repair-failure.png` / `.json`、`baseline-repair-outcome.json` |
| 修复版迁移并启动 | `main` 和 `Worker Space` 两个真实旧库均由 Doctor 导入，`validationBeforeArchive=passed`，无 issues；索引和 JSONL 归档存在；中文目录不计入残留，网关进入 `running` | `03-migration-manifest.json`、`03-migration-verified.json`、`03-fixed-running.png` / `.json` |
| 迁移历史续聊 | 客户端打开旧会话，询问历史暗号，新问题不包含暗号。原生网关日志确认读取到 2 条历史消息，实际模型回复 `LEGACY-HISTORY-KEPT`，会话完成且回复落盘 | `04-native-history-context.log`、`04-migrated-history.png` / `.json` |
| 新建会话 | 在客户端新建任务，实际模型回复 `LEGACY-NEW-OK`，会话完成且回复落盘 | `05-new-session.png` / `.json` |
| 修复版界面启动修复 | 设置 → Agent 引擎 → 开始修复 → 确认；完成真实备份、Doctor、兼容修复和网关启动。界面显示“修复已完成，网关已启动”，最终 `running`。Doctor `code=0` | `fixed-repair-outcome.json`、`06-repair-success.png` / `.json`、备份目录中的 `doctor-result.json` / `preflight-report.json` |
| 显式重启网关 | 调用客户端原有 `restartGateway` IPC，真实网关重建并回到 `running` | `07-gateway-restart.png` / `.json` |
| 整个客户端冷重启后续聊 | 使用主进程真实退出清理流程关闭客户端，重新启动同一隔离 profile；网关 `running`，继续原会话仍回复 `LEGACY-HISTORY-KEPT`。原生上下文日志读取到 4 条历史消息 | `08-cold-history.png` / `.json`、`08-native-history-context.log` |

续聊夹具中的 `claude_session_id` 必须填写完整 OpenClaw session key，不能填写原生 session UUID。首次检查发现夹具填错后已更正并重新执行；上表只计入正确会话键、原生日志 `messages=2` 的成功结果。

原始中文目录的两个索引和两个 JSONL 均逐字节校验 SHA-256。已验证基线修复、正常迁移、历史续聊、修复版一键修复及最终冷启动后未发生变化，见 `preserved-*.json`。

同时读取客户端 SQLite 和 OpenClaw 原生 `transcript_events`，确认两段会话回复和最初导入的历史消息仍存在，见 `after-repair-persistence.json`。`Worker Space` 的原生会话数据库最终由 OpenClaw 放在规范目录 `agents/worker-space/agent`，其中保留 3 条导入事件；宿主仍以原磁盘路径发现和提交旧 JSON 库。

修复版一键修复本次耗时约 9 分钟，通用 Doctor 约 261 秒。该流程最终成功，但本改动没有优化通用 Doctor 耗时或改变其 300 秒超时策略；基线的首次超时单独留证，不据此宣称通用诊断超时问题已修复。

最终检查见 `final-persistence.json` 和 `preserved-final.json`：两段客户端会话为 `completed`，模型回复已保存；主 Agent 和 `worker-space` 的原始导入消息仍在原生 SQLite 中；中文历史文件的 SHA-256 全部一致。验收完成后通过主进程退出流程关闭隔离客户端。

实际构建源码和主进程 bundle 的 SHA-256 记录在 `tested-build.json`，自动验证输出保留为 `tests-fixed.log`、`compile-fixed.log` 和 `build-fixed.log`。

## 提交基线客户端复核

更新到 `c8d30f2a9f0b8381dd3f96374dea7212194cf4b3` 后，重新执行编译、完整构建及上述 68 项测试和 lint，再通过同样的 CDP/主进程调试方式启动真实客户端。生产代码与 release 一致，源码和主进程 bundle 哈希见 `tested-release-build.json`；构建及测试输出见 `compile-release.log`、`build-release.log` 和 `tests-release.log`。

- 冷启动后，日志明确记录忽略 `内容创作`、`设计专家` 两个目录中的旧索引，网关进入 `running`。
- 打开之前实际迁移的会话，只询问历史暗号，模型再次回复 `LEGACY-HISTORY-KEPT` 并完成落盘。原生上下文日志记录 `messages=6`，见 `09-release-native-history-context.log` 和 `09-release-history.png` / `.json`。
- 在客户端新建任务，真实模型回复 `RELEASE-NEW-OK`，会话完成且回复落盘，见 `10-release-new-session.png` / `.json`。
- 调用客户端原有网关重启 IPC 后回到 `running`，见 `11-release-restart.png` / `.json`。重启后原始导入消息仍在原生数据库中，四个中文目录历史文件的 SHA-256 全部不变，见 `release-persistence.json` 和 `preserved-release-final.json`。随后通过主进程退出流程关闭隔离客户端。

本轮复核聚焦更新基线后的启动与会话连续性；旧 JSON 导入和完整一键修复的首次实操及其测试版本在上表单独列明。
