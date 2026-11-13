# 火山云 Runner 适配接入说明（2026-11-09）

状态：源码已实现并完成本地进程验证，尚未构建发布新镜像，也未完成火山云端完整运行验收。客户端无需同步升级。

## 变更概要

Runner 新增 `provider-subreaper-v1` 模式，适配 cgroup 只读的平台。CPU、内存由云实例限制；可信进程监管器负责降权启动与后代进程回收。保留缺省 `cgroup-v2` 模式及旧发布清单的哈希语义。

新模式仍按环境、用户、个人/企业身份绑定实例，并串行运行任务。成功任务在进程清理、持久化提交和 idle 心跳确认后允许复用；运行过 shell 本身不再强制销毁。失败、取消、无法证明清理完成或超时仍销毁实例。默认空闲回收为 120 秒；平台 TTL 为 30 分钟，活跃工作按既有规则续期。实例不跨用户共享，也不承诺永久存在。

## 接口与认证

本次没有新增或修改客户端接口、请求字段、响应字段及错误码；`/api/cloud/v1` 协议版本仍为 1。

现有 `GET /api/cloud/v1/capabilities` 无请求体，使用 `Authorization: Bearer <accessToken>`。返回外层保持：

```json
{"code":0,"message":"success","data":{"protocolVersions":[1],"environmentId":"<环境ID>","admission":{"available":false,"reason":"CLOUD_CONFIGURATION_MISSING","retryAfterMs":3000}}}
```

以上仅展示相关字段，完整字段保持既有协议；`reason` 根据实际配置和验收状态返回。后续云接口继续携带 `X-Cloud-Environment-Id`。云协议不回退使用 Cookie/Session；Portal 既有登录与用户接口的 Cookie/Session 认证不变。本次不要求 Portal 新增云执行入口。

`isolationMode` 属于服务端发布清单，不是客户端可提交的任务参数。客户端不得持有云账号、Worker 或管理凭据。

## 客户端事项

- 继续以 `capabilities.admission.available` 决定是否允许新执行，不因升级服务端就假定云功能可用。
- `persisting` 仍属于未完成状态，继续按既有事件/查询协议等待终态；进程停止不代表产物与 checkpoint 已提交。
- 展示持久化任务与会话状态，不把沙箱实例 ID 或临时磁盘当作用户永久工作区。已完成轮次的恢复仍走既有 checkpoint 协议。
- 无需为本次适配增加新请求头、参数或 UI 开关；现有客户端可继续使用旧发布版本。

## 发布顺序与限制

先部署兼容服务端，再构建新的 `cloud-2026.11.1` Runner 镜像。使用新镜像 digest 和新发布清单，显式设置：

```json
{"isolationMode":"provider-subreaper-v1","cgroupRoot":""}
```

旧 r3 镜像不含新实现，不能仅改清单将其当作新版本。模式进入发布身份，不能原地修改已发布版本。本次没有改变现有功能开关默认值，也没有自动生成安全验收证明。

准入前仍需验证目标平台的进程能力、网络隔离、Chromium sandbox、模型/工具执行和持久化链路。进程回收不等于网络隔离或全盘重置；未满足条件时继续保持准入不可用，不设置未经验证的 `CLOUD_ISOLATION_VERIFIED=true`。

## 验证结果

- `./gradlew compileJava -x test`：通过；按服务端仓库约定未运行服务端测试。
- `npm --prefix cloud-runtime run check`：通过。
- 本地 AMD64 Linux 隔离容器：9 项进程测试全部通过、零跳过，覆盖降权、描述符隔离、双重 fork/setsid、clone、取消、串行复用、监管器死亡、exec 失败、优雅退出和实时信号。使用缓存镜像依赖与只读挂载的新源码，不是新镜像发布验收。
- 本消费项目只增加本文档，未执行客户端测试。

实现与部署细节见服务端仓库 `cloud-runtime/README.md`。
