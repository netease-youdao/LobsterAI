---
name: connector-github
description: 通过 GitHub CLI 管理仓库、Issue、Pull Request 和 Actions。
version: 1.0.0
homepage: https://cli.github.com/manual/
---

用官方 CLI `gh` 操作用户已授权的GitHub账号。下文子命令均追加在这个命令后。

用 gh auth status --hostname github.com 核对登录状态。使用 gh search prs、gh pr list、gh issue list、gh run list 等官方子命令。明确仓库后使用 --repo OWNER/REPO，并优先选取需要的 --json 字段。

使用前确认目标工作区、仓库或组织。只有用户要求发送、修改或删除时才执行相应写操作。凭据由官方 CLI 管理，避免读取或输出 Token。授权到期时，引导用户回到 LobsterAI 的GitHub连接器重新连接。
