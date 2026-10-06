# LobsterAI 登录凭证生命周期修复设计文档

## 1. 概述

### 1.1 问题

LobsterAI 桌面端使用 Access Token 与 Refresh Token 访问套餐模型和账号接口。服务端已将新签发的 Access Token、Refresh Token 有效期分别调整为 30 天和 180 天，但端侧仍存在以下问题：

1. 应用启动恢复账号时，断网、请求超时、服务端 5xx 与凭证真正过期都会返回笼统的失败，renderer 可能将临时故障当作退出登录。
2. 主进程认证接口、OpenClaw Token 代理和 OpenAI 兼容代理存在多条刷新路径，其中兼容代理曾直接调用刷新接口，绕过统一的并发合并。
3. 多个使用旧 Access Token 的请求可能先后收到 401。首个请求刷新完成后，迟到的 401 仍可能再次刷新。
4. Refresh Token 被明确拒绝后，没有统一清理本地状态并通知 renderer；套餐模型最终显示的是“API 密钥无效或已过期”，与用户实际使用的登录凭证不符。
5. 刷新请求没有显式超时，异常网络下所有等待同一次刷新的请求可能长时间挂起。
6. 端侧缺少“登录态恢复、刷新结果、真正退登”的结构化生命周期事件。

### 1.2 根因

- `auth:getUser` 只返回 `success`，无法表达“无凭证、暂时不可校验、Refresh Token 失效”之间的差异。
- Token 刷新逻辑散落在 `main.ts` 和本地代理中，缺少统一的刷新结果类型。
- 原有单飞 Promise 只覆盖正在执行的刷新；刷新完成后才到达的旧 401 无法识别 Token 已经更新。
- OpenClaw 运行时错误分类只根据通用 401 映射到 API Key 错误，没有结合 `lobsterai-server` provider 元数据。
- 端侧行为上报使用 rlogs，而 Grafana 中的 Graphite 指标来自服务端 MetricLog，两条链路用途不同。

## 2. 用户场景

### 场景 1：启动时网络暂时不可用

**Given** 本地仍有登录凭证和缓存的用户资料

**When** 应用启动校验账号时发生断网、超时或服务端临时错误

**Then** 保留登录快照，不清理 Token，不将用户标记为真正退出

### 场景 2：Access Token 过期但 Refresh Token 有效

**Given** Access Token 已过期且 Refresh Token 仍有效

**When** 账号接口或套餐模型请求收到 401

**Then** 只执行一次刷新，保存新 Token，并使用新 Access Token 重试原请求

### 场景 3：并发请求收到旧 Token 的 401

**Given** 另一个请求已经完成刷新

**When** 使用旧 Access Token 的迟到响应返回 401

**Then** 先使用当前已保存的新 Access Token 重试，不再次调用刷新接口

### 场景 4：Refresh Token 真正失效

**Given** 刷新接口返回 HTTP 401，或业务码 `40100`/`40101`

**When** 桌面端确认 Refresh Token 已过期或无效

**Then** 清理登录凭证和套餐模型缓存，通知 renderer 进入过期状态，并提示用户重新登录

### 场景 5：刷新请求超时

**Given** 刷新接口在 15 秒内没有响应

**When** 主进程中止本次刷新

**Then** 将结果标记为临时失败，保留登录凭证，等待后续操作再次恢复

## 3. 功能需求

### FR-1：结构化认证状态

统一使用以下状态：

- `authenticated`：服务器已确认登录有效
- `unauthenticated`：本地没有凭证
- `temporarily_unavailable`：网络、超时、5xx 或异常响应导致暂时无法确认
- `expired`：刷新接口明确拒绝 Refresh Token

只有 `expired` 和明确的用户退出操作可以清理本地登录状态。

### FR-2：统一刷新协调器

- 所有 LobsterAI Refresh Token 刷新必须进入同一个协调器。
- 同时发生的刷新共享同一个 Promise。
- 收到 401 后先比较请求使用的 Access Token 与当前保存的 Token；若已更新，优先使用新 Token 重试。
- LobsterAI 套餐请求仅对 HTTP 401 刷新，403 按模型/账号权限错误处理。
- 若 401 后的刷新因网络、超时或 5xx 临时失败，本地代理返回临时服务错误，不把原始 401 继续包装成“登录已过期”。

### FR-3：终态失效闭环

- Refresh Token 终态失效时只执行一次本地清理。
- 主进程通过 `auth:sessionChanged` 通知 renderer。
- Renderer 清理用户、额度和套餐模型状态，并加载公开模型目录。
- Renderer 通过现有全局 Toast 明确提示登录状态过期，需要重新登录。
- `lobsterai-server` 的 401 显示“登录状态已过期，请重新登录”，其他自定义供应商仍显示 API Key/OAuth 对应提示。

### FR-4：刷新超时

- 刷新请求超时为 15 秒。
- 超时属于临时失败，不触发退登。
- 第一版不增加指数退避或长时间冷却，避免网络恢复后仍被人为阻塞。

### FR-5：认证生命周期事件

端侧通过现有 rlogs 行为分析链路上报低基数事件：

- `auth_restore`
- `token_refresh`
- `auth_terminal_expired`

事件只包含结果、刷新原因、失败类型、HTTP 状态、业务错误码、耗时和合并请求数，不包含 Token。

