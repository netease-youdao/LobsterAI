# OpenClaw 超大 Transcript 导致 Gateway OOM 与恢复失败修复设计文档

## 1. 问题概述

### 1.1 用户问题

用户在同一个长期任务中继续发送消息时，任务会反复断开，界面显示：

- `AI 引擎连接中断`
- `OpenClaw gateway client is unavailable`

本次故障发生在以下运行环境：

| 项目 | 版本 |
| --- | --- |
| LobsterAI | `2026.7.17` |
| OpenClaw | `v2026.6.1` |
| Node.js | `24.11.1` |

同一 Cowork 会话 `a1049eac-24cb-476e-ae2e-e72cfd7ebbcd` 对应的 OpenClaw transcript 文件持续增长，在 2026-07-22 先后发生四次 Gateway 崩溃：

| 时间 | 模型 | Transcript 大小 | 结果 |
| --- | --- | ---: | --- |
| 10:01 | `gpt-5.5` | 331,809,651 bytes | Node.js heap OOM，Gateway 退出码 134 |
| 10:21 | `kimi-k3` | 332,103,672 bytes | Node.js heap OOM，Gateway 退出码 134 |
| 10:57 | `gpt-5.5` | 332,716,458 bytes | Node.js heap OOM，Gateway 退出码 134 |
| 11:17 | `gpt-5.5` | 332,951,224 bytes | Node.js heap OOM，Gateway 退出码 134 |

Gateway stderr 中存在明确的致命错误：

```text
FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
```

随后 Gateway WebSocket 以 `1006` 异常关闭，Cowork 运行层将它包装成通用的 Gateway 断开错误，因此用户看到的是“AI 引擎连接中断”，而不是导致断开的真实原因。

安装日志显示 OpenClaw 安装和启动均已完成，因此重新安装不是本问题的首要解决方案。四次故障也跨越了不同模型，且都发生在 provider 请求真正发出之前，因此问题不属于单一模型、API 服务商或外部网络故障。

本设计的诊断证据来自用户提供的 `main-2026-07-22.log`、`gateway-2026-07-22.log`、`openclaw-2026-07-22.log` 和 `install-timing.log`。文档只记录故障所需的版本、会话标识、时间、文件大小和错误特征，不复制用户任务正文。

### 1.2 根因

本问题由“逻辑上下文压缩”和“物理 transcript 文件治理”脱节引起，并被恢复链路缺陷放大。

#### 1.2.1 逻辑压缩成功，但物理文件没有缩小

该会话已经发生过 20 次 compaction。日志还显示一次手动压缩将活动上下文从 132 条消息、169,492 tokens 压缩为 1 条消息、4,347 tokens，说明逻辑压缩本身成功。

但是压缩前后的 transcript 文件分别约为 326 MB 和 331 MB。压缩结果被追加到 JSONL 文件中，已经被摘要替代的旧消息仍保留在同一个活动文件内，因此 compaction 没有降低磁盘文件大小。

当前 LobsterAI 生成的 OpenClaw 配置没有设置：

```text
agents.defaults.compaction.truncateAfterCompaction
agents.defaults.compaction.maxActiveTranscriptBytes
```

OpenClaw 已原生支持在压缩成功后创建 successor transcript：新文件仅保留最新压缩摘要和未被摘要覆盖的尾部消息，旧文件归档，并更新 session store 指向新文件。由于上述配置未启用，现有会话始终沿用原 transcript 文件。

日志中的 `forceFlushTranscriptBytes=2MB` 只控制 memory flush，不负责截断或轮转 transcript；而且它受 compaction 周期约束，不能替代物理文件治理。

#### 1.2.2 自动压缩只看 token，无法覆盖“大文件、低 token”场景

当前 preflight compaction 日志显示：

```text
maxActiveTranscriptBytes=undefined
sizeTrigger=false
```

