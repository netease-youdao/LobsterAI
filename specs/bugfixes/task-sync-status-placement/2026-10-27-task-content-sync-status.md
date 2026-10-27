# 任务内容同步异常：显示位置、任务详情与定向重试

日期：2026-10-27。状态：**客户端代码完成；32 文件/680 项整合回归、严格 lint、编译与实际组件预览通过；安装包和现场验收未执行**。

关联：[metadata 修复](../remote-metadata-projection/2026-10-27-remote-metadata-projection.md)、[availability 接入说明](../../../docs/server-integration/2026-09-23-availability-first-sync.md)、[服务端共享规范](../../../../lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-10-27-remote-metadata-projection.md)。本篇说明用户批准的“设备页轻量汇总，任务详情处理异常”方案，不表示运行中的桌面应用已更新。

## 1. 问题与目标

设备管理当前将“在线 · 同步暂停”“部分会话同步失败”和“重试”紧挨设备展示。它混合连接、内容覆盖、执行状态三个不同事实，用户容易误以为一条工具结果超限会导致整个任务不再同步、手机无法控制或者任务执行失败。需要同时调整信息位置和操作范围，不能只把错误文字换色或藏起来。

成功条件：设备连接状态可独立理解；受影响任务能够定位；用户在任务详情看到适用说明并只重试此任务；异常采样不会增加主进程扫描负担；未经回执确认不显示恢复。

## 2. 变更范围与不变量

业务代码仅涉及 LobsterAI Electron 桌面；服务端仅补充规范/接入文档。Portal、Admin、手机源码、HTTP API、认证协议、MySQL 5.7 schema 均不变。新字段为桌面内部可选扩展。

- 设备“在线”只代表已确认的连接事实，不自动等价于控制通道可用；本轮不新增“远程控制正常”的无证据承诺。
- 内容失败不改写任务执行状态，不关闭远控，不重新执行工具或模型，不删原文、metadata、fault 或 ACK。
- 仅改变提示与定向恢复入口；连接/身份/权限/控制故障仍按原处理流程展示，不能把它们伪装成可忽略的内容异常。
- 保留当前简洁会话 hover：不增加同步明细行，不用“任务失败”表示同步失败。
- 不借本次变更重构大型 App、CoworkSessionDetail 或 RemoteBridge；仅插入小组件/回调，具体逻辑放在独立模块。

## 3. 信息架构与页面行为

### 3.1 设备管理

设备卡只展示名称和连接状态：例如“在线 · 当前设备”。不再拼接“同步暂停”“部分内容未同步”。账号登录、身份、注册额度、设备被移除、控制事实同步故障等已有操作保持可见。

卡片下单独放低强调的内容汇总。正常时不占位；不展示固定配额、百分比或“0 个异常”。推荐文案和行为：

| 证据 | 显示 | 操作 |
| --- | --- | --- |
| 已确认内容 fault | 部分任务内容未同步 | 查看详情，展开受影响任务 |
| 只确认等待/修复，尚不能判定故障 | 部分任务内容等待同步 | 查看已有明细 |
| 当前源版本已 ACK desktop_only | 部分内容需在电脑查看 | 中性说明，不提供恢复重试 |
| 统计读取失败/没有足够证据 | 任务内容同步状态待确认 | 明细不可用时解释稍后查看 |
| 连接/认证/控制故障 | 原连接故障及对应操作 | 连接恢复，不改成任务内容重试 |

已知故障不会因列表截断被改成“正常”或被隐藏。`countsTruncated` 表示计数下界，`taskIssuesTruncated` 表示清单不全；汇总不报未经确认的总数，展开时提示“仅显示部分异常任务，当前明细不代表全部”。已知故障但没有可定位摘要时保留异常汇总并提示明细暂不可用，不能构造虚假的会话目标。

列表最多沿用 20 条摘要；显示任务标题和简短状态，点击进入其“归属与同步详情”。移除这个区域的全局重试和逐行重试按钮。全局重连仅在确有连接需要时保留，不能把它当成单任务修复动作。

### 3.2 对应任务的归属与同步详情

