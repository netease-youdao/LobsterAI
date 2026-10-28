# 快速／旗舰输入选择同步修复（2026-10-28）

## 变更摘要

桌面选择快速／旗舰时，本地保存的是预设身份和已解析的实际模型。会话远程摘要应使用预设目录的 modelRef/version；历史回复继续使用各轮实际模型标签。只改显示名而保留底层模型引用会使手机错误改选，或让 keep_session 准备校验不一致。

本项无需新增服务端接口、字段、能力或数据库迁移。证据、完整请求样例、边界和验证记录见服务端[接入说明](../../../lobsterai-server/docs/integration/2026-10-28-remote-preset-selection.md)。

## 接口与认证

- `GET /api/remote/v1/devices/{deviceId}/models`：现有模型目录，按 deviceId + modelRef + version 区分预设与具体模型。
- `GET /api/remote/v1/sessions/{sessionId}/snapshot`、会话列表及事件：消费 session.inputModel 和 inputVersion，不用消息标签恢复输入选择。
- `POST /api/remote/v1/devices/{deviceId}/input-preparations`：未显式改选时继续使用 keep_session；resolvedInput.model 固定同一预设引用。完整请求／响应见[输入 v2 API](../../../lobsterai-server/docs/api/mobile-remote-input-v2.md)。

保留 JWT Bearer、桌面设备凭据、当前连接、账号 scope、目标设备和控制权限校验。显示名称和预设身份都不是执行许可，不传 provider 配置、API key、baseURL 或内部 runtimeRef。

## 客户端行动项

1. 输入框按 session.inputModel 匹配该电脑目录中的预设条目；消息底部使用 message.inputModel.displayName，不从实际模型名反推快速／旗舰。
2. 预设会话 keep_session 的线上选择与本机实际执行绑定分别固定、分别校验；不重选路由，不在准备后更换模型或原请求摘要。
3. 预设没有思考选项时摘要 thinkingLevel=null，手机隐藏档位控件；未显式选档位的续聊可使用本机已固定档位。显式档位必须保留原值并通过预设及实际模型能力检查。非空线上档位与实际执行值必须一致。
4. 接收正常递增的 inputVersion。旧准备遇版本冲突需重新准备，不原地改写准备单。缺少预设目录或绑定证据时不回退成另一个模型。
5. 本任务不修改手机源码；若 App 缓存或消息合并覆盖了当前选择，应按本契约修正。

## 发布与验收

升级桌面修复版本，保留旧服务端接口及 MySQL 5.7 兼容；Portal/Admin 无动作，与其他改动合包时仍遵循各自发布要求。测试包括快速／旗舰、普通模型、续聊、旧摘要修正、思考档位空选项与显式选择、配置和账号变化。安装包真机验收应确认手机输入框保留预设，续聊实际模型及原有配置正确，历史回复标签不被重写。
