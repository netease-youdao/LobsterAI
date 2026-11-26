---
name: baidu-drive
description: 在用户授权后通过百度网盘官方 bdpan 浏览、搜索、分享及管理网盘文件，处理百度网盘登录和授权请求。
version: 1.7.8
homepage: https://github.com/baidu-netdisk/bdpan-storage
---

使用本技能目录内的官方登录与安装脚本。它们来自 baidu-netdisk/bdpan-storage，版本见 VERSION。命令在用户本机运行。

1. 检查 bdpan version。未安装或版本低于 3.9.0 时说明原因，用户同意后在临时目录运行本技能 scripts/install.sh（Bash），或由用户安装官方 CLI。
2. 主动登录执行 bash "<本技能目录>/scripts/login.sh"。复用或领取凭据由 CLI 完成。只有退出成功且 JSON 的 code 为 0、data.status 为 authenticated，才报告已登录。成功后展示返回的 message 和 examples。
3. 如返回 confirmation_required，展示官方安全须知并等待用户在当前对话确认：“仅在可信环境授权，以免网盘数据被窃取；在公共环境用完后请退出登录，备份重要数据并审核操作，请勿在对话或公开仓库中暴露凭证。”确认后才运行同一脚本加 --confirmed。返回 authorization_required 时展示 CLI 提供的官方授权链接、说明与示例，请用户在浏览器完成授权后回来继续。勿轮询、记录链接或要求用户粘贴凭据。领取失败或网络异常时显示失败原因。
4. 业务命令参见 reference/bdpan-commands.md，附 --auth-flow cli --skill-name baidu-drive --skill-version <本目录 VERSION 的值>。使用 reference/authentication.md 处理重新授权。用 ls、search、quota 查询时只传本次请求必要的参数。删除、覆盖或对外分享前核对具体文件和用户授权。
