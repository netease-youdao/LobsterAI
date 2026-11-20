---
name: youdaonote
description: "有道云笔记官方 skill，支持笔记 CRUD（创建/读取/更新/删除）、待办管理、网页剪藏、笔记搜索、文件夹管理等基础操作。如需构建知识库或 Wiki，请使用 youdaonote-llm-wiki skill 而非本 skill。"
official: true
version: 1.0.10
minCliVersion: "1.3.3"
---

# YoudaoNote — 有道云笔记

通过 `youdaonote` CLI 操作有道云笔记。覆盖笔记 CRUD、待办管理、网页剪藏全场景。

## 前置条件（Agent 自动处理）

执行任何操作前，Agent 必须先运行 `youdaonote -s ydn list` 检测 CLI 是否可用：
- **`command not found`** → 立即跳转「CLI 未安装处理」自动安装，**禁止只展示安装步骤让用户手动操作**
- **`-s` 选项报错（`error: unknown option '-s'`）** → CLI 版本 < 1.3.2，不支持全局 `-s` 参数，需升级：先尝试 `youdaonote upgrade`；若不支持该命令，则按「CLI 未安装处理」中的安装方式重新安装；Windows 用户参考安装指南（https://note.youdao.com/help-center/cli-install-guide.html）
- **API Key 错误** → 提示用户访问 **https://mopen.163.com** 获取 API Key（须使用手机号登录，且云笔记账号已绑定手机号）。**用户必须在自己的终端中直接输入 API Key；Agent 不得索取、接收、读取或记录明文 API Key，也不得代替用户执行配置命令。** 请用户在自己的终端执行：

  ```bash
  read -rsp "YoudaoNote API Key: " YDN_API_KEY
  printf '%s\n' "$YDN_API_KEY" | youdaonote config set apiKey -
  unset YDN_API_KEY
  chmod 600 "$HOME/.youdaonote.json"
  ```

  Windows 用户也必须在 PowerShell 中通过交互式安全输入获取 Key，并以 stdin 调用 `config set apiKey -`，不得把 Key 作为命令参数；配置文件由用户配置目录的 ACL 保护。

  `config set apiKey -` 从 stdin 读取 Key，避免密钥进入对话、命令行参数或 shell 历史；`chmod 600` 确保 Unix 配置文件的权限仅保留给当前用户。**获取 API Key 的地址只有这一个，禁止告知用户其他地址。**
- **正常返回目录列表** → 运行 `youdaonote -s ydn version` 检查版本，若版本低于 `minCliVersion` 需要升级：CLI 支持 `upgrade` 命令时执行 `youdaonote -s ydn upgrade`，否则按「CLI 未安装处理」中的升级方式操作；Windows 用户或升级失败时参考安装指南（https://note.youdao.com/help-center/cli-install-guide.html）。版本满足要求后可运行 `youdaonote -s ydn help --json` 获取当前 CLI 全部能力的结构化描述（JSON），用于确认命令是否可用，下方速查表作为 fallback

## 全局参数

所有命令调用时**必须**加上 `-s ydn`，用于使用统计：

```bash
youdaonote -s ydn <command> [options]
```

## 命令速查

