---
name: connector-feishu
description: 查询飞书消息、文档和日历，管理工作区任务。
version: 1.0.0
homepage: https://github.com/larksuite/cli
---

用官方 CLI `npx --yes @larksuite/cli@1.0.100` 操作用户已授权的飞书账号。下文子命令均追加在这个命令后。

先查对应命令的 --help 或 schema，按用户授权选择用户身份。auth status --verify --json 检查用户授权。

使用前确认目标工作区、仓库或组织。只有用户要求发送、修改或删除时才执行相应写操作。凭据由官方 CLI 管理，避免读取或输出 Token。授权到期时，引导用户回到 LobsterAI 的飞书连接器重新连接。
