# PPTX 空目录校验修复接入与恢复说明

日期：2026-10-29。仅 `lobsterai-server` 运行代码变更；App 源码不在本次范围。

## 1. 变更摘要

合法 PPTX 的零字节 `ppt/embeddings/` 目录占位不再误报 `FILE_CONTENT_INVALID`。DOCX/XLSX 对应空目录使用同一检查。仅精确标准目录且元数据/实际内容均为空可通过，原有真实嵌入、宏、OLE、ActiveX、外链和路径检查保留。

## 2. 接口与认证

所有接口、字段、状态和权限保持原合同。完整请求/返回见[文件 API](../../../lobsterai-server/docs/api/mobile-remote-files-api.md)。受影响的完成入口及后续步骤：

| 方法与路径 | 行为 |
| --- | --- |
| `POST /api/remote/v1/input-assets/{assetId}/complete` | 输入文件整体验证，适用本次修复 |
| `POST /api/remote/v1/artifact-uploads/{assetId}/complete` | 桌面输出整体验证，适用本次修复 |
| `POST /api/remote/v1/artifacts/{artifactId}/versions/{version}/publish` | 仍需独立完成既有发布校验，complete 成功不是已发布 |
| `GET /api/remote/v1/sessions/{sessionId}/artifacts/{artifactId}/versions/{version}/content` | 原鉴权内容读取，必须位于有权限的原会话上下文 |

使用原 `Authorization: Bearer <accessToken>`、`X-Remote-Device-Credential` 和已协商投影版本；桌面发布操作继续携带 `X-Remote-Connection-Generation`。账号/空间由认证推导，必须满足原设备、会话、文件、消息/run 和 grant 约束。手机不能代替桌面调用产物上传/发布端点。

complete 请求仍为 `Content-Type: application/json`：

```json
{"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

文件满足全部检查时响应仍是原 ready 结果，以下只节选相关字段：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "assetId": "existing-upload-id",
    "version": "1",
    "status": "ready",
    "mimeType": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  }
}
```

真实不允许内容继续返回 HTTP 415 / `FILE_CONTENT_INVALID`。策略版本、请求 ID/摘要幂等规则、捕获顺序和发布 CAS 均不变；不能自行将失败结果改成 ready。

## 3. App 与桌面行动项

- 新上传无需客户端协议适配。App 在产物已发布且有可读版本后，通过原鉴权接口下载/系统打开；不能凭文件扩展名、回复正文或分片上传成功显示可读。
- Office 仍按原下载/系统打开能力处理，本修复不提供新的手机内置 PPT 预览器。不要把 Bearer 或存储地址交给第三方预览网站。
- 已被桌面 `FILE_CONTENT_INVALID` 415 隔离的旧任务不会自动重试，手机刷新、桌面重启和普通“重试同步”均无法解除。原任务同路径重发也可能复用被隔离队列。
- 服务端全部实例升级后，新建任务并生成/交付新的 PPT 文件用于验收或应急。旧失败消息仍保留原状态；旧消息原位恢复需另行定点处理，不清空全部队列或修改服务端 ready 状态。

## 4. 发布与验证

先测试服验收，再发布正式服；两边不需要同时上线，但使用旧校验器的环境仍有误判。无需 App/桌面/Admin/Portal 同步发版，无数据库迁移。

生产源码和本次回归源码编译通过，独立静态安全审查完成；全量测试源码因既有 Apple 测试重载歧义未编译通过。按项目约定未执行服务端测试，未部署或完成手机实机验收。具体边界及操作见[修复 Spec](../../../lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-10-29-office-empty-embeddings-directory.md)。