| 命令 | 用途 | 示例 |
|------|------|------|
| `mkdir` | 创建文件夹 | `youdaonote -s ydn mkdir "文件夹名" [-f <父目录ID>]` |
| `save` | 保存笔记（✅ 推荐，支持 Markdown 富文本） | `youdaonote -s ydn save --file note.json` |
| `create` | 创建笔记（⚠️ 仅纯文本，不支持 Markdown 富文本） | `youdaonote -s ydn create -n "标题" -c "内容" [-f <目录ID>]` |
| `update` | 更新 Markdown 笔记 | `youdaonote -s ydn update <fileId> -c "内容"` 或 `--file content.md` |
| `delete` | 删除笔记 | `youdaonote -s ydn delete <fileId>` |
| `rename` | 重命名笔记 | `youdaonote -s ydn rename <fileId> "新标题"` |
| `move` | 移动笔记 | `youdaonote -s ydn move <fileId> <目录ID>` |
| `search` | 搜索笔记 | `youdaonote -s ydn search "关键词"` |
| `list` | 浏览目录 | `youdaonote -s ydn list -f <目录ID>` |
| `read` | 读取笔记 | `youdaonote -s ydn read <fileId>` |
| `recent` | 最近收藏 | `youdaonote -s ydn recent -l 20 -c --json` |
| `clip` | 网页剪藏（服务端） | `youdaonote -s ydn clip "https://..." [-f <目录ID>] --json` |
| `clip-save` | 保存外部剪藏 JSON | `youdaonote -s ydn clip-save --file data.json` |
| `todo list` | 列出待办 | `youdaonote -s ydn todo list [--group <分组ID>] --json` |
| `todo create` | 创建待办 | `youdaonote -s ydn todo create -t "标题" [-c "内容"] [-d 2025-12-31] [-g <分组ID>]` |
| `todo update` | 更新待办 | `youdaonote -s ydn todo update <todoId> [--done] [--undone] [-t "新标题"]` |
| `todo delete` | 删除待办 | `youdaonote -s ydn todo delete <todoId>` |
| `todo groups` | 列出待办分组 | `youdaonote -s ydn todo groups --json` |
| `todo group-create` | 创建分组 | `youdaonote -s ydn todo group-create "分组名"` |
| `todo group-rename` | 重命名分组 | `youdaonote -s ydn todo group-rename <groupId> "新名"` |
| `todo group-delete` | 删除分组 | `youdaonote -s ydn todo group-delete <groupId>` |
| `upgrade` | 升级 CLI | `youdaonote -s ydn upgrade [--check] [--force] [--json]` |
| `check` | 健康检查 | `youdaonote -s ydn check` |
| `config show` | 查看配置 | `youdaonote -s ydn config show --json` |
| `config set` | 设置配置（Key 由用户经 stdin 输入） | 用户按「API Key 错误」中的安全配置命令操作 |

## 笔记管理

**默认创建方式**：所有笔记一律使用 `save` 命令 + `contentFormat: "md"` 保存为 Markdown 富文本。
**禁止使用 `create` 命令保存包含 Markdown 格式的内容**（标题、列表、代码块、表格等）—— `create` 仅支持纯文本，会静默丢失所有格式。HTML/结构化数据先转 Markdown 再用 `save` 保存。

### Markdown 内容格式选择（必须遵守）

当用户要保存的内容包含以下任意 Markdown 特征时（`#` 标题、`**粗体**`、`` ` ``代码块、`- ` 列表、`> ` 引用、`[链接](url)`、`![图片](url)`），**必须先停下来询问用户**，不得直接执行命令：

```
检测到内容包含 Markdown 格式，请选择保存方式：

A（推荐）保存为 Markdown 笔记（.md）
  → 格式完整保留，可在编辑器中正常显示和编辑

B  保存为有道专有格式（.note）
  → 支持有道云笔记富文本编辑器的全部功能