现有 token 阈值约为 976k，而故障会话的活动 token 数约为 80k～245k，因此不会触发 token compaction。大量图片、工具结果、结构化 payload、已经被摘要的历史记录会显著增大 JSONL 文件，却不一定同步增加当前活动 token 数。

因此，“现在已有自动压缩”只能说明活动模型上下文受到控制，不能保证 transcript 文件不会无限增长。

#### 1.2.3 每次运行都会完整读取和解析超大 transcript

OpenClaw 在开始 embedded run 时会通过 `SessionManager.open(params.sessionFile)` 读取 session transcript。当前实现会一次性读取并解析整个 JSONL 文件。

约 333 MB 的 UTF-8 文件在读取、字符串化、逐行解析、构造消息对象和运行时转换过程中会产生多份内存副本。在当前 Gateway `--max-old-space-size=4096` 的限制下，最终耗尽 V8 heap 并以退出码 134 崩溃。

这也解释了为什么故障发生在 `embedded run start` 之后、provider 请求之前，以及为什么切换模型无法解决问题。

#### 1.2.4 Gateway 会重启，但客户端恢复链路不完整

LobsterAI 的 Engine Manager 能在 Gateway 崩溃后自动拉起进程，但本次环境的完整启动耗时约 55～62 秒，其中插件和 provider 加载占用约 39～42 秒。

同时，`openclawRuntimeAdapter` 中的 `gatewayReconnectSuppressed` 是粘性的：调用 `disconnectGatewayClient()` 后会置为 `true`，部分正常任务路径直接调用 `ensureGatewayClientReady()` 建立新连接，但成功握手没有清除该状态。后续再发生意外断开时，日志出现：

```text
GatewayReconnect skipped ... reconnect is suppressed
```

因此 Gateway 进程即使已经重启，WebSocket 客户端也可能继续处于不可用状态，直到新的用户操作重新触发连接。这会把一次明确的运行失败放大为持续的 `gateway client is unavailable`。

### 1.3 根因链路

```text
长期会话持续追加图片、工具结果和历史消息
  → 已执行逻辑 compaction，但活动 JSONL 未轮转
  → transcript 增长到约 333 MB
  → 新一轮任务完整读取、解析 transcript
  → V8 heap 超过 4 GB 限制
  → Gateway OOM，退出码 134，WebSocket 1006 断开
  → UI 显示通用“AI 引擎连接中断”
  → Gateway 自动重启耗时较长，客户端重连又被粘性状态抑制
  → 后续任务继续显示 gateway client unavailable
```

### 1.4 修复目标

1. 从源头限制活动 transcript 的物理大小，使未来长期会话能够持续运行。
2. 对已经存在的超大 transcript 在进入 OpenClaw 完整加载前进行保护，避免再次拖垮整个 Gateway。
3. 在 compaction 后保留必要的摘要和最近上下文，同时归档旧 transcript，不静默删除用户历史。
4. 将 Gateway heap OOM 与普通网络断开区分开，向用户提供可执行的恢复提示。
5. Gateway 自动重启后恢复 WebSocket 客户端，使新任务无需重启 LobsterAI 即可继续使用。
6. 保证崩溃中的原任务不会被自动重发，避免工具调用或外部副作用重复执行。

### 1.5 非目标

本次修复不包括：

- 通过单纯提高 `--max-old-space-size` 掩盖 transcript 无界增长；
- 重写 OpenClaw 的完整 session/transcript 实现；
- 修改模型 context window、token compaction 算法或摘要提示词；
- 自动删除旧 transcript 或用户可见的 Cowork 消息；
- 自动重放因 Gateway 崩溃而中断的运行；
- 对 Cowork 消息列表、SQLite 存储或 Renderer 进行大范围重构；
- 以重装 OpenClaw、切换模型或更换 API 服务商作为正式修复。

## 2. 用户场景

### 2.1 长期任务自动压缩

