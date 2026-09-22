# OpenClaw 浏览器 DNS 异常导致网关退出修复设计

## 1. 概述

### 1.1 问题

浏览器工具执行 `navigate` 时，页面文档请求的 DNS 解析可能返回 `ENOTFOUND`。
OpenClaw 未接收导航拦截回调的 rejection，导致网关以 code 1 退出；LobsterAI 随后
执行自动重启。网关中的其他任务及 IM 连接也因此中断。网络请求失败应限制在受影响的
浏览器操作内，不应结束承载所有任务的网关进程。

本设计基于 `release/2026.9.16` 的
`5273b844767c1b9757cee7b5a4fe78fd9adba9a3`，固定 OpenClaw `v2026.8.1`。
本次保留该版本，以三个职责独立的版本补丁修复；不同时升级整个 OpenClaw。

调查确认故障使用的是 `profile=openclaw` 的外置托管 Chrome。本文只保留去标识化的
故障特征和可重现的合成场景，不收录用户日志、访问地址、身份或文档链接。

### 1.2 根因

两个缺陷叠加产生本次退出：

1. `extensions/browser/src/browser/pw-session-navigation.ts` 中的
   `gotoPageWithNavigationGuard()` 为 `page.route()` 注册异步回调。该回调只捕获
   策略拒绝，普通 DNS 错误直接抛出。回调由 Playwright 事件链调用，不属于外层正在
   `await` 的 `page.goto()` Promise，所以导航调用者的 `try/catch` 收不到该失败，
   被拦截的请求也没有及时结束。
2. `src/cli/run-main.ts` 的 gateway fast path 在安装全局 rejection 处理器之前
   开始运行。现有处理器本来会把 `ENOTFOUND` 等网络错误归类为非致命错误，但该
   启动路径漏装处理器，导致上述 rejection 按 Node 默认行为终止网关。

自动重启是退出后的恢复动作，不是最初触发点。现场日志没有应用层调用栈，不能据此
确定触发请求是顶层文档、重定向还是子 frame，也不能确定 DNS 失败的外部原因。
修复不依赖某个真实域名，普通网络失败本就应被接收并返回。

另一个相关但独立的缺陷位于 CDP message dispatch：回调可能返回 rejected Promise，
同步 `try/catch` 无法接收。此次单独回移其上游修复，避免浏览器 target 或 CDP 故障
经另一条链路终止网关；它不能代替导航请求生命周期修复。

### 1.3 已完成的调查验证与限制

修复前，使用当前捆绑模块的原始导航函数、Playwright 1.62.1、Node 24.15.0 和独立
headless Chrome，访问仅监听 loopback 的本地 HTTP 服务。失败页面嵌入一个指向
保留测试域名 `lobster-row6-dns-probe.invalid` 的 iframe。未替换产品导航函数、
Playwright 或 DNS 实现，未连接个人浏览器 profile。

| 修复前的对照条件 | 实际结果 |
| --- | --- |
| 正常本地页面 | 导航成功，独立测试进程 exit 0。 |
| 本地页面包含 DNS 失败 iframe，未安装全局处理器 | 出现 `node:internal/dns/promises` / `ENOTFOUND`，独立进程 exit 1，外层导航 catch 未返回。 |
| 同一页面，预先安装该版本 OpenClaw 自带的全局处理器 | 进程存活并记录非致命 rejection，但导航仍在 5 秒后超时。 |

这证明只恢复全局兜底不能解决悬挂的导航请求。该结果是修复前的真实浏览器隔离实验，
不是修复后回归结果，也不是打包应用、真实用户任务或 IM 的端到端验证。

## 2. 用户场景与影响范围

### 2.1 用户场景

| 场景 | 修复后的预期 |
| --- | --- |
| 顶层文档或顶层重定向遇到 DNS 失败 | 当前 browser 操作及时返回有原因的网络错误，网关和其他任务继续运行。 |
| 有效主页面中的子 frame 在导航安全检查内遇到已知 transient network 错误，如 DNS 失败 | 中止该 frame 请求，允许有效主文档继续加载及后续操作。 |
| 被安全策略拒绝的导航 | 继续阻止请求，保留顶层拒绝的目标隔离和关闭语义，不把安全失败改成网络成功。 |
| 页面关闭、导航超时后 DNS 才返回 | 过期回调不再继续导航，不产生晚到的未处理 rejection。 |
| 浏览器 target/CDP 消息分发失败 | 接收同步或异步失败并关闭受影响的连接，让现有连接生命周期处理后续恢复；网关仍运行。 |