复用现有 OwnershipHost/Modal。来源、空间、执行状态保持原义；新增独立“手机内容同步”区块，与任务执行状态分开。

- 内容 fault：显示“内容同步异常”及固定分类说明，告知其他内容仍可继续同步。仅在已知内容/历史故障时使用该说明。
- desktop_only：显示“部分内容需在电脑查看”，中性色，不提供无效的重试。
- pending：内容待同步；waiting/connection：提示到设备管理检查条件；unknown：明确暂时无法确认，不能渲染已同步。
- 重试资格来自当前任务授权详情。只有 owned、内容 failed、当前入口可重试时展示“重试同步”；有真实重试等待截止时间时显示“重试等待至 {time}”并使用本地化时间；人工冷却不是自动调度时间，不能写“下次自动重试”。未提供则不编造倒计时。
- 点击后禁用重复提交，显示“正在请求重试…”。请求成功只显示“已安排重试，等待同步结果”；已有异常继续存在，直到后台取得新权威证据。
- “查看任务”复用现有会话加载路径；成功且账号未切换才关闭设置并进入任务；失败保留详情，不创建新任务或重跑历史。

### 3.3 任务页与菜单

当前任务标题栏只在 `failed` 且 reason=content/history，或 `partial` 时展示轻量入口。文案分别为“内容同步异常”“部分内容在本机”；点击同一详情面板。正常、pending、unknown 不长期占据标题栏。任务菜单新增“归属与同步详情”，即使全局前 20 条没有该任务，仍可从任务本身进入。

标题栏组件独立封装，既有布局、标题省略、操作按钮和任务执行状态不改。简洁 hover 继续原布局。

### 3.4 远控快捷弹层

保留轻量汇总和设备管理入口，不另建异常列表或重试面板。内容异常使用次要文本/低强调图标；连接、认证、控制故障维持其明确提示。部分内容电脑查看不触发红色全局告警。

## 4. 数据契约与读取安全

`OwnershipDetail` 增加可选 `contentSync`：

```ts
contentSync?: {
  state: 'unknown' | 'failed' | 'partial' | 'pending' | 'synced' | 'local' | 'waiting';
  retryable: boolean;
  reason?: 'content' | 'history' | 'connection' | 'unavailable';
  nextRetryAt?: number; // epoch milliseconds, only when authoritative
};
```

状态/原因统一定义在 shared ownership constants。字段缺失的旧响应仍可显示基本详情，但不能凭聚合失败状态开放任务重试。展示字段不包含原 metadata、正文、路径、异常堆栈、服务端原始错误或凭据。

按任务 ID 取明细，不依赖全局 `taskIssues.find()`。读取前后核验当前账号、scope、环境、设备、同步绑定、目标可见性、admission、删除/关闭状态。切号/切环境、目标删除、迟到采样结果不得污染新面板或授予重试资格。

任务状态采样复用既有只读健康 worker 入口，按任务索引查询；最多缓存 4 个任务，内容状态只用 1 个串行 child，刷新间隔 5 秒、缓存 TTL 15 秒。child 单次截止 5 秒、V8 old-space 96 MiB（不是 RSS 硬上限）、结果 IPC 4 KiB。切换所查看任务不取消另一消费者的作业；账号/环境上下文变化才撤销，等待原 child 退出后再派发。任务关闭后不再续订，过期样本返回 unknown。UI/getDetail 不直接扫描所有消息，不解析 metadata，不新增写数据库的显示路径。任务 overall syncState 和 contentSync 尽量复用同一次后台结果；未知或过期返回等待/未知，而非为了显示绿色同步读取大表。Agent 现有状态流程保持。

任务状态 JSON 的原始读取使用 SQL 字节门禁：repair 4 KiB、历史 manifest 16 KiB、其余既有状态 body 64 KiB；超限或解析失败返回 unknown，不能先将完整大字段搬入 child 再限制。

