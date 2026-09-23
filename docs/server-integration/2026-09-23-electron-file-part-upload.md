# Electron 文件分片上传修复

日期：2026-09-23。仅桌面运行代码变更，无服务端接口或数据库变更，未修改 iOS。

## 变更概要

输入附件和输出产物上传曾手动设置 Content-Length；真实 Electron 43.5.0 的 net.fetch 会报 net::ERR_INVALID_ARGUMENT，请求不能发出。已改为使用固定 ArrayBuffer，由网络层自动填写长度，保留逐片 SHA-256、octet-stream、身份/策略/版本及不可变快照检查。

受影响的已有接口：

- PUT /api/remote/v1/input-assets/{assetId}/parts/{partNo}
- PUT /api/remote/v1/artifact-uploads/{assetId}/parts/{partNo}

服务端仍要求收到正确 Content-Length 和 X-Content-SHA256；不要通过取消服务端校验解决客户端问题。JWT、设备凭据、同步目标及产物连接 generation 的认证行为不变，App 无需改协议。

## 客户端行为与诊断

两条链路保留原重试队列、快照、assetId 和 publicationId，不清数据库或重建任务。更新桌面并恢复有效连接后，可按原重试流程补传；服务端 complete/publish 成功后才显示可下载。

新增 [RemoteFileSync] Part request started/completed/failed 日志，包含资源/分片 ID、大小、耗时、HTTP 状态及脱敏网络错误码。最多解包四层 originalError/cause，不写 token、请求头、正文、文件名、完整 URL 或原始堆栈；不消费响应正文、不改变异常传播。

## 验证与发布

- 4 个测试文件、71 项通过，覆盖两条上传链路的精确字节与摘要、丢响应恢复、权限撤销、鉴权和日志脱敏。
- 6 个 TypeScript 文件 ESLint 通过；Electron 编译通过。
- 正式附件上传代码与鉴权包装经真实 Electron 调用本机模拟服务，9327 字节分为 4096 + 4096 + 1135，自动 Content-Length、原始字节与 SHA-256 全部校验通过。
- 测试库只读确认报障资产为 uploading 且成功分片为 0。未修改数据，未运行服务端测试，未部署或操作 Nginx，未安装到报障设备。
- 发布桌面后核验原队列补传、一个新输入附件和一个 Markdown 输出产物的 App 下载预览。无需本次服务端部署、数据库迁移或功能开关调整。真实 NOS 和手机联调仍需完成。