### 2.2 浏览器模式边界

是否受导航回调缺陷影响，取决于实际 driver，不能只用界面的“内置/外置”判断。

| 使用方式 | 当前调用链 | 本次导航补丁的范围 |
| --- | --- | --- |
| 外置托管 Chrome，`profile=openclaw` | OpenClaw → Playwright → `gotoPageWithNavigationGuard` | 直接覆盖；故障现场属于此模式。 |
| 用户 Chrome 经 extension relay 或直接 CDP 接管 | `/navigate` → `navigateViaPlaywright` | 共享修复路径，需做相应接管模式回归。 |
| LobsterAI 内置浏览器，`profile=lobster-in-app` | `existing-session` → Lobster MCP bridge → Electron `webContents.loadURL` | 默认不经过该 route 回调；作为不受行为改变的对照。 |
| 用户 Chrome 经 `existing-session` / Chrome DevTools MCP 接管 | OpenClaw → MCP 导航 | 不经过该 route 回调；前后置 DNS 检查仍可能返回正常工具错误。 |
| 用户手动打开普通浏览器页面 | 不调用 OpenClaw browser 工具 | 不因手动浏览触发该网关缺陷。 |

内置桥接不可用时可回退到外置，工具也可以指定其他 profile。验证时应核对实际
profile 和 driver。以上结论仅限定本次定位的路径，不表示某个模式不会出现其他故障。

## 3. 功能需求

1. fast path 开始任何异步 gateway 工作之前，安装上游已有的 rejection 和异常策略；
   同一启动流程只安装一次。保留 fatal、配置错误等原有退出行为。
2. 每个导航 route 回调的异步失败都有明确接收者，不向 Playwright 事件分发链泄漏。
   失败请求必须被结束，操作结果由被调用者 `await` 的导航 Promise 返回。
3. 区分顶层失败、子 frame 导航检查中的已知 transient network 错误和策略拒绝。
   保留 SSRF、`blockedHostnames`、重定向检查、顶层拒绝的隔离和关闭行为；普通 DNS
   失败不写入策略封禁状态，也不因此关闭已有 page。不能吞掉 `continue` 失败。
4. 导航结束时清理本次注册的 route，管理仍在执行的回调；清理及晚到结果不能带来
   无界等待、过期导航、下一次操作污染或未处理 rejection。
5. 接收 CDP dispatch 返回的 Promise，失败只影响该连接；保留关闭确认、缓存失效和
   重连的既有所有权。
6. 通过版本补丁应用和 runtime 构建流程交付，不以直接修改 sibling checkout 或
   生成后的 `vendor/dist` 作为最终实现。

## 4. 实现方案

### 4.1 在上游行为所属模块修复

LobsterAI 主进程的 RPC `catch` 无法接收另一进程中 Playwright 回调的 rejection。
在 launcher 注入全局兜底只能止血，不能结束悬挂 route，并会引入对上游私有导出和
生成文件名的依赖。因此在 OpenClaw 的启动、导航和 CDP 所属模块分别维护小补丁。

不增加网关重启次数，不使用全局 `--unhandled-rejections=warn`，不关闭 SSRF，
不切换用户浏览器模式，不添加针对特定域名的黑名单或无界 DNS 重试。

### 4.2 三个独立补丁

| 补丁 | 所属上游文件 | 内容 |
| --- | --- | --- |
| `openclaw-gateway-fast-path-rejection-handler.patch` | `src/cli/run-main.ts` 及其测试 | 回移 #141163，在 fast path 前安装现有全局处理器，避免 full CLI fallback 重复安装。 |
| `openclaw-browser-navigation-error-containment.patch` | `extensions/browser/src/browser/pw-session-navigation.ts` 与新增 `pw-session-navigation.rejection.test.ts` | 仅修改 `gotoPageWithNavigationGuard`，接收 route 的 DNS/生命周期失败，结束请求，管理操作内的回调和清理，保留策略语义。 |
| `openclaw-browser-cdp-dispatch-rejection.patch` | `extensions/browser/src/browser/pw-session-cdp-transport.ts` 及其测试 | 回移 #150177，接收 CDP message 回调返回的 Promise，失败时关闭受影响连接。 |