“内容已同步”仅证明当前本地可展示 message/tool 的源 revision 有对应完整 ACK，且当前内容/历史处理不存在待发或故障证据，不承诺历史每次变更都全文保留。旧消息缺 revision 行按 revision=1 核对，超前 ACK 或未知表示均为 unknown。历史 resolvedSourceSeq 只证明含缺口的处理进度，不能作为全文完整证明。

控制就绪、内容 fault 与覆盖度分别派生：内容 fault 不能变成控制失败；控制未就绪不能被当成任务完整已同步。原 owner/admission 的权威检查不从展示缓存推导。Publisher 的内存控制/内容退避分别映射到 control/live lane，包含根 lane 和任务 lane；根 lane 在退避到期后重试、成功后清除，不能因新提示分层而漏掉实际控制故障。

## 5. 定向重试与并发

1. 打开/刷新目标的授权详情，确认 owned、failed、content/history、retryable。
2. 获取当前远控账号 epoch，确认启用、已登录；缺少 epoch/明细则不发送重试。
3. Task 始终调用既有 `remote.configure({retrySessionId, expectedAccountEpoch})`；不再在摘要清单未命中时回退 `retry:true`。Agent 原全局目录恢复保持原行为。
4. 主进程再次检查当前身份、绑定、准入和实际恢复入口。现有 live/legacy 冷却及服务端退避不改变。
5. 对同一面板防双击；切号、关闭、换任务后的旧响应不能更新新面板。请求未完成不清 fault，不修改封存请求或来源版本。
6. 恢复被拒绝/本地依赖不可用/账号变化时显示对应等待或固定错误，不显示“已安排”。成功后刷新详情，依据实际 ACK 更新状态。

## 6. 主题与无障碍

复用当前主题的 text-primary/foreground、text-secondary、border、surface、primary/hover 类及既有 Modal/按钮。正文采用项目默认字号，汇总/辅助信息用现有 text-xs；图标 14–16px，行间距和区块间距沿用当前 4/8/12/16/24px 体系。不新建字体或硬编码浅色背景，不改变设置页主标题。

内容异常低强调；颜色之外必须有文字。折叠入口有明确名称与展开状态；任务行、详情、关闭和重试均可键盘操作；焦点按原 Modal 返回。动态重试反馈用 polite live region。无权重试时不出现可触发的假按钮。

## 7. 实施顺序及验收矩阵

实施顺序：共享状态及按 ID 后台读取 → 定向重试与迟到响应保护 → 设备汇总与详情入口 → 任务详情/标题栏/菜单及导航 → 文案、定向测试、编译、实际组件预览。

| 编号 | 验收场景 | 预期 |
| --- | --- | --- |
| S01 | 正常连接与全部完整同步 | 设备子行只显示连接，内容异常区不占位 |
| S02 | 单任务 metadata/live fault，设备仍在线 | 轻量内容摘要；不写设备离线/控制不可用/任务执行失败 |
| S03 | desktop_only 当前 ACK | 中性部分内容提示，无错误重试；旧 ACK 仍 pending |
| S04 | 控制故障与内容故障并存 | 控制问题保留；不以内容降级提示覆盖控制问题 |
| S05 | 无摘要、截断、未知统计 | 不显示0异常、不把缺失目标当正常、不捏造详情 |
| S06 | 目标在全局20条之外 | 按ID仍能获取准确详情，重试只触发该目标 |
| S07 | 非当前账号/环境/设备、未准入、已删除关闭 | 无数据泄露、无重试授权，迟到结果失效 |
| S08 | 连续点击、重试拒绝、返回前换号/面板 | 单次请求，无假调度成功，无新面板污染 |
| S09 | ACK前/后、失败保留 | 调度只显示等待；确认后才更新/隐藏异常 |
| S10 | header/menu/hover | 异常入口可达，正常隐藏，简洁hover不变 |
| S11 | 查看任务加载失败/换账号 | 失败保留详情，不切错任务，不执行任务 |
| S12 | 状态采样大数据或存储失败 | 背景worker有界，主进程不新增全表扫描，未知不假成功 |
| S13 | 深浅主题、长标题、键盘与设置叠层 | 无遮挡、字号间距一致、可聚焦和返回 |

## 8. 验证与交付记录

