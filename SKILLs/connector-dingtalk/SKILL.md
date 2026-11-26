---
name: connector-dingtalk
description: 查询钉钉联系人、日程、文档及待办。
version: 1.0.0
homepage: https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli
---

用官方 CLI `npx --yes dingtalk-workspace-cli@1.0.70` 操作用户已授权的钉钉账号。下文子命令均追加在这个命令后。

用 calendar event list 查询日程，用 contact user search --query 查询联系人。先通过 --help 确认参数。使用默认已授权账号；多账号时先确认组织。设置 DWS_NO_SKILLS=1 避免重复安装指南。

使用前确认目标工作区、仓库或组织。只有用户要求发送、修改或删除时才执行相应写操作。凭据由官方 CLI 管理，避免读取或输出 Token。授权到期时，引导用户回到 LobsterAI 的钉钉连接器重新连接。
