# 远程会话保留原始业务更新时间

## Change Summary

服务端修复 Gateway 重启或重新同步后，手机历史会话时间全部变成同步时刻，以及单条已完成会话随后台消息投影同步约每分钟更新时间的问题。`updatedAt` 持久化桌面摘要中的原始业务时间，`syncedAt` 继续记录服务端接收同步时间，列表按业务时间排序。

不新增接口、字段、能力、配置或 DDL，兼容 MySQL 5.7。已有桌面和手机无需同步升级即可使用修复后的服务端。

## Endpoint Details

- 读取：`GET /api/remote/v1/sessions`、`GET /api/remote/v1/sessions/{sessionId}/snapshot`。
- 写入：既有批量同步、历史导入、控制 bootstrap/checkpoint、availability 发布接口，所有路径保留现有请求格式。
- 摘要示例：请求中的 `session.updatedAt` 保持真实业务时间，不能使用上传时间。

```json
{
  "session": {
    "createdAt": "2026-10-19T10:00:00.000Z",
    "updatedAt": "2026-10-19T10:05:00.000Z"
  }
}
```

以上仅展示请求摘要的时间字段，不是完整可提交请求。服务端列表响应中的对应字段：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [
      {
        "sessionId": "session_example",
        "createdAt": "2026-10-19T10:00:00.000Z",
        "updatedAt": "2026-10-19T10:05:00.000Z",
        "syncedAt": "2026-10-20T02:48:00.000Z"
      }
    ],
    "nextCursor": null,
    "serverTime": "2026-10-20T02:48:00.000Z"
  }
}
```

示例省略其他原有会话字段，正式响应保留全部既有字段。

## Frontend Action Items

- Electron 继续从 `cowork_sessions.updated_at` 生成摘要；既有 legacy 与 availability 路径已经如此，本次无需修改客户端实现。
- 不修改已封存的事件或重试请求。下一次新的有效摘要/控制 checkpoint 可纠正旧数据；仅重复已确认操作不会重新发布。
- App 用 `updatedAt` 显示会话更新时间，用 `syncedAt` 显示同步状态。不得将服务端时间或事件到达时间用作会话时间。
- 已污染时间可能向过去纠正，应接受按既有序号/版本判定有效的新快照，重新从第一页加载列表；不要将 `updatedAt` 当作版本号。
- App 源码本地不可用，以上供移动端联调检查，未声明已完成 App 改动或真机验收。

## Auth Requirements

认证保持既有远控协议：JWT Bearer、设备凭据及原有请求上下文字段；桌面发布检查当前 owner/空间/设备/连接代次，手机读取检查当前设备有效授权。Cookie 不替代远控凭据，不新增权限。

## Notes & Caveats

先更新全部服务端写节点，再正常触发桌面同步；旧节点仍会覆盖时间。无需数据库迁移或全库修补。尚未重新发布有效摘要的会话不会立即修正。只持续上报 `message.upsert` 的会话会停止继续变新，但原先被覆盖的时间仍要等新的有效摘要才能恢复。消息事件的 `occurredAt` 和列表的 `syncedAt` 都不能用于替代业务时间。

服务端 Spec：`lobsterai-server/docs/specs/mobile-remote-control/bugfix-2026-10-20-session-activity-time.md`。验收应比较重启前后多个不同历史时间的会话，并确认继续聊某个任务时只有该任务的业务时间推进。

追加验收：已完成会话连续至少三分钟产生新的消息投影版本，分别覆盖 batch 和 availability；确认消息版本、同步序号可增长，但会话 `updatedAt` 和列表位置保持不变。正常续聊并发布新摘要时，业务时间仍应更新。