用户在同一任务中持续对话、上传图片并执行工具。当活动 transcript 达到大小阈值或正常 token compaction 触发时，OpenClaw 在 compaction 成功后自动创建更小的 successor transcript。用户继续在原 LobsterAI 任务中工作，不需要手动新建任务。

### 2.2 手动压缩

用户点击手动压缩。压缩成功后，不仅活动模型上下文减少，session store 指向的物理 transcript 也完成轮转。旧文件被归档，仍可用于排障或未来离线恢复。

### 2.3 打开或继续历史超大任务

用户继续一个已经达到硬保护阈值的旧任务。LobsterAI 在发送运行请求之前检测到风险，不再让 Gateway 完整加载该文件，也不再造成整个 AI 引擎崩溃。

界面应明确说明“该任务历史记录过大，为保护 AI 引擎已停止继续加载”，并提供“在新任务中继续”的恢复路径，而不是只显示网络或 Gateway 断开。

### 2.4 Gateway 因 OOM 意外退出

如果其他未覆盖路径仍引发 OOM，当前运行明确失败且不自动重发；Gateway 自动重启后，客户端重新握手。用户可以发起下一次操作，其他任务也不应长期停留在 `gateway client is unavailable`。

### 2.5 普通任务

对体积较小的任务，不增加额外 transcript 全量读取，不改变模型选择、消息内容、工具权限和正常流式响应行为。

## 3. 功能需求

### 3.1 FR-1：启用 OpenClaw 原生 transcript 轮转