Grafana/Graphite 的运维指标继续以服务端 MetricLog 为准，包括：

- `api.result.auth.refresh`
- `api.cost.auth.refresh`
- `api.result.auth.exchange`
- `api.error_code.TOKEN_EXPIRED`
- `api.error_code.TOKEN_INVALID`

端侧 rlogs 事件不会自动写入上述 Graphite 数据源；如未来需要在同一 Grafana 面板展示精确客户端状态，应另行设计受限的服务端客户端指标接收接口。

### FR-6：自动化测试

测试至少覆盖：

- 并发刷新只访问一次刷新接口
- 迟到旧 401 使用已更新 Token 重试
- 刷新期间退出或重新登录时，迟到响应不覆盖当前会话
- 403 不刷新
- 刷新 401 进入终态失效
- 刷新 5xx、网络失败和超时保留登录态
- 临时不可用保留 renderer 登录快照
- 终态失效清理 renderer 状态
- LobsterAI 套餐 401 与第三方 API Key/OAuth 错误显示不同文案

## 4. 实现方案

### 4.1 共享协议

在 `src/shared/auth/constants.ts` 中集中认证 IPC 名称、会话状态、刷新结果、失败类型、刷新原因和生命周期事件类型，供 main、preload 与 renderer 共同使用。

### 4.2 主进程刷新协调

新增 `AuthSessionManager`，通过依赖注入使用 Token 存储、Electron `net.fetch`、刷新 URL 和事件回调。该模块负责：

- 单飞刷新
- 15 秒超时
- 服务端响应分类
- Token 轮换保存
- 认证请求 401 重试
- 旧 Token 迟到 401 保护
- 生命周期指标事件

`main.ts` 继续负责本地数据清理、OpenClaw 配置同步和 BrowserWindow 事件发送，避免认证协调模块依赖 Electron 窗口与业务缓存。

### 4.3 本地代理

- OpenClaw Token 代理在 401 后先检查 Token 是否已经更新，再决定是否刷新。
- OpenAI 兼容代理把被拒绝的 Token 传给刷新回调；当前 Token 已更新时直接复用。
- 两类代理都保留结构化刷新结果；临时刷新失败映射为 503，只有终态失败继续按登录失效处理。
- LobsterAI Server provider 不再因 403 刷新，Copilot 等具有独立语义的 provider 保持原有行为。

### 4.4 Renderer 状态

Redux auth slice 增加 `sessionStatus`：

- 暂时不可用时保留已有用户、额度和登录标记。
- 冷启动时若 main 返回缓存用户和仍存在的凭证，可恢复账号展示。
- 终态过期时清理用户、额度、资料摘要和套餐模型。

### 4.5 错误提示

OpenClaw 错误分类结合 provider、HTTP 状态和 failover 元数据：

- `lobsterai-server` + 401：登录状态过期
- `lobsterai-server` + HTTP 403：模型访问权限不足
- 第三方 provider 401：维持 API Key/OAuth 错误

中英文文案同时添加到 main 和 renderer 的 i18n 字典。

## 5. 边界情况

| 场景 | 处理方式 |
|------|---------|
| 刷新接口 401 且响应体为空 | 视为 Refresh Token 终态失效 |
| 刷新接口返回 200 但缺少新 Access Token | 视为临时的无效响应，不清理凭证 |
| 刷新接口 5xx | 临时失败，不清理凭证 |
| 刷新过程中断网 | 临时失败，不清理凭证 |
| 刷新请求超过 15 秒 | 中止请求并标记超时，不清理凭证 |
| 套餐模型 401 后刷新暂时不可用 | 返回临时服务错误，不提示登录已过期 |
| 刷新成功后业务接口仍返回 401 | 返回业务响应，不将一次成功刷新反向判定为 Refresh Token 过期 |
| 刷新期间用户主动退出 | 丢弃迟到的刷新响应，不重新写回已经清理的凭证 |
| 刷新期间用户完成新登录 | 丢弃旧会话的刷新响应，保留新登录签发的 Token |
| 多窗口同时存在 | 主进程向所有未销毁窗口广播认证状态事件 |
| Renderer 尚未订阅终态事件 | 后续 `auth:getUser` 因无本地凭证返回 `unauthenticated`，仍会显示登录入口 |

## 6. 非目标

本次不包含：

- Refresh Token 安全存储和数据迁移策略
- 到期前 72 小时的主动刷新策略
- 登录点击、浏览器拉起和回调漏斗统计修正
- 端侧直接写入 Graphite

## 7. 验收标准

1. 断网、超时和服务端 5xx 不再清理有效登录凭证。
2. Refresh Token 返回 401/`40100`/`40101` 后，renderer 自动进入过期状态、展示登录入口并通过 Toast 提示重新登录。
3. 套餐模型认证失败显示登录过期文案，不再显示 API 密钥过期。
4. 同一时刻多个 401 只触发一次刷新；迟到旧 401 不重复刷新。
5. LobsterAI 套餐路径的 403 不触发 Token 刷新。
6. 生命周期事件不包含 Token 或任意高基数字段。
7. 相关 Vitest、Electron TypeScript 编译、renderer 类型检查和改动文件 ESLint 全部通过。