三个补丁均放在 `scripts/patches/v2026.8.1/`。同步补丁清单、应用有效性检查和回归
测试，使未应用、部分应用或重复应用的状态可被识别。源码实现及测试随对应 patch
一起保存，便于升级时按职责移除。runtime 必须从补丁后的源码重建。

### 4.3 导航错误与清理契约

本补丁仅修改 `gotoPageWithNavigationGuard`，不改相邻其他导航 guard 的行为。
导航操作收集其 route 回调的错误和在途操作，回调的所有异步失败均有接收者，不向
Playwright 事件分发链泄漏。

顶层网络失败记录为当前导航错误并 abort 请求。只有子 frame 在
`assertBrowserNavigationAllowed()` 内抛出的已知 transient network 错误被隔离为
该 frame 失败；未知错误和 `continue` 失败仍作为操作错误返回，不能因为请求属于
子 frame 就静默当作成功。普通 DNS 错误不会触发 quarantine，也不因此关闭已有 page。

同一操作遇到多个错误时，返回顺序固定为：顶层策略拒绝 > 普通 `guardError` >
`page.goto` 错误 > 清理错误。这样保留安全失败和具体导航原因，避免被后续超时或
清理异常覆盖。

导航结束时通过 `stopSignal` 终止对 DNS 校验的等待；其迟到的 resolve/reject 仍被
接收，但不能再 `continue` 失效请求。只 `unroute` 本次注册的 exact handler，不
清除其他路由。`unroute` 与在途回调 drain 的完整清理链共享 **1000ms** 上限；这是
独立的短暂清理宽限，不占用或依赖 `page.goto` 的剩余 timeout。因此导航超时后仍
允许最多 1000ms 清理，不能把这一宽限误认为新的导航重试或无限等待。

本次不新增诊断日志。

### 4.4 上游依据与移除条件

