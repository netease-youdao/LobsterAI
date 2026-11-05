# 云端 Agent 加固接入说明（2026-11-03）

状态：服务端代码已实现，尚未发布；不要求本项目同步增加云入口。手机源码不在本次范围。

## 变更概要

服务端保留原登录、刷新、注销、模型代理的路径和认证方式。本轮修复生产JWT配置、退出token撤销有效期、日志脱敏，以及云运行的后台收尾、存储和监控。

## 共用认证接口

`POST /api/auth/logout`：原Cookie/session注销流程保持。可以附 `Authorization: Bearer <token>`，无需请求body，服务端验签后将这枚token加入黑名单直到原exp加容差。无token/无效/过期token按原未登录幂等处理。

```json
{"code":0,"message":"success","data":null}
```

本接口仅撤销显式提供的那枚token。提交access token不等于撤销关联refresh token或其他设备；客户端仍清理本地凭据。不得向用户宣称已“所有设备退出”。Redis撤销失败仍是失败，不伪报服务端已退出。

## 客户端事项

现有登录、刷新及Cookie/session参数无需变更。JWT调用方若调用注销，附当前Bearer；只使用Cookie的Portal保持原流程。错误日志只保存operation、HTTP/code/reason、耗时与可选diagnosticId，不保存token、prompt、文件正文或完整签名URL。

云REST消费者可在 `/api/cloud/v1/capabilities` 公告 `errorContractVersions:[1,2]` 后选用 `X-Cloud-Error-Contract: 2`；未公告/旧服务不发送。缺省v1不变，新增诊断与退避字段可选。不得把可重试HTTP错误理解为可重新执行模型/工具。

## 发布与兼容注意

生产服务改为显式注入JWT_SECRET，上线前部署方先设置当前安全有效密钥；不自动换key导致全部客户端掉线。需要轮换时另行制定兼容与重新登录策略。Web来源需配置服务端cloud.websocket.allowedOrigins；原生客户端不受CORS约束。

先扩展MySQL5.7兼容schema，再排空旧云后台协调器/GC、部署兼容v1控制面与固定版本Runner，验证后开放新准入；仅新增DDL不能令旧GC理解新保护字段。客户端不需与服务端同时发布。

本项目本轮只有文档交付，未执行客户端测试。服务端测试按仓库约定未运行，编译与真实环境验收状态见服务端 `docs/implementation/2026-11-03-cloud-agent-hardening.md`。
