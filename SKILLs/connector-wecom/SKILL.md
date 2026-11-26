---
name: connector-wecom
description: 在授权范围内查询和管理企业微信文档、日程、待办及通讯录。
version: 1.0.0
homepage: https://github.com/WecomTeam/wecom-cli
---

用官方 CLI `npx --yes @wecom/cli@1.3.4` 操作用户已授权的企业微信账号。下文子命令均追加在这个命令后。

使用命令的 --help 逐级发现文档、日历和通讯录操作。用 auth show 检查授权，未绑定时请用户从连接器卡片扫码。

使用前确认目标工作区、仓库或组织。只有用户要求发送、修改或删除时才执行相应写操作。凭据由官方 CLI 管理，避免读取或输出 Token。授权到期时，引导用户回到 LobsterAI 的企业微信连接器重新连接。
