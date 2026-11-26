# 认证指南

本指南介绍 bdpan CLI 的登录认证流程，需使用 **3.9.0 或更新版本**。主动登录和业务触发的重新授权均走 `response_type=cli` 统一入口，不回退到旧 token 授权回调；已有有效凭据仍可复用和刷新。

---

## 登录方式

> **安全约束：** 主动登录须通过 [login.sh](../scripts/login.sh)，遵守 [SKILL.md](../SKILL.md) 的「登录确认」。领取、刷新与保存由 CLI 完成，Skill 不读取凭据文件。

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/login.sh              # 主动登录
# 仅本会话、同一授权流程已明确同意时：
bash ${CLAUDE_SKILL_DIR}/scripts/login.sh --confirmed
```

普通业务直接调用 CLI，记忆操作仍使用原包装脚本，不增加登录预检。正文搜索例外：先用 `login.sh --continue-task` 准备凭据，成功后查询会员再搜索。

所有 `bdpan` 调用（含 `whoami`）附加 `--auth-flow cli --skill-name baidu-drive --skill-version "<本 Skill 的 VERSION 实际值>"`；包装脚本自行透传。同一流程已确认时，业务命令加 `--auth-confirmed`；新会话无确认记录则不带确认标记。已有有效凭据或已有 key 的单次领取无需重复确认，旧 `--yes`、`--accept-disclaimer` 不替代本会话确认。

| 结果 | 处理 |
|---|---|
| 登录退出码 0、`code=0`、`data.status=authenticated` | 凭据可用；主动登录展示 CLI 返回的 `data.message`：已登录时使用“您已登录百度网盘，无需重复授权。现在可以直接说：”，新登录成功时使用“登录成功，现在可以使用百度网盘了。您可以直接说：”，随后展示完整五条 `data.examples`。`--continue-task` 成功时静默；业务结果按各命令原有格式处理 |
| `confirmation_required` | 先说明 CLI 已明确给出的链接过期或授权失效原因（如有），再按 SKILL.md「登录确认」的固定话术说明权限和安全须知，结束本轮等待普通对话中明确回复同意或取消；不用弹窗或选择按钮。确认后的新入口由 CLI 在 `data.message` 中带上原因，原样展示，不重复补充。 |
| `authorization_required` | 同一条回复展示完整 `data.auth_url`、CLI 说明和全部五条 `data.examples`，随后结束本轮 |
| `upgrade_required` | 展示 Skill 升级提示，按原有更新规则取得用户同意；不静默更新，检查最低版本及实际分发包是否支持新流程 |
| 暂时无法查询或领取（网络、服务异常） | 原样展示 CLI 的“暂时无法检查百度网盘授权，请稍后重试本次请求。”并停止；不当作未登录，不自动 logout、清理配置或重新申请链接 |
| 保存或格式错误 | 提示真实原因并停止，处理方式同上 |

每次新发或换发入口，都使用以下固定话术；CLI 已明确给出的过期或失效原因放在话术前：

> 当前任务尚未执行。请打开以下链接完成百度网盘授权：〔最新授权链接〕。页面显示“授权成功”后，回到这里直接发送需求或“继续刚才的任务”。如收到多个链接，请使用最新一次的链接。完成授权后，你可以直接发送以下需求：〔使用示例〕

〔最新授权链接〕使用 CLI 返回的完整 `data.auth_url`，放在代码块外，按 `[点击此处完成授权登录](URL)` 展示；〔使用示例〕替换为完整五条 `data.examples`。服务端链接即使含 key 也原样展示，不单独读取或输出 key、code、Token。

支持本地、SSH、容器、跨设备和无图形环境。CLI 返回后不等待网页、不轮询；每次用户请求最多领取一次、按需申请一次。网页成功不表示原任务已执行；用户下一条需求才继续，无需回复“已授权”。恢复原任务时保留对象、目标与条件，有歧义先澄清。

---

## 验证登录状态

```bash
bdpan whoami --json --no-check-update
```

`whoami` 仅查询状态，不领取待授权 key，适用于单纯状态查询和卸载预览。顶层 `authenticated` 与 `has_valid_token` 均为 `true` 才表示可复用登录态；失败或字段异常不能当作未登录。访问 Token 临期时沿用 CLI 自动刷新，Skill 不自行管理凭据。

---

## 常见问题

- 网页已授权但业务未执行：直接发送下一条业务需求，由 CLI 单次领取后执行，不重复发起登录。
- 链接过期或失效：下次请求按 CLI 返回处理；新发入口仍遵守本会话确认规则，并完整展示最新入口。
- CLI 版本过低：提示需要 3.9.0 或更新版本，仅在用户明确要求并确认后执行 `bdpan update`，更新后复查版本。

---

## 注销登录

```bash
bdpan logout
```

清除本地 Token 和待领取 key。配置文件默认为 `~/.config/bdpan/config.json`，目录可由 `BDPAN_CONFIG_DIR` 指定；凭据加密保存，禁止读取或输出配置内容。
