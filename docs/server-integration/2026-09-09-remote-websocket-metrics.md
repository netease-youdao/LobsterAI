# 服务端远控 WebSocket 指标接入提示

日期：2026-09-09。消费端：LobsterAI 桌面、手机 App。

## 变更摘要

服务端通过已有 MetricLog 增加远控 WS 建立/关闭的吞吐趋势与耗时、当前在线连接数和固定原因分类。变更仅用于服务端监控，不新增客户端 API，不改变远控执行行为。

## 接口与认证

原有 `POST /api/remote/v1/connection-tickets` 和 `WSS /api/remote/v1/ws?ticket=...` 保持原路径及请求响应约定。HTTPS 票据申请继续使用现有 JWT/设备身份与凭证，WSS 继续使用返回的单次短期 ticket；没有新增监控请求头、消息字段或权限。

沿用现有 `hello`、心跳、订阅及恢复协议。客户端不发送计时样本或在线计数，不把长期 token/deviceKey 加入 URL。完整接口合同仍以服务端 [App 接入文档](../../../lobsterai-server/docs/api/mobile-remote-api.md) 为准。

## 客户端行动项

桌面和手机 App 无需修改代码或配合升级。无需重新注册设备、清理凭证、重建会话或重置事件水位。排查断线时，可结合服务端的建立/关闭和原因曲线定位；手机界面的电脑在线/可控状态继续使用原有服务端业务状态，不改用监控 Gauge。

## 说明与限制

在线 Gauge 是物理连接采样，SDK 每 30 秒导出；吞吐是每秒的一分钟平滑速率。图表不是客户端即时状态接口，也不是精确事件审计。混合版本滚动发布期间，新指标只覆盖已升级 Pod。

本次没有 DDL、协议版本、认证、ASR、Portal/Admin 变更。服务端生产代码及测试源码已通过离线编译，静态差异检查通过；新增 17 项用例仅编译，未执行服务端测试。尚未部署，采集平台和多 Pod 汇总需部署后另行核对。桌面项目仅增加本说明，无需执行客户端测试。

详见服务端 [WebSocket MetricLog 指标说明](../../../lobsterai-server/docs/architecture/remote-websocket-metrics.md)。
