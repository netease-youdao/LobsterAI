# 用量明细跳转并展开当前轮次

## 变更说明

客户端个人账户的「用量明细」链接携带当前轮次的 traceId。Portal 通过 Server 查找账本中的真实 sessionId、日期范围和分页，展开目标会话及轮次，并滚动到目标轮次。普通会话、原生定时任务和 IM 使用同一定位流程；不依赖客户端本地会话 ID 与账本 ID 相同。

## 链接格式

`/portal#/profile?tab=used&usageTrace=0123456789abcdef0123456789abcdef`

- 生产和测试环境分别沿用客户端现有 Portal 地址配置。
- usageTrace 必须是非全零的 32 位小写十六进制 traceId。
- URL 不包含用户输入、会话标题、用户 ID 或登录凭据。
- 未登录时沿用 Portal 的登录 redirect，登录后保留定位参数。
- 企业账户继续使用原有企业成员用量入口，本次仅扩展个人账本定位。

## 新增接口

`GET /api/user/usage-conversations/locate`

查询参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| traceId | 是 | 当前轮次 ID，按个人账本 turn_id 查询 |
| sessionPageSize | 否 | 会话分页大小，默认 10，范围 1–100 |
| turnPageSize | 否 | 轮次分页大小，默认 20，范围 1–100 |

认证：沿用个人中心 Cookie/Session，通过当前请求解析 userId；所有查询均限定该用户，不接受 URL 指定用户。请求无 body。

成功示例：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "found": true,
    "sessionId": "cron:example-job-id",
    "turnId": "0123456789abcdef0123456789abcdef",
    "startDate": "2026-10-21",
    "endDate": "2026-10-21",
    "snapshotId": "12345:80",
    "sessionPage": 2,
    "turnPage": 3
  }
}
```

未找到时 code 为 0，data.found 为 false，其他字段不应读取。未关联旧记录、尚未同步的记录和其他账户的记录均无法定位。未登录返回 code=-1；参数非法沿用 INVALID_PARAMETER。

日期范围来自目标轮次在账本中的最早/最晚调用日期，沿用 Asia/Shanghai 口径，可包含跨日执行。页码按现有列表相同的排序及同时间排序规则计算，定位和后续列表必须使用同一 snapshotId。

## 前端接入

1. Electron 的 TurnUsageChip 个人账户入口使用 getPortalTurnUsageUrl(turnUsage.traceId)。
2. Portal 读取 usageTrace 后调用 locate，使用返回的日期、snapshotId 和 sessionPage 请求会话列表。
3. 展开 sessionId 对应会话，以 turnPage 加载轮次，展开 turnId 对应轮次及现有逐次调用明细并滚动定位。
4. 刷新时重新定位；用户手动改日期或列表页码后退出自动定位，保持用户选择。
5. 未找到或定位接口失败时保留正常用量列表并显示重试入口。旧 Server 未提供该接口时也可继续查看正常列表。

## 发布与验证

- 发布顺序：Server → Portal → Electron；旧版接口、无定位参数链接保持兼容，无新增 DDL 或历史回填。
- 只完成本地 lint/build 检查，未进行浏览器、真实登录或在线联调验证。
- 代码尚未提交或推送。本次 Server 改动位于独立工作区：
  `/Users/admin/.codex/worktrees/usage-deep-link/lobsterai-server`，分支 `feat/native-session-usage`。