### 8.1 实施文件

- 主进程/共享：`src/shared/ownership/{constants,types}.ts`、`ownershipAssociation.ts`、`main.ts`，新增 `remoteOwnershipContentSync.ts` 与 `remoteOwnershipContentCache.ts`；Bridge 使用后台快照，既有 DisplayHealth worker 增加按任务分支；Publisher/Bridge 区分 control/live 退避。
- 页面：`RemoteDeviceSettings`、`RemoteControlPopover`、`OwnershipDetailContent/Host/MenuItems`、新增 `OwnershipTaskSyncButton`；`CoworkSessionDetail` 只接入轻量按钮，compact hover 不变。
- 行为：`ownership.ts` 按任务重试并防重复/迟到响应；`App.tsx`/`cowork.ts` 在查看任务时校验账号和面板序列；中英文文案与对应回归用例已补齐。
- 文档：本篇、metadata 修复 Spec、桌面 availability 接入说明，以及服务端共享 Spec/接入文档的提示分层补充。服务端业务代码、API/DDL、Portal、Admin、手机源码未变。

### 8.2 执行结果（Node.js 24.17.0）

| 验证 | 结果与范围 |
| --- | --- |
| 整合回归 | 32 文件 **680/680**；覆盖本篇 S01–S12 的状态、权限、定向重试、并发、只读采样与前序 metadata 恢复回归。是同一批测试的总数，不与前序 564 项或子任务测试数相加 |
| 严格 ESLint | 本轮及已有相关修改共 50 个 TS/TSX 文件通过；`--ext ts,tsx --report-unused-disable-directives --max-warnings 0` |
| 编译/类型 | `npm run compile:electron` 与 `tsc --noEmit -p tsconfig.json` 通过 |
| 真实 child | 临时磁盘 SQLite、真实受监控 child、只读源文件字节不变、作业退出后释放槽、无主线程同步 fallback；现有响应性回归与新 task 分支测试均通过 |
| 实际组件预览 | 引用真实组件和原 CSS/renderer 服务，模拟 IPC；浅色中文与 360×780 深色英文通过：折叠/展开、详情、重试等待禁用、调度后故障保留、人工冷却、partial/unknown、Escape、查看任务 callback |
| 仓库检查 | 两仓库 `git diff --check` 通过；新跨仓库文档链接存在 |

整合命令为 `vitest run <32-file list> --maxWorkers=2 --reporter=json --outputFile=/tmp/lobsterai-content-status-results.json`。完整参数保存于 `/tmp/lobsterai-content-status-test-command.json`，文件清单保存于 `/tmp/lobsterai-content-status-checks.json`。结果与日志：`/tmp/lobsterai-content-status-{results.json,tests.log,lint.log,electron.log,renderer.log}`。

第一次整合运行与静态检查并行时，既有 `remoteLiveProjectionJob.test.ts` 的 100ms 子进程用例发生 1 次预算超时（679/680）；隔离复跑及降低并发的完整复跑均通过，未放宽用例或生产预算。首次结果保留在 `/tmp/lobsterai-content-status-initial-results.json`，隔离日志为 `/tmp/lobsterai-content-status-encoder-recheck.log`。前序 metadata 扩展测试的 8 项既有基线失败不属于本轮 32 文件，未重新执行；说明保留在对应旧 Spec。

预览源码和记录均在仓库外 `/tmp/lobsterai-content-sync-ui/`，记录为 `verification.json`；截图包括 `light-cooldown-detail.jpg`、`dark-narrow-failed-detail.jpg`、`dark-narrow-partial-detail.jpg`。预览服务器与临时标签已关闭，未重启用户应用。

### 8.3 尚未执行

未构建/安装安装包，未在运行中的 Electron 完整应用壳验收，未验证现场账号实际 ACK 恢复或手机真机。预览只挂载真实任务页头入口组件，未挂载完整 `CoworkSessionDetail`。服务端本轮仅文档修改，按仓库约定未执行服务端测试或数据库操作。上述源码和模拟 IPC 验证不代表截图对应运行版本已经恢复。

