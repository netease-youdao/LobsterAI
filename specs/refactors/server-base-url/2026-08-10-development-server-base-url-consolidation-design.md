# 开发态 Server Base URL 统一设计文档

> 状态：Implemented
>
> 适用范围：LobsterAI Electron 未打包开发态

## 1. 概述

### 1.1 问题与动机

此前活动接口可通过独立环境变量切换 server，而模型列表、鉴权刷新、OpenClaw 代理和媒体接口仍使用默认地址。同一客户端可能因此同时连接两个鉴权域，产生登录态不一致、测试结果误判和 Token 发送边界不清晰的问题。

### 1.2 目标

1. 使用唯一的 `LOBSTER_SERVER_BASE_URL` 覆盖全部 LobsterAI server API。
2. 只允许受信任的本机开发服务作为目标。
3. 打包版本始终使用生产配置，不受环境变量注入影响。
4. 不改变任何生产请求路径和默认 endpoint。

## 2. 现状与方案

### 2.1 单一 origin

活动、模型列表、鉴权刷新、OpenClaw Token Proxy、媒体及其他 server API 从同一个 endpoint resolver 获取 origin。移除活动接口的独立覆盖语义，避免一个进程内存在多个 server origin。

### 2.2 输入限制

覆盖仅在 `isDev=true` 且 Electron 未打包时生效，并且必须满足：

- 协议为 HTTP 或 HTTPS；
- hostname 是字面量 `127.0.0.1` 或 `[::1]`；
- 包含显式端口；
- 不包含账号密码、业务路径、查询参数或 fragment。

合法示例：

```powershell
$env:LOBSTER_SERVER_BASE_URL = 'http://127.0.0.1:18878'
```

`localhost` 不在允许列表中，避免 hosts/DNS 重绑定带来的目标歧义。非法配置直接给出明确错误，不静默回落到部分默认 endpoint。

### 2.3 安全边界

该变量只改变 origin，不隔离本地持久化的 Token、模型缓存和会话数据。Bearer Token 会发送给指定的本机进程，因此开发者只能连接受信任服务。测试 server 也可能拒绝生产 Token 并触发退出登录；切换环境后需要重新验证对应登录态。

启用覆盖时，主进程输出一次醒目的开发 origin 警告。打包版本忽略环境变量，防止发布包被宿主环境改写服务地址。

## 3. 实施范围

| 模块 | 改动 |
|---|---|
| `src/main/libs/developmentServerBaseUrl.ts` | 校验并解析开发态 loopback origin |
| `src/main/libs/endpoints.ts` | 建立统一 server base URL |
| `src/main/libs/openclawTokenProxy.ts` | 使用统一 endpoint |
| `src/main/ipcHandlers/activity/handlers.ts` | 移除活动专属地址语义 |
| `src/main/libs/startupCacheWarmup.ts` | 模型 warmup 使用统一 endpoint |

## 4. 边界情况

| 场景 | 处理方式 |
|---|---|
| 未设置变量 | 使用默认 server origin |
| 开发态合法 loopback URL | 全部 server API 使用覆盖 origin |
| hostname 为 `localhost` | 拒绝 |
| 未显式指定端口 | 拒绝 |
| 带路径、凭据、查询或 fragment | 拒绝 |
| Electron 已打包 | 忽略覆盖，使用生产 origin |
| 从测试环境切回生产环境 | 重新确认登录态和模型缓存 |

## 5. 验证计划

1. endpoint resolver 对合法和非法 URL 的单元测试通过。
2. 活动、模型 warmup 和 Token Proxy 使用相同 origin。
3. 未设置变量时所有既有 endpoint 保持不变。
4. 打包态即使存在环境变量也不能修改 server origin。
5. 主进程只输出一次开发覆盖警告，日志不包含 Token。
