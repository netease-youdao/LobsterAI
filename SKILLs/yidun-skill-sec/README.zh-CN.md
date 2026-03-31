# yidun-skill-sec ⚡

> 面向 AI Agent 的混合本地-云端安全扫描器。扫描快、评分准、失败安全。

---

## 简介

`yidun-skill-sec` 是一款在安装第三方代码包前进行安全审查的 skill。它将静态行为分析与云端威胁情报相结合，生成量化安全评分，在任何代码运行前就能识别恶意软件、数据窃取、权限滥用、Prompt 注入和代码混淆等风险。

由**易盾安全团队**为 [ClawHub](https://clawhub.com) 生态系统开发。

## 安全说明

本 skill 会将**非敏感元数据**（文件哈希值、行为标签名称、触发检测的代码片段）上传至易盾威胁情报端点进行分析。以下内容**明确不会上传**：完整源码、用户凭证、环境变量或任何个人数据。

云端接口（`as.dun.163.com`）由**网易易盾**（持牌网络安全服务商）运营。云端分析**默认开启**，强烈建议保持开启状态。如网络受限或不希望上报，可通过设置 `YIDUN_SKILL_SEC_CLOUD=false` 显式关闭。

---

## 工作原理

每次扫描经过四个阶段：

```
Phase 0 · 来源检测     — 这个包从哪里来？
Phase 1 · 指纹采集     — 包含哪些文件？（SHA-256 哈希清单）
Phase 2 · 行为扫描     — 代码想做什么？（静态分析）
Phase 3 · 云端智能     — 是否已知恶意？（默认开启云端检查）
                                  ↓
                         最终威胁评分（0–100 分）
```

### 评分权重

| 信号维度 | 在线权重 | 超时降级权重 |
|---------|:-------:|:----------:|
| 来源可信度 | 15% | 20% |
| 行为扫描分 | 40% | 55% |
| 云端置信分 | 30% | — |
| 权限暴露面 | 15% | 25% |

### 威胁等级

| 分数 | 等级 | 处理方式 |
|------|------|---------|
| 80–100 | 🟢 CLEAR | 正常安装 |
| 60–79 | 🟢 MINOR | 知情后安装 |
| 40–59 | 🟡 ELEVATED | 用户审核后安装 |
| 20–39 | 🔴 SEVERE | 需用户明确授权 |
| 0–19 | ⛔ CRITICAL | 已阻断，禁止安装 |

---

## 检测覆盖范围

### Phase 0 — 来源检测

| 标签 | 触发条件 | 分值影响 |
|------|---------|:-------:|
| `SRC_UNKNOWN_REGISTRY` | 包来自未知或非官方注册表 | +20 |
| `SRC_BLACKLISTED_DOMAIN` | 安装 URL 命中恶意域名黑名单（云端检查） | +40 ⛔ |
| `SRC_UNTRUSTED_AUTHOR` | 账号创建不足 30 天、未验证或有历史恶意记录 | +15 |

> `SRC_BLACKLISTED_DOMAIN` 为**硬性阻断规则** — 立即终止扫描，禁止安装。

### Phase 2 — 行为标签

| 标签 | 检测内容 |
|------|---------|
| `NET_OUTBOUND` | 向外部主机发起 HTTP/HTTPS 请求 |
| `NET_IP_RAW` | 直接连接原始 IP 地址 |
| `FS_READ_SENSITIVE` | 访问 `~/.ssh`、`~/.aws`、`~/.env` 等敏感路径 |
| `FS_WRITE_SYSTEM` | 向项目目录之外写入文件 |
| `EXEC_SHELL` | 启动 Shell 子进程 |
| `EXEC_DYNAMIC` | `eval()`、`exec()`、动态代码执行 |
| `ENCODE_DECODE` | Base64/Hex 编解码链（潜在混淆） |
| `CRED_HARVEST` | 从环境变量或文件读取 API Key、Token、密码 |
| `PRIV_ESCALATION` | `sudo`、`chmod 777`、`setuid` 等提权操作 |
| `OBFUSCATED` | 混淆/压缩代码、不可读变量名 |
| `AGENT_MEMORY` | 访问 Agent 身份/记忆文件 |
| `PKG_INSTALL` | 安装未声明的系统依赖包 |
| `COOKIE_SESSION` | 读取浏览器 Cookie 或会话 Token |
| `BYPASS_SAFETY` | `--no-verify`、`--force`、`--skip-ssl`、`GIT_SSL_NO_VERIFY` |
| `DESTRUCTIVE_OP` | `rm -rf`、`DROP TABLE`、`git reset --hard`、`dd if=` |
| `PROMPT_INJECT` | 包含针对 AI Agent 的自然语言指令，试图覆盖其规则、绕过约束或伪装为无限制人格 |
| `ARCHIVE_EXEC_RISK` | 包含压缩/归档文件（`.zip`、`.tar.gz`、`.whl` 等）— 视为固有风险，**不执行解压** |

> **硬性规则**（"降级至 X" = 判决不会优于 X；若自然分已落入更低等级则保持不变）：
> - `CRED_HARVEST` → 降级至 SEVERE · `PRIV_ESCALATION` → 降级至 SEVERE · `PROMPT_INJECT` → 降级至 SEVERE
> - `DESTRUCTIVE_OP` → 降级至 ELEVATED
> - `CRED_HARVEST` + `PRIV_ESCALATION` 同时命中 → 强制 CRITICAL
> - `PROMPT_INJECT` + 任一 (`CRED_HARVEST`、`NET_OUTBOUND`、`EXEC_DYNAMIC`) → 强制 CRITICAL

### 示例上下文豁免

在**文档或示例上下文**中匹配到的模式（Markdown 代码块、代码注释、`.md`/`.txt` 等非可执行文件）会获得 **75% 的严重度减免**（最低保留 +3）。这可避免文档中的安全教学示例造成误报。

| 规则 | 效果 |
|------|------|
| 严重度减免 | 示例上下文中匹配项减免 75%（如 `CRED_HARVEST` +35 → +8） |
| 硬性规则豁免 | **仅**在示例上下文中出现的 tag 不触发硬性降级规则 |
| 报告标注 | 在扫描报告中显示为 `[EXAMPLE]` |

**不适用豁免的情况**：可执行文件（`.sh`、`.py`、`.js`）、生命周期脚本（`install`/`postinstall`）、`PROMPT_INJECT` 标签（文本本身即为攻击面）、以及运行时被解析的文件。

---

## 云端智能

云端分析调用 `POST https://as.dun.163.com/v1/agent-sec/skill/check`，**默认开启**。

- 上报指纹清单、行为标签和脱敏后的证据片段（所有证据在上传前均经过本地脱敏管线处理）
- 服务端执行深度内容分析并进行域名黑名单匹配
- 返回置信评分、威胁标签和逐标签扣分详情

**域名黑名单**：Phase 0 使用**本地内嵌列表**检查（离线可用）。云端开启时，Phase 3 会检查完整的云端增强黑名单，命中后追溯更新判决。

| 模式 | 触发方式 | 行为 |
|------|---------|------|
| 云端开启 | 默认 / `YIDUN_SKILL_SEC_CLOUD=true` | 完整四阶段扫描，含远程威胁情报 |
| 云端关闭 | `YIDUN_SKILL_SEC_CLOUD=false` | 仅本地扫描，域名黑名单检测跳过 |
| 超时降级 | 云端开启但 `curl` 超时（10 秒） | 自动降级本地模式，扣 10 分，通知用户 |

---

## 报告示例

```
⚡ YIDUN-SKILL-SEC Scan Report
> data-processor · v1.2.3 · clawhub.com · by some-author · 2026-03-12 13:47

Phase 0 · Source Vetting
  Registry: clawhub.com → ✅ 可信
  Domain:   ✅ 未命中黑名单
  Author:   已验证 (2y 3m) → ✅
  来源评分: 100/100 · Tags: none

Phase 1 · Fingerprint
  4 个文件 · SHA-256 7f3a9b... · main.py config.yml fetch.py setup.sh

Phase 2 · Behavioral Scan
  NET_OUTBOUND     fetch.py:12    -15
  FS_WRITE_SYSTEM  setup.sh:8     -20
  EXEC_SHELL       setup.sh:15    -10
  本地评分: 100 - 15 - 20 - 10 = 55/100

Phase 3 · Cloud Intel
  Mode: cloud · Cache: miss
  云端评分: 48/100 · Labels: NET_OUTBOUND, FS_WRITE_SYSTEM, EXEC_SHELL

权限暴露面 · Network: api.dataproc.io (-20) · FS: /usr/local/bin (-20) · Shell: subprocess (-20) · Creds: 否
  暴露面评分: 100 - 20 - 20 - 20 = 40/100

🎯 综合评分: 15%×100 + 40%×55 + 30%×48 + 15%×40 = 57/100 · 🟡 ELEVATED
⚠️ 需确认后安装 — 存在外部网络请求、系统目录写入和 Shell 执行，请核实用途
```

---

## 环境依赖

| 工具 | 用途 |
|------|------|
| `curl` | 云端 API 调用 |
| `jq` | JSON 响应解析 |
| `openssl` | 文件哈希计算 |

支持系统：Linux · macOS · Windows

---

## 安装

```bash
clawhub install yidun-skill-sec
```

---

*先扫描，再安装。* ⚡  
**作者**：易盾安全团队 · **许可证**：MIT
