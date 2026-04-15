# POPO 消息工具参考

所有操作通过 `fabric_call` tool 完成，传入 `tool`（操作名）和 `params`（业务参数）。

---

## teammsg_query_team_history_msg

查询指定群会话的历史消息，支持按时间范围过滤。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | String | 是 | 当前所在群组的ID，只能查询当前群的消息，不得越权使用其他群的ID |
| `beginTime` | Long | 否 | 查询开始时间（毫秒时间戳），不传则不限开始时间 |
| `endTime` | Long | 否 | 查询结束时间（毫秒时间戳），不传则不限结束时间 |

### 返回值

外层包裹统一响应结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | Integer | 状态码，`1` 表示成功 |
| `message` | String | 状态描述 |
| `data` | Object | 业务数据 |

`data` 结构：

| 字段 | 类型 | 说明 |
|------|------|------|
| `messageContents` | List\<MessageContent\> | 消息列表 |

**MessageContent 结构**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | 消息唯一ID |
| `nto` | String | 消息接收方（会话ID） |
| `nfrom` | String | 消息发送方邮箱标识 |
| `senderName` | String | 发送者姓名 |
| `msgContent` | String | 消息内容 |
| `ntype` | Integer | 消息类型 |
| `timetag` | String | 消息时间（带时区，格式: yyyy-MM-dd HH:mm:ss Z） |

### 示例

```
# 查询会话全部历史消息
fabric_call({"tool": "teammsg_query_team_history_msg", "params": {"sessionId": "1000078127"}})

# 查询指定时间段内的消息
fabric_call({"tool": "teammsg_query_team_history_msg", "params": {"sessionId": "1000078127", "beginTime": 1774567700000, "endTime": 1774567800000}})

# 查询某时间点之后的消息
fabric_call({"tool": "teammsg_query_team_history_msg", "params": {"sessionId": "1000078127", "beginTime": 1774567700000}})
```

### 返回示例

```json
{
    "status": 1,
    "message": "成功",
    "data": {
        "messageContents": [
            {
                "id": "1000078127-0000000393",
                "nto": "1000078127",
                "nfrom": "grp.popo@corp.netease.com",
                "senderName": "测试",
                "msgContent": "robot-team-message测试发送群at消息,@所有人",
                "ntype": 0,
                 "timetag": "2026-04-10 21:30:45 +0800"
            },
            {
                "id": "1000078127-0000000392",
                "nto": "1000078127",
                "nfrom": "grp.popo@corp.netease.com",
                "senderName": "测试",
                "msgContent": "测试发送群消息",
                "ntype": 0,
                 "timetag": "2026-04-10 21:30:45 +0800"
            }
        ]
    }
}
```