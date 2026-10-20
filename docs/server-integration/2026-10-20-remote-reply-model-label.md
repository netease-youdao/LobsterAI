# 回复模型标签与桌面一致

## 变更摘要

桌面远程消息投影复用桌面回复的模型标签规则，将本条消息持久化的实际模型写入 `message.inputModel.displayName`。模型目录和 `session.inputModel` 仍代表当前输入选择，保留“快速/旗舰”。

本次主要更新 LobsterAI 客户端。服务端现有实现已支持该字段，只补充协议说明、Spec 和回归源码，不新增接口、字段、开关或数据库迁移。

## 接口与数据

继续使用既有消息批量同步、历史导入和 `/api/remote/v3/sync/live-projections`；读取仍为 `/api/remote/v1/sessions/{id}/snapshot`、消息分页/单条和 WSS。

消息中的模型摘要示例（其他字段保持原值）：

```json
{
  "inputModel": {
    "modelRef": "original_opaque_reference",
    "version": "3",
    "source": "subscription",
    "displayName": "deepseek-flash",
    "providerLabel": "LobsterAI",
    "thinkingLevel": null
  }
}
```

如果该消息的桌面标签包含预设，则同步相同标签，例如 `快速（deepseek-flash）` 或 `旗舰（glm-5.3）`。没有实际模型证据时保留原安全摘要，不根据当前模型目录猜测历史模型。消息缺少本轮冻结选择时，不从当前会话拼造 `modelRef` 或版本。

HTTP 与 WSS 投影 v2–v5 保留模型摘要；v1 沿用原规则剥离。模型摘要是展示信息，不改变模型选择、实际调用、计费或授权。

## 客户端行动项

- 旧批量同步与新版 live 投影统一使用共享的消息模型标签函数，后台 worker 携带桌面预设名称快照，避免语言不一致。
- 只使用消息自身模型元数据和本轮冻结的输入摘要，保持 `modelRef/version/source/providerLabel/thinkingLevel`。
- 实际模型晚到时使用完整消息更新。旧版批量同步自然提升消息 revision，模型摘要变化不能只发布正文 delta。
- 手机回复直接显示消息的 `inputModel.displayName`，不要用会话或目录中的“快速/旗舰”覆盖它；输入选择器继续读取会话/目录。
- 已确认的最近消息通过现有有界 live 候选窗口做显示修复；使用新 publicationId、相同来源版本和 `expectedProjectionRevision` 的 CAS，不改写已有不可变请求，不重复执行任务。仅在服务端支持原请求核对/封闭时执行旧消息修复；CAS 冲突核对原请求后停止该来源版本的自动修复。窗口外旧历史不承诺自动全量回填。
- 手机 App 源码本地不可用，本次没有修改 App。若其实现优先取当前会话标签，需要移动端按上述字段优先级接入。

## 认证与兼容

沿用 JWT Bearer、设备凭据、owner/空间/连接代次和手机读取授权，不新增认证方式。模型名经过已有远端显示边界处理，不发送 provider URL、API key 或完整配置。

既有服务端可接收新标签，无需为本次修改部署服务端运行代码，也不涉及 MySQL 5.7 DDL。先升级桌面，再等待消息同步及手机缓存按消息 revision 刷新；服务端不把历史标签回填成当前路由结果。

## 验证范围

验证覆盖快速/旗舰、纯实际模型、自定义供应商名称保留、流式标签更新、历史模型隔离、不同账号、缺少实际模型、worker 语言及协议兼容。服务端只编译回归源码，不执行测试。手机真机展示与线上环境尚需联调。