LobsterAI 生成的 managed OpenClaw 配置必须写入：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "truncateAfterCompaction": true,
        "maxActiveTranscriptBytes": "32mb"
      }
    }
  }
}
```

要求：

- 初始软阈值为 32 MiB，必须由 LobsterAI 侧集中常量管理，不散落裸数字；
- 保留 OpenClaw 现有的 token compaction 规则，不覆盖用户有效的 context window 配置；
- 无论 compaction 是 token、文件大小还是手动触发，成功后均执行 successor transcript 轮转；
- 新 transcript 保留最新 compaction summary 和未被摘要覆盖的尾部消息；
- 旧 transcript 归档，不直接删除；
- session store 只有在 successor 文件完整写入后才能切换指向，失败时继续保留原映射。

32 MiB 是首发默认值：它显著低于本次 333 MB OOM 文件，也低于此前约 80 MB 已出现明显加载问题的范围，同时为单个较大的图片或工具 payload 保留空间。上线前必须通过合成 transcript 压测确认该阈值。

### 3.2 FR-2：运行前执行轻量文件大小保护

仅依赖 OpenClaw 的 compaction 不能安全修复已经达到数百 MB 的旧文件，因为首次 compaction/repair 本身也可能完整读取 transcript 并 OOM。

LobsterAI 必须在向 Gateway 发出会加载 transcript 的运行请求前执行本地安全检查：

1. 根据 agent ID、OpenClaw session key 和 session store 定位活动 transcript；
2. 只读取体积较小的 session metadata，并通过 `fs.stat` 获取文件大小；
3. 不读取、不解析 transcript 正文；
4. 将结果分类为正常、需要压缩、硬保护或未知。

首发阈值：

| 文件大小 | 处理方式 |
| --- | --- |
| `< 32 MiB` | 正常运行；仍可按 token 规则 compaction |
| `32 MiB ～ < 64 MiB` | 允许 OpenClaw 执行 size preflight compaction，并要求成功后轮转 |
| `>= 64 MiB` | 在 Gateway 全量加载前阻止运行，进入安全恢复流程 |
| 无法确定 | 不误伤正常任务；记录诊断信息并按现有流程继续 |

硬阈值初始为 64 MiB，必须与软阈值一样使用集中常量，并以二进制字节单位计算。上线压测若无法满足内存目标，只允许降低该阈值，首发值不得高于 64 MiB。

安全检查还必须满足：

- transcript 路径必须位于预期 OpenClaw session 目录内，拒绝目录穿越和越界绝对路径；
- metadata 缺失、文件不存在和文件已轮转要作为可恢复竞态处理；
- 检查应发生在当前运行标记为 active、发送 `chat.send` 或持久化不可重试状态之前；
- 同一 session 的检查、compaction 和发送需要串行化，避免两个并发运行同时轮转。

### 3.3 FR-3：提供超大历史任务的安全继续路径

命中硬保护阈值时，P0 必须做到：

- 不调用会完整加载该 transcript 的 Gateway API；
- 当前输入保留在界面中，或以可重试失败状态保存，不能静默丢失；
- 展示可区分于网络错误的中英文提示；
- 引导用户新建任务继续，原任务保持只读可查看；
- 不删除、不覆盖原 transcript。

P1 应提供“一键在新任务中继续”：

- 使用 LobsterAI 已持久化的 continuity capsule、最近可用的 Cowork 消息和当前用户输入创建干净任务；
- 不通过 Gateway 读取旧 transcript；
- 新任务不得继承旧的 OpenClaw session ID 或 session file；
- 原 Cowork session 与新任务建立来源关联，便于用户返回查看；
- 如果没有可用 capsule，允许仅携带用户当前输入并明确提示历史上下文未完整迁移。

P0 不能依赖 P1 完成才上线；阻止 Gateway OOM 是首要条件。

### 3.4 FR-4：识别并上报 Gateway heap OOM

Engine Manager 必须在当前 Gateway 进程代次内识别以下组合信号：

- stderr 包含 `JavaScript heap out of memory` 或对应 V8 fatal OOM 特征；
- 进程退出码为 134，或进程被异常终止；
- WebSocket 随后出现 `1006` 异常关闭。

要求：

- 使用共享常量定义结构化 Gateway failure kind，不依赖多处字符串比较；
- stderr 实时捕获到 OOM 特征后，应立即记录到当前进程代次，使随后发生的 WebSocket close 能获取真实原因；
- 运行错误中携带 Gateway failure kind，避免被分类为 provider/network failure；
- 用户提示说明“任务历史过大导致本地 AI 引擎内存不足”，并给出新任务继续或等待引擎恢复的动作；
- 日志可记录 session ID、session key、transcriptBytes、退出码、进程代次和恢复阶段，但不得记录 transcript 正文、密钥或用户文件内容；
- 普通退出、人工停止、应用退出和其他崩溃不能误报为 OOM。

提高 Node.js heap 上限只能作为诊断或紧急缓解开关，不得作为验收标准或默认修复。

### 3.5 FR-5：修复 Gateway 客户端自动重连

`gatewayReconnectSuppressed` 不得在一次成功的新连接之后继续抑制未来的意外断线恢复。

要求：

- `onHelloOk` 成功后清除旧连接留下的 reconnect suppression；
- 人工停止、应用退出和显式替换连接期间仍禁止自动重连；
- 意外 close 时，只有当前连接代次可以安排重连，旧连接回调不能干扰新连接；
- Gateway 进程尚未 ready 时按现有退避机制等待，不创建并行连接风暴；
- Engine Manager 自动拉起进程并 ready 后，WebSocket 客户端自动重新握手；
- 当前已经失败的运行保持失败，不自动重新发送用户消息或工具调用；
- 重连成功后，下一次用户操作可以正常工作，无需重启 LobsterAI。

### 3.6 FR-6：恢复阶段的任务状态与提示

Gateway 重启期间：

- 新请求不得直接落入永久性的 `gateway client is unavailable`；
- 如果能在合理等待时间内恢复，应复用已有 readiness 等待机制；
- 超过等待时间时返回“AI 引擎正在恢复”的可重试错误；
- 手动修复/重启操作与自动重启必须去重，不能同时启动两个 Gateway；
- Renderer 中新增或修改的用户可见文案必须同时提供中文和英文 i18n。

### 3.7 FR-7：可观测性

新增诊断日志应覆盖：

- 运行前的 transcript 大小分类和命中阈值；
- compaction 的触发原因：token、size 或 manual；
- successor transcript 创建前后的文件大小；
- 归档文件和 session store 更新是否成功；
- Gateway OOM 的进程代次、退出码和活动运行；
- Gateway restart、ready、WebSocket reconnect 和 hello 成功状态；
- reconnect 被抑制时的明确原因，而不是仅记录布尔值。

高频轮询和每条消息不得写 info 级日志。正常大小检查使用 debug；命中硬保护、轮转失败、OOM 和恢复失败使用 warn/error。

## 4. 实现设计

### 4.1 配置同步

在 `src/main/libs/openclawConfigSync.ts` 的 `agents.defaults` 中写入 managed compaction 配置。

本次优先使用 OpenClaw `v2026.6.1` 已提供的原生字段，不新增 OpenClaw patch。只有在集成测试证明原生 successor transcript 不能满足原子性或 session store 更新要求时，才进入版本化 patch 评审。

配置同步需要保证：

- 合并 managed defaults 时不丢失其他 agent 配置；
- 重复同步具有幂等性；
- Gateway 热加载或重启后配置实际生效；
- 生成配置日志不输出 provider token 等敏感字段。

### 4.2 Transcript 安全检查模块

为避免继续扩大 `openclawRuntimeAdapter.ts`，新增聚焦模块：

```text
src/main/libs/agentEngine/openclawTranscriptSafety.ts
```

建议公开以下纯逻辑或窄接口：

```ts
inspectOpenClawTranscriptSafety(...)
classifyOpenClawTranscriptSize(...)
resolveManagedTranscriptPath(...)
```

模块职责仅包括：

- 解析当前 session metadata；
- 安全解析并校验 transcript 路径；
- `stat` 文件大小；
- 根据集中阈值返回结构化分类；
- 处理文件轮转造成的短暂竞态。

模块不得：

- 读取 transcript 正文；
- 修改 session store；
- 执行 compaction；
- 直接操作 Renderer 状态；
- 自动删除或改名用户历史文件。

Adapter 在 session key 确定后、运行真正开始前调用该模块，并把分类结果映射到正常发送、size preflight 或硬保护流程。

### 4.3 Compaction 与 successor transcript

实际轮转沿用 OpenClaw 原生流程：

1. compaction 成功并生成摘要；
2. 创建临时 successor transcript；
3. 写入最新 compaction entry 和未压缩尾部；
4. flush/close 新文件；
5. 将旧 transcript 归档；
6. 原子更新 session store 指向 successor；
7. 后续运行从 successor 文件加载。

若任一步骤失败：

- 不得留下 session store 指向不存在或半写入文件；
- 不得删除原文件；
- 当前 compaction 返回失败或保持原状态；
- LobsterAI 记录可定位的结构化错误；
- 如果原文件已经超过硬保护阈值，禁止继续尝试普通运行。

### 4.4 OOM 失败分类

在 `src/main/libs/openclawEngineManager.ts` 中维护“当前 Gateway 进程代次”的最近 fatal failure：

```text
generation
failureKind
detectedAt
exitCode
stderrSignature
```

当 stderr 捕获 OOM 特征时立即设置；新进程启动时清空，防止旧 OOM 污染新进程。Adapter 处理 WebSocket close 时读取同一代次的 failure kind，并把它附加到当前 Cowork run error。

错误分类和 Renderer 提示应通过共享常量及现有错误映射链路传递，不在 UI 中解析长段 stderr。

### 4.5 重连状态修复

在 `src/main/libs/agentEngine/openclawRuntimeAdapter.ts` 中保持改动聚焦：

- 新连接 `hello` 成功时重置 reconnect suppression；
- 将 close/reconnect 调度绑定到连接代次；
- 保留显式 disconnect 的抑制语义；
- Gateway 未 ready 时复用已有退避和单飞连接 Promise；
- OOM 后只恢复基础连接，不恢复旧 run。

无需把整个 Gateway 客户端状态机重构为新架构。如果当前布尔值无法安全表达“仅抑制某个连接代次”，可将其收敛为带 generation/reason 的小型状态对象，但不得顺带重构其他 Adapter 职责。

### 4.6 用户恢复入口

P0 复用现有错误展示和新建任务能力，增加专用错误类型及 i18n 文案。

P1 的“一键在新任务中继续”应复用已有 Cowork session/capsule/fork 基础设施；创建新 OpenClaw session，而不是尝试把 333 MB JSONL 重新提交给 Gateway。恢复摘要来源必须是 LobsterAI 本地已持久化数据，不能依赖读取超大 transcript。

## 5. 状态与边界处理

| 场景 | 预期行为 |
| --- | --- |
| Transcript 小于 32 MiB | 正常运行，不增加正文读取 |
| Transcript 达到 32 MiB | size preflight compaction，成功后轮转 |
| Transcript 接近但小于 64 MiB | 仅在压测确认安全的范围内执行 compaction |
| Transcript 达到或超过 64 MiB | 本地阻止运行，不让 Gateway 全量加载 |
| 单条图片或工具结果使文件跨过软阈值 | 下一次运行前触发 size compaction；若直接跨过硬阈值则进入安全恢复 |
| Compaction 成功但 successor 写入失败 | 保留原 session store 和原文件，报告失败 |
| Successor 已写入但 session store 更新失败 | 不切换运行目标；保留可恢复文件并记录错误 |
| 检查后文件被另一运行轮转 | 重新解析一次 metadata，不使用过期路径 |
| Metadata 缺失或无法定位文件 | 不误报超大文件；记录 debug/warn 并沿用现有流程 |
| Gateway OOM | 当前 run 失败，不自动重发；进程与客户端自动恢复 |
| 人工停止 Gateway | 不自动重连，避免与退出流程竞争 |
| 新 Gateway hello 成功后再次意外断开 | suppression 已清除，正常安排重连 |
| 归档文件持续增加 | 本次不自动删除；后续单独设计保留期和用户导出策略 |

## 6. 代码影响范围

预期修改：

- `src/main/libs/openclawConfigSync.ts`
  - 写入 managed compaction 配置。
- `src/main/libs/openclawEngineManager.ts`
  - 记录当前进程代次的 OOM failure kind 和恢复状态。
- `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`
  - 接入运行前 transcript 安全检查，修复 reconnect suppression 生命周期。
- `src/common/coworkErrorClassify.ts` 或现有统一错误分类模块
  - 映射结构化 Gateway OOM 与 transcript oversized 错误。
- `src/main/i18n.ts`、`src/renderer/services/i18n.ts`
  - 增加中英文恢复提示。

建议新增：

- `src/main/libs/agentEngine/openclawTranscriptSafety.ts`
- `src/main/libs/agentEngine/openclawTranscriptSafety.test.ts`

共享 failure kind、阈值和状态 discriminant 应放入已有合适的 `src/shared/*/constants.ts`，或新增领域明确的 constants 文件，不使用重复裸字符串。

本次不直接修改：

- `vendor/openclaw-runtime/` 生成产物；
- 用户机器上的 transcript 文件；
- 相邻 OpenClaw 源码 checkout；
- 现有 4 GB heap 默认值，除非单独的基准测试证明正常 32 MiB transcript 仍无法运行。

## 7. 发布与兼容策略

### 7.1 P0

P0 必须同时包含：

1. managed compaction 配置；
2. 32 MiB 软阈值与 64 MiB 硬保护；
3. 运行前只用 metadata + `stat` 的安全检查；
4. OOM 结构化分类；
5. 成功 hello 后恢复自动重连能力；
6. 超大历史任务的明确提示和手动新任务继续路径。

不能只发布“提高 heap”“增加重试”或“修改错误文案”中的任一项，因为它们都不能阻止同一会话再次崩溃。

### 7.2 P1

P1 增加：

- “一键在新任务中继续”；
- 基于 continuity capsule 的上下文迁移；
- 原任务与新任务的来源关联；
- 归档 transcript 的离线修复、导出或保留期策略。

### 7.3 现有用户数据

- 小于硬阈值的旧 session 在下一次 compaction 后自动进入 successor transcript；
- 大于等于硬阈值的旧 session 不尝试原地完整解析，避免一次“修复动作”再次 OOM；
- 所有旧 Cowork 消息和原 transcript 保留；
- 配置同步应向后兼容没有 compaction 字段的现有安装；
- 如果当前 OpenClaw 版本不识别配置字段，必须在启动验证中暴露，而不是静默假装已启用。

## 8. 测试方案

### 8.1 单元测试

#### 配置同步

- 生成配置包含 `truncateAfterCompaction: true`；
- `maxActiveTranscriptBytes` 为预期值；
- 重复同步结果幂等；
- 不覆盖其他 `agents.defaults` 和 agent 专属配置。

#### Transcript 大小分类

覆盖：

- 31 MiB、32 MiB、63 MiB、64 MiB 边界；
- 文件不存在、metadata 缺失、JSON 损坏；
- 相对路径、合法绝对路径和目录穿越路径；
- metadata 在检查过程中被 successor 更新；
- 全流程只调用 metadata read 和 `stat`，不读取 JSONL 正文。

#### Adapter

- 命中硬保护后不调用 `chat.send` 或其他会加载 transcript 的 API；
- 当前输入不会静默丢失；
- 普通 session 保持原运行流程；
- `disconnect → ensure ready → hello success → unexpected close` 会安排重连；
- 人工 stop/app quit 不安排重连；
- 旧连接的 close 回调不能关闭或重连新连接；
- OOM 后不自动重发旧 run。

#### OOM 分类

- V8 OOM 特征 + 退出码 134 映射为 heap OOM；
- 普通 1006、人工退出、配置错误和插件启动失败不误分类；
- 新 Gateway generation 启动后清除旧 failure kind。

### 8.2 OpenClaw 集成测试

使用当前固定版本 `v2026.6.1` 验证：

1. LobsterAI 生成配置能够被 Gateway 接受；
2. size preflight 能在 32 MiB 阈值触发；
3. 自动和手动 compaction 均创建 successor transcript；
4. session store 指向新文件；
5. 新文件只保留 compaction summary 和必要尾部；
6. 原文件归档且未丢失；
7. 下一轮 run 使用新文件并正常调用 provider。

### 8.3 压力测试

构造 20、32、48、63、64、100、300 MiB 的 transcript，覆盖：

- 大量短文本消息；
- base64 图片和媒体 metadata；
- 大型工具输出；
- 多次 compaction 记录；
- 10,000 条以上 JSONL entry；
- 单条超大 payload。

验收目标：

- 小于硬阈值的 preflight + compaction 在 4 GB heap 限制下完成，峰值内存留有明确安全余量；
- 大于等于硬阈值的文件不被完整读取，Gateway 内存不会因该请求显著增长；
- successor transcript 的大小明显低于原文件，且不包含已被摘要替代的大段历史；
- 连续运行和多次轮转不会让活动文件重新无界增长。

### 8.4 手工验证

在 Windows 打包环境验证：

1. 使用包含图片和工具输出的长期任务触发 size compaction；
2. 确认物理 transcript 轮转和 session store 更新；
3. 使用合成超大历史任务确认 UI 阻止运行且 Gateway 不崩溃；
4. 人工制造 Gateway OOM/异常退出，确认错误文案、自动拉起和 WebSocket 重连；
5. 引擎恢复后新建任务和普通旧任务均可继续使用；
6. 检查日志不包含用户正文和敏感配置。

代码验证至少执行：

```bash
npm test -- openclawTranscriptSafety
npm test -- openclawConfigSync
npm test -- openclawRuntimeAdapter
npm run compile:electron
npx eslint --ext ts,tsx --report-unused-disable-directives --max-warnings 0 <touched-files>
```

## 9. 验收标准

- [ ] LobsterAI 生成的 OpenClaw 配置启用 `truncateAfterCompaction` 和文件大小阈值。
- [ ] 自动、手动和 token compaction 成功后均能轮转活动 transcript。
- [ ] 轮转后 session store 指向有效 successor 文件，旧文件仍被归档保留。
- [ ] 活动 transcript 不再因已经被摘要的历史记录持续无界增长。
- [ ] 大于等于硬阈值的旧 transcript 在运行前被拦截，Gateway 不读取其正文、不发生 OOM。
- [ ] 用户看到的是“历史记录过大/本地引擎内存不足”的可操作提示，而不是误导性的网络错误。
- [ ] OOM 能与普通 WebSocket 断开、provider 错误和人工停止区分。
- [ ] Gateway 崩溃后能自动重启，客户端能自动重新握手。
- [ ] 崩溃中的旧 run 不会被自动重发，工具副作用不会重复执行。
- [ ] 引擎恢复后，用户无需重启 LobsterAI 即可创建或运行其他任务。
- [ ] 普通小型任务的发送、流式响应、模型选择和工具权限无回归。
- [ ] 修复不依赖提高默认 4 GB heap，不要求用户重装或切换模型。
- [ ] 日志包含文件大小、轮转、OOM 和恢复阶段的必要诊断信息，但不包含 transcript 正文。

## 10. 风险与后续项

### 10.1 阈值过低导致频繁 compaction

图片或大型工具输出可能较快触发 32 MiB 阈值。需要通过压测和实际诊断数据评估轮转频率，但不能为降低频率而把首发硬保护提高到 64 MiB 以上。

### 10.2 单条 payload 已超过硬阈值

如果单条图片或工具结果直接让 transcript 超过 64 MiB，普通 compaction 也可能无法安全执行。此时必须进入新任务恢复流程，后续可单独设计大 payload 外置存储或 transcript 引用化方案。

### 10.3 归档文件占用磁盘

轮转会控制活动文件大小，但不会立即降低总磁盘占用。归档文件保留期、导出、清理和用户确认策略应作为独立需求设计，不能在本次修复中静默删除历史。

### 10.4 摘要连续性

Successor transcript 依赖 compaction summary 保持模型上下文。需要结合现有 continuity capsule 验证长期任务质量，但不得因担心摘要质量而继续使用会导致 Gateway OOM 的超大活动文件。

### 10.5 OpenClaw 原生轮转兼容性

当前固定版本已存在相应配置和 successor transcript 实现，但必须以打包 runtime 集成测试为准。如果存在上游缺陷，按 LobsterAI OpenClaw patch policy 提交最小、版本化 patch，并在后续升级 OpenClaw 时重新验证和移除。

## 11. 与既有设计的关系

本方案补齐了 `specs/bugfixes/cowork-oversized-session-safe-load/2026-05-25-cowork-oversized-session-safe-load-design.md` 中明确延后的“compaction 真正降低 transcript 大小、硬阈值保护和离线恢复”部分，并与 `specs/features/cowork-context-compaction/2026-06-09-cowork-context-compaction-quality-optimization-design.md` 的逻辑上下文压缩互补：

- context compaction 负责“模型下一轮看到什么”；
- transcript rotation 负责“活动 JSONL 物理上保留什么”；
- run preflight guard 负责“已有危险文件是否允许进入完整加载”；
- Gateway recovery 负责“引擎崩溃后其他任务能否继续使用”。

四层都生效后，才能从根因上解决本次“已经自动压缩，任务仍反复断开”的问题。
