# 测试服数据库迁移维护响应

> **2026-10-22 后续发布更新：** 测试库迁移已完成。`feat/remote-connect` 新版已退役本次迁移专用维护门禁，合入 `feature-dev` 后直接部署一次即可，不需要修改 `SCHEMA_MIGRATION_MAINTENANCE_ENABLED`，也不需要二次重启或重复执行 DDL。本轮仅准备代码，尚未合并或部署新版。下方原过渡版本说明保留为历史记录。

## 迁移完成后的接口与接入

- 新版不再读取旧维护环境变量；即使其值仍为 `true`，新实例也按已迁移结构恢复业务。旧过渡实例在被替换前仍保持维护，滚动发布期间仍可能返回下文的维护 503，请保留原重试处理。
- 原路径、请求参数、响应业务字段类型和业务 ID 字符串语义保持不变，不要求客户端升级。数据库中的字符串业务标识改存 `business_id`，不影响对外 `id`；客户端继续使用原登录凭据、权限校验和幂等标识。
- 原 Cookie/Session、JWT Bearer 以及业务原有功能配置、计费与验收条件继续生效。移除迁移门禁不等于自动满足 Apple proof 或其他开通条件。
- 运维状态接口 `GET /api/admin/schema-migration/status` 保留，仍使用 Admin IAM JWT，无请求 body，也不要求客户端接入。新版响应为：

```json
{"code":0,"message":"success","data":{"maintenanceEnabled":false,"configurationMode":"retired","businessIdColumn":"business_id","guardedSqlSessionFactories":0,"protectedTableCount":0,"blockedStatements":0}}
```

发布人员需确认所有实例升级并完成业务验收；状态接口仅描述当前实例的代码阶段，不验证数据库结构或整个集群状态。不要关闭仍在运行的旧过渡实例的维护配置。详细发布说明见服务端 `docs/operations/2026-10-22-test-schema-direct-deploy.md`。

## 原过渡版本记录

## 变更概述

服务端过渡分支 `codex/test-schema-transition` 继续访问旧字符串 `id` 列，通过启动配置 `SCHEMA_MIGRATION_MAINTENANCE_ENABLED=true` 隔离迁移功能。测试 profile 默认开启维护，公共配置默认关闭，环境变量可覆盖；维护关闭时原路径、请求参数、JWT 双 Token、业务 ID 字符串语义不变，不要求旧桌面客户端同步升级。本次服务端仅完成代码和构建，尚未部署。

## 接口详情

维护期间，`/api/remote/**`（含 WebSocket 握手）、`/api/proxy/**`、`/api/media/**`、`/api/iap/apple/**`、`/api/subscription/**`、`/api/payment/**` 等依赖待迁移表的请求返回 HTTP 503。会员模型 `GET /api/models/available`、权益查询与站点发布配额相关接口也暂停。

原请求不增加参数，例如：

```http
POST /api/proxy/v1/chat/completions
Authorization: Bearer <原 accessToken>
Content-Type: application/json

{"model":"<原模型标识>","messages":[{"role":"user","content":"hello"}],"stream":true}
```

维护响应为普通 JSON，尚未建立 SSE 流：

```json
{"code":503,"message":"数据库升级维护中，请稍后重试","data":{"reason":"SCHEMA_MIGRATION_MAINTENANCE","retryable":true}}
```

包含 `Retry-After: 60`、`Cache-Control: no-store`。`POST /api/auth/exchange` 同样在消费一次性 authCode 之前返回 503；请求仍为原 `{"authCode":"..."}`，没有协议升级。维护不会延长 authCode 原有效期，过期后需要重新发起登录。

## 客户端事项

- 在创建 SSE/解析模型流之前处理 HTTP 503，展示维护提示并保留用户输入，不当成额度耗尽。
- WebSocket 握手失败时采用有界退避，不重复轮询、刷票据或重连风暴；不因维护清除设备业务标识或已同步数据。
- 503 不等于 Token 失效，不能循环刷新 Token 或自动注销。`POST /api/auth/refresh` 保留原行为，但新的 authCode 交换暂不可用。
- 维护期间不要自动开启替代计费路径。恢复后保持原幂等标识和游标协议，先查询已有任务状态再决定是否重试。
- 本次不修改 Electron 代码；上述事项用于测试环境验收和后续体验优化。

## 认证与发布顺序

维护响应在前置过滤器中返回；维护关闭时沿用原 JWT Bearer、个人/企业身份及远控权限校验。后台 `GET /api/admin/schema-migration/status` 使用 Admin IAM JWT，仅供发布人员逐实例检查，桌面客户端不需要接入。

先让全部过渡实例启动为维护模式，并等待旧实例上的流式请求完成计费结算、后台任务完成或回滚后退出，再变更测试库。第二阶段部署匹配 `business_id` 新表结构的服务端；验收完成后恢复功能。维护配置固定在进程启动时读取，不支持热切换。本次没有数据库迁移或客户端部署动作。