请回复 A 或 B：
```

收到用户选择后，按以下方式构造命令（**优先使用 `contentFile` 方案，避免 JSON 转义问题**）：

- **选 A**：`save` 命令，`type: "md"`，文件名加 `.md` 后缀
  ```
  # Step 1：Write 工具将 Markdown 写入 /tmp/note-content.md（无需 JSON 转义）
  {"title":"标题.md","type":"md","contentFile":"/tmp/note-content.md","parentId":"文件夹ID"}
  ```
  备选（短内容）：`{"title":"标题.md","type":"md","content":"Markdown 内容","parentId":"文件夹ID"}`
- **选 B**：`save` 命令，`type: "note"`，`contentFormat: "md"`，文件名加 `.note` 后缀
  ```
  # Step 1：Write 工具将 Markdown 写入 /tmp/note-content.md（无需 JSON 转义）
  {"title":"标题.note","type":"note","contentFormat":"md","contentFile":"/tmp/note-content.md","parentId":"文件夹ID"}
  ```
  备选（短内容）：`{"title":"标题.note","type":"note","contentFormat":"md","content":"Markdown 内容","parentId":"文件夹ID"}`

> `parentId` 为可选字段：填写 `youdaonote -s ydn list` 返回的文件夹 ID 可指定目标目录；不填则默认存入「我的资源/收藏笔记」。
- **用户未明确选择**（回复"随便"/"你决定"等）：默认选 A

### 创建 / 保存

```bash
# ✅ 推荐：contentFile 方案（Write 工具写文件 → save 传路径，无需 JSON 转义）
# Step 1：Write 工具将 Markdown 写入 /tmp/note-content.md
printf '%s\n' '{"title":"笔记.md","type":"md","contentFile":"/tmp/note-content.md"}' | youdaonote -s ydn save --json
# ✅ 短内容可直接内联（无换行/特殊字符时）
printf '%s\n' '{"title":"笔记","contentFormat":"md","content":"# 标题\n\n内容"}' | youdaonote -s ydn save
# ⚠️ 仅纯文本，不支持 Markdown 格式，有格式需求时禁用
youdaonote -s ydn create -n "标题" -c "纯文本内容"
```

### 其他操作

```bash
youdaonote -s ydn search "关键词"
youdaonote -s ydn list [-f <目录ID>]            # 浏览目录，id 可传给 read
youdaonote -s ydn read <fileId>                 # 返回 JSON 含 content、rawFormat（md/note/txt）和 isRaw（是否原始内容）
youdaonote -s ydn recent -l 20 -c --json       # 最近收藏
youdaonote -s ydn update <fileId> -c "新内容"
youdaonote -s ydn update <fileId> --file content.md  # 大内容（>10KB）从文件读取
youdaonote -s ydn delete <fileId>
youdaonote -s ydn rename <fileId> "新标题"
youdaonote -s ydn move <fileId> <目录ID>
```

## 网页剪藏

```bash
youdaonote -s ydn clip "https://example.com/article" --json
youdaonote -s ydn clip "https://example.com/article" -f <目录ID> --json  # 保存到指定目录
```

## CLI 未安装处理（Agent 必须自动执行）

收到 `command not found` 时，Agent **立即执行**安装命令，禁止只展示步骤让用户操作。

**macOS / Linux / WSL**：
```bash
curl -fsSL https://artifact.lx.netease.com/download/youdaonote-cli/install.sh | bash -s -- -f -b ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"
# 安装后立即重新执行用户原始请求
```

**升级**：若 CLI 支持 `upgrade` 命令，优先使用 `youdaonote -s ydn upgrade`；否则重新执行上述安装脚本。

**Windows 或安装失败**：参考安装指南（https://note.youdao.com/help-center/cli-install-guide.html）。

## 故障排查

运行 `youdaonote -s ydn check --json`，根据 `status: "fail"` 的项执行：

| 失败项 | 处理动作 |
|--------|---------|
| `config-file` / `api-key` | 提示用户按「API Key 错误」在自己的终端中重新配置；Agent 不得索取或接收明文 Key |
| `mcp-connection` | API Key 有效但网络不通，提示用户检查网络或稍后重试 |

## 注意事项

- 所有命令支持 `--json` 输出机器可解析格式
- 大内容通过 `--file` 传递，避免命令行参数限制
- Windows CMD 中 URL 含 `&` 时必须用双引号括起
- Windows 管道/重定向场景中文可能乱码（CLI 输出 UTF-8，但 PowerShell/CMD 默认按 GBK 解读）：PowerShell 中执行 `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`，CMD 中执行 `chcp 65001`；可运行 `youdaonote -s ydn check` 查看诊断建议
- `list` 输出的 `id` 与 `read` 的 `fileId` 等价
- `read` 返回的 `rawFormat` 标识笔记原始格式：`md`=Markdown、`note`=云笔记、`txt`=纯文本；`isRaw` 标识返回的 content 是否为原始内容（`true`=原文可直接编辑，`false`=经过转换的纯文本）
- **禁止用 `create` 保存 Markdown 内容**：`create` 不支持 `contentFormat`，即使内容含 Markdown 语法也会存为纯文本静默丢失格式，有格式需求时一律使用 `save` 并指定 `contentFormat: "md"`
- `save` 命令通过 JSON 的 **`parentId`** 字段指定目标文件夹（值来自 `list` 返回的文件夹 ID）；不传则默认存到「我的资源/收藏笔记」。**禁止使用 `folderId` 等其他命名——服务端会静默忽略未知字段。**