调查时间为 2026-09-17。上游 main 检查固定在
[`5d1389f2c8a3546e2c6dd52bafe90a09e1667460`](https://github.com/openclaw/openclaw/commit/5d1389f2c8a3546e2c6dd52bafe90a09e1667460)，
后续升级必须重新核对目标 tag 的源码和行为。

| 本地补丁 | 上游依据 | 升级到 `v2026.9.4` 时 | 最终移除条件 |
| --- | --- | --- | --- |
| fast-path rejection handler | [Issue #141123](https://github.com/openclaw/openclaw/issues/141123) / [PR #141163](https://github.com/openclaw/openclaw/pull/141163)，提交 [`1ddd53680b6bbc1d725fd67edc9ffa31944dfe86`](https://github.com/openclaw/openclaw/commit/1ddd53680b6bbc1d725fd67edc9ffa31944dfe86) | **可移除这一份补丁**。该版本已包含等价启动修复；先确认实际入口、处理器顺序和回归通过。 | 目标版本在所有使用的 gateway 启动入口安装等价策略且不重复注册，运行回归后删除本地补丁和对应清单项。 |
| navigation error containment | 固定 main 的 [`pw-session-navigation.ts`](https://github.com/openclaw/openclaw/blob/5d1389f2c8a3546e2c6dd52bafe90a09e1667460/extensions/browser/src/browser/pw-session-navigation.ts#L409) 仍直接抛出普通 route DNS 错误 | **继续保留并按源码迁移**。不能因为启动兜底已修就删除导航生命周期修复。 | 目标版本接收同类回调失败、结束请求、管理迟到结果并通过顶层/子 frame/安全/超时回归；若只覆盖一部分，只移除对应部分。 |
| CDP dispatch rejection | [Issue #150126](https://github.com/openclaw/openclaw/issues/150126) / [PR #150177](https://github.com/openclaw/openclaw/pull/150177)，提交 [`22572027ded601e128335c45c537a37113b384d5`](https://github.com/openclaw/openclaw/commit/22572027ded601e128335c45c537a37113b384d5)，北京时间 2026-09-17 07:42 合并 | **继续保留**。`v2026.9.4` 发布早于该提交，不包含此修复。 | 后续目标版本包含该提交或等价实现，并通过同步/异步 dispatch、连接关闭和网关存活回归。 |

**升级上游 `v2026.9.4` 只能适当移除这组补丁中的 fast-path 部分，不能整体移除。**
已直接核对 [`v2026.9.4/src/cli/run-main.ts`](https://github.com/openclaw/openclaw/blob/v2026.9.4/src/cli/run-main.ts#L1506)
包含 #141163。#150177 已出现在固定 main 的
[`pw-session-cdp-transport.ts`](https://github.com/openclaw/openclaw/blob/5d1389f2c8a3546e2c6dd52bafe90a09e1667460/extensions/browser/src/browser/pw-session-cdp-transport.ts#L160)，
但不能据此认定它已进入 `v2026.9.4`。

升级时逐项对比目标 tag，而不是只判断 PR 为 closed、patch 是否产生冲突或通用
全局处理器是否存在。确认等价实现后更新补丁 README、版本清单和验收记录，再重建
runtime；未被上游覆盖的测试语义必须保留。

## 5. 边界情况

| 场景 | 处理方式 |
| --- | --- |
| 顶层 `ENOTFOUND` / `EAI_AGAIN` | 结束请求并返回当前操作错误，不 quarantine 或关闭已有 page，不结束网关。 |
| 子 frame 在 `assertBrowserNavigationAllowed` 内出现已知 transient network 错误 | 只 abort 该 frame；有效主页面及后续浏览器工具继续工作。 |
| 顶层 SSRF、非法 URL 或 blocked hostname | 保留拒绝、quarantine 和由导航所有者关闭目标的行为。 |
| 子 frame 策略拒绝 | 保留只阻止该 frame 的行为，不因此关闭有效主页面。 |
| `continue` 或页面生命周期出现未知错误，包括子 frame | 接收错误并返回操作失败，不能将其报告为成功。 |
| timeout、页面关闭与 DNS 返回交错 | 用 `stopSignal` 结束等待，阻止晚到 continue，接收迟到 resolve/reject。 |
| `unroute` 或在途回调长时间不结束 | 整条清理链共用独立的 1000ms 宽限，超时返回清理错误；更高优先级的既有错误不被覆盖。 |
| 同时存在策略、guard、goto 和清理错误 | 按顶层策略拒绝 > `guardError` > `page.goto` 错误 > 清理错误返回。 |
| 页面上已有其他 route | 仅移除本操作注册的 handler。 |
| CDP 回调同步 throw 或异步 reject | 接收两种失败并关闭受影响连接，关闭只由现有生命周期触发一次。 |
| 真实 fatal 或配置错误 | 保留上游原有退出策略；本修复不是吞掉一切未处理异常。 |
| 内置 MCP 导航的正常失败 | 继续通过原有 awaited 调用链返回工具错误，不新增 Playwright 接管。 |
| 升级导致某份补丁部分被上游覆盖 | 根据第 4.4 节逐项裁剪，不能用整体删除或强行应用掩盖差异。 |

## 6. 验收标准与验证记录

### 6.1 自动化回归要求

- fast path 在异步 gateway 工作开始前安装处理器，full CLI fallback 不重复安装；
  已有非致命网络分类和 fatal 策略保持。
- 导航覆盖顶层和重定向 DNS 失败、子 frame 检查内的已知网络错误、未知错误、策略
  拒绝、`continue` 失败、页面关闭、超时及晚到 resolve/reject。
- 上述失败不触发 `unhandledRejection`；路由及时结束，不污染 blocked-target 状态，
  不因 DNS 失败关闭已有 page，不清除其他 route，过期回调不继续导航；`unroute` 与
  在途 drain 的总清理期限不超过独立的 1000ms，错误优先级符合第 4.3 节。
- CDP 同步和异步 dispatch 失败都关闭受影响连接，正常消息仍分发且不产生重复关闭。
- 使用仓库应用流程验证补丁可应用及重复执行，补丁清单和有效性检查覆盖三份补丁；
  涉及的 LobsterAI TypeScript 通过定向测试、严格 lint 和相应编译检查。

### 6.2 runtime 与产品回归要求

- 在重建的 runtime 上重复第 1.3 节真实浏览器用例：主页面成功，失败顶层导航及时
  返回错误，子 frame DNS 失败后主页面仍可用，后续浏览器操作正常。
- 用独立 stateDir/profile 启动真实 gateway，确认失败前后 PID 不变，health/readiness
  和已有连接持续有效，其他任务不中断；不要操作个人浏览器或真实用户数据。
- 覆盖托管 Chrome 和 extension/CDP；内置 MCP 导航作对照，验证实际 driver。
- 在 Windows launcher 及 macOS/Linux 实际分发入口确认启动处理器顺序和补丁存在。
  打包应用中验证 IM 连接及并行任务不因浏览器 DNS 失败中断。
- 不把源码单元测试或独立 Chrome 实验记为安装包、IM 或跨平台回归已完成。

### 6.3 实施验证记录

第 1.3 节记录的是修复前真实浏览器调查。本次还先用未修复代码运行新增回归，得到
以下 red 阶段结果，证明新用例能检测相应缺陷：

| 回归范围 | 未修复代码结果 |
| --- | --- |
| 导航，新增 `pw-session-navigation.rejection.test.ts` | 当时共 11 项：9 项失败，2 项通过。 |
| Gateway fast path | 共 4 项：3 项失败，1 项通过。 |
| CDP dispatch | 共 2 项：1 项失败，1 项通过。 |

导航随后补充了 2 个边界用例，当前新增导航文件共 13 项；red 阶段只覆盖最初的
11 项，不能声称当前 13 项都已在旧代码上重复验证失败。

已完成的实施验证如下：

| 检查 | 实际结果与范围 |
| --- | --- |
| 完整版本补丁重应用 | 42 份 patch 完整重应用两次，每次均为 `Applied 42 / Skipped 0`。 |
| LobsterAI patch suite | 20 个测试文件，共 70 项：69 项通过、1 项跳过。 |
| LobsterAI 变更文件严格 ESLint | 通过。 |
| `node --check scripts/apply-openclaw-patches.cjs` | 通过。 |
| Electron TypeScript 编译 `compile:electron` | 通过。 |
| OpenClaw browser 定向回归 | 3 个文件、65 项全部通过，包含当前 13 个新增导航用例、CDP 及原导航守卫回归。 |
| OpenClaw `unhandled-rejections` | 54 项全部通过。 |
| OpenClaw `fatal-detection` | 10 项全部通过。 |
| OpenClaw 全 CLI 回归，修复后代码 | 共 255 项：252 项通过、3 项失败。 |
| OpenClaw 全 CLI 回归，恢复原始对照 | 完全恢复原始 `run-main.ts` 和原始 `exit.test.ts` 后，共 251 项：248 项通过、同样 3 项失败。失败用例和断言均与修复后相同。 |
| 独立只读导航复核 | 未发现待修项。 |
| 最终 OpenClaw QA runtime 构建 | `qaRuntime` 全部阶段通过，最终构建耗时 2m19.6s。 |
| 最终真实 Gateway + Chrome 验证 | 6 个必过场景通过，另一次客户端顶层跳转命中导航守卫内的 Node `ENOTFOUND`。76 次 health 全部成功，同一 PID、同一 WebSocket，意外断连为 0。 |

CLI 的 3 项失败来自 Windows 环境中的 POSIX 路径 fixture，已用上述未修改源码对照
确认是基线问题。本次未修改这些无关测试，也未将 CLI 全套记录为全部通过。两个 CLI
运行的分母不同，是因为恢复原始测试时同时移除了本次新增的 4 个 fast-path 用例。

自动审查流程已实际启动，但本机缺少 TruffleHog，预检在发送前拒绝，因而未取得
自动审查结论。此项不属于产品功能失败，也不应记为自动审查通过。

实际执行的 OpenClaw `check:changed --base HEAD -- <本次六个源码/测试文件>`
通过冲突标记和 max-lines 检查，但在 assertion SAFETY ratchet 中止：报告的 7 个
文件属于已有的 memory、transcript、provider、gateway 补丁，均不在本次三个补丁
修改范围内。未绕过该门禁，也未把整套上游门禁记为通过。六个变更文件的普通
oxlint（warnings 为错误）及 oxfmt 检查已单独通过；全图 type-aware lint 因本机
内存压力中止。包含六个变更文件及实际依赖的定向 tsgo 检查也未完成：在本机
16GB 内存环境中，编译器占用持续增长，影响运行时验证，因此终止了本任务启动的
编译器进程。未取得 OpenClaw 完整类型检查通过结论，后续须在构建机补跑。

最终真实验证于 2026-09-17 12:20–12:22（Asia/Shanghai）完成，运行编号为
`gateway-dns-2026-09-17T04-20-48-388Z-a8e01780`。使用独立 stateDir、随机端口、
全新托管 headless Chrome profile；测试配置与 LobsterAI 默认 `ProxyCompatible`
模式一致，使用 `dangerouslyAllowPrivateNetwork: true` 并保留 `blockedHostnames`。
没有更改产品配置或关闭导航守卫。

| 真实场景 | 结果与证据边界 |
| --- | --- |
| 正常页面对照 | 841ms 成功。 |
| 主页面含失效 `.invalid` iframe | 主页面 962ms 成功，iframe document 请求记录为 `net::ERR_FAILED`（guard abort）。 |
| 同一 iframe 域名的 Node DNS 对照 | 33ms 返回原始 `getaddrinfo ENOTFOUND`；此项单独仅证明 preflight，不能代替 route 回调证据。 |
| HTTP 302 到失效域名 | 282ms 返回 Chromium `ERR_NAME_NOT_RESOLVED` 工具错误；Playwright 不拦截链中每一跳，此项不声称命中 Node route DNS 分支。 |
| 已加载本地文档的客户端顶层跳转 | 1177ms 返回原始 `getaddrinfo ENOTFOUND`，确认导航守卫内的独立顶层 document 请求失败被接收。 |
| 相同标签页恢复正常导航 | 610ms 成功，无需重启网关或浏览器。 |
| 配置的 blocked hostname | 31ms 被安全策略拒绝，health 仍成功。 |

76 次并行 health 采样均成功，日志中没有 unhandled rejection / uncaught exception。
最终三个源码文件及入口的 SHA-256 与实测记录逐项一致。测试后主动停止自建进程，
Gateway、Chrome、browser control、extension relay 四个监听均已关闭，清理错误为空。
摘要中的清理阶段 exit code 1 来自 Windows `taskkill /T /F`，不是场景执行中崩溃。

早先一次 strict 测试配置会在 DNS 之前拒绝 hostname，不能证明根因路径，未计入
上述成功证据。最终证据明确区分 Node DNS 与 Chromium DNS 错误。

本次实测覆盖 Windows 源码 QA runtime 和托管 Chrome；实际用户 extension/attached
profile、内置 MCP、Electron 安装包、真实 IM 及 macOS/Linux 尚未手工验收。CDP
同步/异步回调另由真实 WebSocket 单元回归覆盖，不能据此声称完成所有 driver 的
端到端回归。源码测试和 LobsterAI 编译通过不替代这些验证。

本次真实网关验证使用隔离 OpenClaw worktree 中的源码构建，命令如下；复用已有依赖，
不执行依赖安装，也不改动原工作区的 runtime：

```powershell
# 在已应用 LobsterAI 全部版本补丁的 OpenClaw v2026.8.1 worktree 中执行
$env:OPENCLAW_BUILD_ALL_NO_PNPM = '1'
$env:OPENCLAW_RUN_NODE_SKIP_DTS_BUILD = '1'
node --import ./scripts/tsx.mjs scripts/build-all.mts qaRuntime
```

QA 入口为该 worktree 的 `dist/entry.js`，不是旧的 `vendor/openclaw-runtime`。
该命令验证可运行源码构建；分发安装包仍须走 LobsterAI 标准 runtime 构建和打包流程，
不能直接交付 QA 产物。发布时保留 `package.json` 中当前 pin，应用三个版本补丁后
重建 runtime；不要手改生成的 bundle。

## 7. 涉及文件

| 文件或范围 | 职责 |
| --- | --- |
| `scripts/patches/v2026.8.1/openclaw-gateway-fast-path-rejection-handler.patch` | 启动异常处理器回移及上游回归。 |
| `scripts/patches/v2026.8.1/openclaw-browser-navigation-error-containment.patch` | 导航错误生命周期及上游回归。 |
| `scripts/patches/v2026.8.1/openclaw-browser-cdp-dispatch-rejection.patch` | CDP 异步分发回移及上游回归。 |
| `scripts/patches/v2026.8.1/README.md` | 补丁目的、验证入口、上游来源及独立移除条件。 |
| `scripts/apply-openclaw-patches.cjs` | 补丁应用有效性检查。 |
| `src/main/libs/openclawPatches/` | 更新版本补丁清单及宿主侧补丁回归。 |
| 本文档 | 完整记录设计、驱动边界、调查证据、验收和升级退役依据。 |
