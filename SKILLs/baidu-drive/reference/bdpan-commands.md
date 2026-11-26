# bdpan CLI 命令快速参考

以下命令为简写；Agent 实际调用必须附加 `--agentname`、`--session-input`（本轮原文，shell 单引号包裹；含凭据的整轮省略）和 `--session-id`（同一对话复用），见 [公共参数规则](../SKILL.md#所有命令公共参数agent-必传)。

## 认证命令

### login - 登录授权

> **⛔ Agent 必须通过登录脚本执行登录，禁止直接调用 `bdpan login`。详见 [SKILL.md](../SKILL.md) 安全约束。**

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/login.sh
```

脚本非交互返回统一授权 JSON。默认准备凭据；需要新链接时由 Agent 对话确认，再以 `--confirmed` 调用。展示完整链接及指引后结束，支持远端与跨设备。详见[认证指南](./authentication.md)。

### logout - 注销登录

```bash
bdpan logout
```

清除本地存储的认证信息（`~/.config/bdpan/config.json`）。

### uninstall - 完全卸载

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/uninstall.sh
```

完全卸载 bdpan CLI，自动执行以下操作：
1. 注销登录并清除授权信息
2. 删除配置目录（`~/.config/bdpan/`）
3. 删除 bdpan 二进制文件（`~/.local/bin/bdpan`）

**选项：**
- `--yes, -y` - 跳过确认提示（自动化场景）

**环境变量：**
| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `BDPAN_INSTALL_DIR` | 二进制安装目录 | `~/.local/bin` |
| `BDPAN_CONFIG_DIR` | 配置文件目录 | `~/.config/bdpan` |

### whoami - 查看认证状态

```bash
bdpan whoami
```

显示当前登录状态、用户名和 Token 有效期信息。

`whoami` 不领取待授权 key；正文搜索先通过登录脚本准备凭据，再查会员身份。`whoami --json` 顶层 `authenticated` 与 `has_valid_token` 同为 `true` 才表示可复用登录态。`has_valid_token` 表示访问 Token 有效，`expires_at` 与 `token_expires_in` 分别表示其到期时间和剩余有效期；这些字段不表示刷新 Token 的有效期。非零退出或字段异常时停止，不能当作未登录自动授权。另包含以下会员字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `vip_type` | integer/null | `vip_version=v2`：0=普通用户、1=VIP、2=SVIP；未返回时为 null |
| `is_svip` | boolean/null | 已识别会员类型时表示是否为 SVIP；缺失或无法识别类型时为 null |
| `entitlement_status` | string | `known` 表示会员身份已知，服务准入仍由服务端校验；`unknown` 不表示非会员 |

正文搜索的预检与暂停规则见 [Skill 执行流程](../SKILL.md#搜索正文片段)。

**已登录时输出：**
```
已登录
Token: 有效 (29 天)
```

**选项：**
- `--json` - JSON 格式输出

---

### vip - 会员开通/续费入口

```bash
bdpan vip [--json]
```

用户提到"充会员""开通会员""续费""买 VIP""超级会员"等付费意图时调用，返回百度网盘会员主收银台链接。CLI 无法判断用户当前在移动端还是电脑端，因此**固定返回两条链接**，由用户按设备自选：

- 移动端主收银台：`https://pan.baidu.com/wap/vip/user?from=bdpan`
- 电脑端主收银台：`https://pan.baidu.com/buy/checkoutcounter?from=bdpan`

`--json` 输出 `mobile_url`、`desktop_url` 与预渲染整句 `agent_reply`；回显时原样输出 `agent_reply`，或把两条链接都渲染成 Markdown 可点击格式。**不得自行拼接、猜测或替换其它支付/收银台地址，也不得只给一条链接。**价格、会员权益、优惠信息以收银台页面为准，CLI 不返回这些内容，不要凭记忆编造。

---

### quota - 查询网盘容量

```bash
bdpan quota --help --no-check-update
bdpan quota --json --no-check-update
```

无位置参数；只读查询当前账号整体容量，不是应用目录占用。Agent 实际调用按 [公共参数规则](../SKILL.md#所有命令公共参数agent-必传) 附加公共参数。命令不存在时只提示用户决定更新，不自动更新；收到授权状态时按[认证指南](./authentication.md)处理并结束本轮。

成功退出码为 0，JSON 为 `code/data/error` 信封：

```json
{
  "code": 0,
  "data": {
    "total_bytes": 2199023255552,
    "used_bytes": 1374389534720,
    "free_bytes": 824633720832,
    "usage_ratio": 0.625,
    "usage_percent": 62.5,
    "total_display": "2.00 TiB",
    "used_display": "1.25 TiB",
    "free_display": "768.00 GiB",
    "expire": false,
    "message": "容量查询成功"
  },
  "error": ""
}
```

以上为脱敏 Fixture，不是真实账号容量。

| 字段 | 说明 |
|---|---|
| `total_bytes` / `used_bytes` | 总容量 / 已用容量，整数，单位 B |
| `free_bytes` | 剩余空间，`max(total_bytes-used_bytes,0)`；服务端原始 `free` 是免费容量，不是剩余，不用于该计算 |
| `usage_ratio` / `usage_percent` | 已用除以总量 / 百分比；百分比四舍五入至两位，展示时可保留两位小数 |
| `total_display` / `used_display` / `free_display` | 1024 进制，B/KiB/MiB/GiB/TiB/PiB/EiB |
| `expire` | true 表示 7 天内有容量到期，不表示全部到期，不自动续费 |
| `message` | 容量查询状态说明 |

失败时 `code=1`、退出码非零、`error` 说明原因；通常 `data=null`。`total<=0`、缺失/null、负数为异常，不能报告成零容量或0%成功；`used>total` 保留原值、`free_bytes=0` 的异常 data，仍为非零退出，不能当正常结果使用。

用户问是否够上传文件时，在目标明确后只读本地文件大小，与 `free_bytes` 按 B 比较；空间充足只代表容量维度，不保证上传成功，不自动上传、清理或购买。

## 文件操作命令

### upload - 上传文件

```bash
bdpan upload <local> <remote>
bdpan upload <local-file> <remote-file> --overwrite --json
```

| 参数 | 说明 |
|------|------|
| `local` | 本地文件或文件夹路径 |
| `remote` | 网盘目标路径（相对于 `/apps/bdpan/`） |

**示例：**
```bash
# 单文件上传
bdpan upload ./report.pdf report.pdf

# 文件夹上传
bdpan upload ./project/ project/

# 上传到子目录
bdpan upload ./data.tar.gz backup/data.tar.gz
```

**选项：**
- `--json` - JSON 格式输出上传结果
- `--overwrite` - 显式覆盖单个文件，默认不覆盖；上传文件夹时不支持该参数。CLI 无额外交互确认，Agent 必须先在聊天中针对明确目标取得二次确认，规则见 [上传](../SKILL.md#上传)。

默认同名不同内容生成带后缀副本，同内容复用不生成副本。单文件结果 `data.action` 为 `created` / `renamed` / `overwritten` / `unchanged`；`remote_path`、`saved_path` 是实际落点；`requested_path` 是请求目标；`conflict_detected` 表示预检发现同名对象。`verification=metadata` 只验证路径和大小，`content_verified=false`，不表示完整内容校验。失败或结果不确定时非零退出、`code=1`，可能带 `action=unknown`；不得自动重传、先删后传或声称成功。

合法连续点号名称（`xxx..mp4`、`会议...docx`、`a..b/文件.txt`）原样保留；独立父目录段 `..`、编码穿越、根目录外路径继续拒绝。重命名第二参数必须是单个名称，不能包含 `/` 或 `\`。

### download - 下载文件

```bash
bdpan download <remote> <local> [选项]
```

| 参数 | 说明 |
|------|------|
| `remote` | 网盘文件/文件夹路径（相对于 `/apps/bdpan/`）**或**百度网盘分享链接 |
| `local` | 本地保存路径 |

**选项：**
| 选项 | 说明 |
|------|------|
| `-p` | 提取码（用于分享链接，如果链接中未包含） |
| `-t` | 自定义转存目录（相对路径自动拼接 `/apps/bdpan`，绝对路径直接使用） |
| `--json` | JSON 格式输出下载结果 |

**示例：**
```bash
# 单文件下载
bdpan download report.pdf ./downloaded-report.pdf

# 文件夹下载
bdpan download project/ ./project-restore/

# 从无码公开分享链接下载
bdpan download "https://pan.baidu.com/s/<分享标识>" ./downloaded/

# 从分享链接下载（链接中包含提取码）
bdpan download "https://pan.baidu.com/s/<分享标识>?pwd=abcd" ./downloaded/

# 使用 -p 参数单独传入提取码
bdpan download "https://pan.baidu.com/s/<分享标识>" ./downloaded/ -p abcd

# 使用 -t 参数自定义转存目录
bdpan download "https://pan.baidu.com/s/<分享标识>?pwd=abcd" ./downloaded/ -t my-folder
```

**分享链接下载说明：**
- 接受用户提供的百度网盘分享链接，内部标识由 CLI 解析，Skill 不解释或要求选择内部前缀
- 未携带 `?pwd=` 且未使用 `-p` 时，按无码公开分享链接直接尝试，不需要预先填写提取码
- 分享文件会先转存到 `/apps/bdpan/{日期}/` 目录（或使用 `-t` 指定的目录）
- 然后下载到指定的本地路径

### transfer - 转存分享文件到网盘（不下载到本地）

```bash
bdpan transfer <分享链接> [选项]
```

| 参数 | 说明 |
|------|------|
| `分享链接` | 百度网盘分享链接 |

**选项：**
| 选项 | 说明 |
|------|------|
| `-p` | 提取码（可选；如果链接中未包含且分享需要密码时填写） |
| `-d` | 目标目录（相对路径自动拼接 `/apps/bdpan`，默认为应用根目录） |
| `--json` | JSON 格式输出转存结果 |

**示例：**
```bash
# 无码公开分享转存到应用根目录 /apps/bdpan/
bdpan transfer "https://pan.baidu.com/s/<分享标识>"

# 需要提取码的分享，使用 -p 传入
bdpan transfer "https://pan.baidu.com/s/<分享标识>" -p abcd

# 提取码在链接中
bdpan transfer "https://pan.baidu.com/s/<分享标识>?pwd=abcd"

# 指定目标目录
bdpan transfer "https://pan.baidu.com/s/<分享标识>" -p abcd -d my-folder/

# JSON 输出
bdpan transfer "https://pan.baidu.com/s/<分享标识>" -p abcd --json
```

**查询分享目录（只读）：**

```bash
bdpan transfer list "<分享链接>" \
  [-p <提取码>] \
  [--source-dir <分享目录路径>] \
  [--page <页码>] \
  [--page-size <每页数量>] \
  [--json]
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--source-dir` | 空 | 空值查询分享第一层；子目录使用上一页返回的 `path` |
| `--page` | `1` | 页码，必须大于等于 1 |
| `--page-size` | `100` | 每页数量，范围 1-100 |
| `-p, --pwd` | 空 | 分享提取码；链接含 `pwd` 时可省略 |
| `--json` | false | Agent 调用时必须启用 |

列表 JSON 中的 `fs_id` 是字符串，必须原样保存，避免大整数精度丢失。`count` 是当前页条目数；`has_more=true` 表示可能有下一页。

**按所选文件 ID 转存：**

```bash
bdpan transfer select "<分享链接>" \
  --fsid <文件ID>[,<文件ID>...] \
  [-p <提取码>] \
  [-d <目标目录>] \
  [--json]
```

- `--fsid` 必填，可重复传入或使用逗号分隔；每个 ID 必须是大于 0 的十进制整数；
- 客户端不设置选择数量上限，实际转存数量由服务端按接收账号权益和目录递归内容判断；
- 执行前必须由 Agent 向用户展示选择清单和目标目录并取得确认；
- 成功 JSON 的 `status` 为 `submitted`，表示异步任务已提交，不代表服务端已完成全部转存。

普通 `transfer` 和分享链接 `download` 也可能返回 `status=submitted`：此时任务已提交但仍在排队、执行或暂时无法查询。必须保留 `task_id`、转存位置和（下载场景）本地目标路径，不得回复“转存成功/下载成功”，不得展示完成文件的回端链接，也不要重复提交。若任务查询返回 `-6`、`13998`、`13080` 或 `13081` 等权限/权益错误，应说明“任务已提交，但当前账号暂时无法查询状态”，而不是把任务判定为失败。

`errno=13070` 在短暂重试后仍未找到任务时，保留任务 ID 并提示稍后重试；`errno=13071` 表示已有其他转存任务进行中，等待约 5 分钟后再试。

转存完成后，使用结果中每个文件的实际保存路径逐项回复，优先使用 `saved_path`（用户可见的“我的应用数据/bdpan/...”路径），兼容读取 `path` 或旧版 `remote_path`。只有确认任务完成后才能说“已保存”；`status=submitted` 只能说“转存任务已提交”。

**与 download 的区别：**
- `transfer` 仅将分享文件转存到自己的网盘，不下载到本地
- `download` 会先转存再下载到本地路径
- 适用于只需要保存到网盘、不需要本地副本的场景

### ls - 查看文件列表

```bash
bdpan ls [path]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `path` | 要查看的目录路径 | 根目录 |

**选项：**
- `--json` - JSON 格式输出

**示例：**
```bash
# Agent 为了向用户返回“查看网盘”入口，必须使用 JSON
bdpan ls --json

# 查看子目录并保留每项回端字段
bdpan ls backup --json

# 仅筛选文件夹
bdpan ls backup --folder --json
```

自然语言“查看文件”“列出目录”时，不得使用无 JSON 的普通表格作为 Agent 的数据源。Agent 必须逐项读取 JSON 中的 `return_markdown` 并原样输出（缺失时才用 `return_url` 渲染 `[点击查看]({return_url})`）。即使用户只查看一个文件，也必须返回该文件对应的查看入口；不能只输出名称、大小或网盘路径。

当 `return_url` 缺失时，只能回显 CLI 实际返回的路径并说明“暂时无法生成查看链接”，不得按路径、文件名或 `fsid` 自行拼接 URL。

`fsid`/`fs_id`、`owner_uid`、`uid`、`traceid` 属于内部标识，只用于后续 CLI 调用与链接生成，禁止在面向用户的回复中展示（正文、表格列、括号补充说明一律不写）；面向用户可见的字段只有名称、路径、大小、时间和 `return_markdown` 链接。用户明确索要时才可给出。

不得先用脚本、jq 或 python 把 CLI 的 JSON 裁剪成少数字段再回复——实测中「只取 `saved_path`、`fsid`、`message`」会把链接过滤掉。CLI 3.8.7 起把链接同时写进 `message` 与 `agent_reply`（预渲染整句：动作 + 路径 + `[点击查看](链接)`），直接回显其中之一即可。

### share - 创建分享链接

```bash
bdpan share <path> [path...] [--period <天数>] [--json]
```

| 参数 | 说明 |
|------|------|
| `path` | 要分享的文件或文件夹路径（支持多个） |
| `--period, -d` | 分享有效期（天）：0=永久, 1, 7, 30（默认：7） |

**示例：**
```bash
# 分享文件（默认 7 天有效）
bdpan share report.pdf

# 分享文件夹
bdpan share project

# 永久分享
bdpan share report.pdf -d 0

# 30 天有效期
bdpan share report.pdf --period 30

# JSON 输出
bdpan share --json report.pdf
```

**输出格式：**
```
分享链接创建成功!
链接: <百度网盘分享链接>
提取码: abcd
有效期: 7 天
```

### search - 搜索文件

```bash
bdpan search <关键词> [选项]
```

| 参数 | 说明 |
|------|------|
| `关键词` | 搜索关键词（必填） |

**选项：**
| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--category` | int | `0` | 文件类型筛选：1=视频, 2=音频, 3=图片, 4=文档, 5=应用, 6=其他, 7=种子 |
| `--page-size` | int | `5` | 每页数量（最大 50） |
| `--page` | int | `1` | 页码 |
| `--no-dir` | bool | `false` | 仅显示文件，排除文件夹 |
| `--dir-only` | bool | `false` | 仅显示文件夹 |
| `--json` | - | - | JSON 格式输出 |

> `--no-dir` 和 `--dir-only` 互斥，不能同时使用。

**示例：**
```bash
# Agent 为了向用户返回每个结果的“查看网盘”入口，必须使用 JSON
bdpan search report --json

# 搜索图片类型文件
bdpan search photo --category 3 --json

# 搜索文件，排除文件夹，每页 10 条
bdpan search data --no-dir --page-size 10 --json

# 翻页
bdpan search report --page 2 --json
```

自然语言“搜索”“找一下”时，Agent 必须逐项读取 JSON 结果中的 `return_markdown` 并原样输出（缺失时才用 `return_url` 渲染 `[点击查看]({return_url})`）；不得把结果重新整理成不带链接的路径表。

### search-content - 搜索正文片段

搜索文档正文并返回匹配片段。能力检查、会员预检和结果展示见 [Skill 执行流程](../SKILL.md#搜索正文片段)，JSON 字段见[输出契约](#search-content-命令输出)。

```bash
bdpan search-content <query> [--dir <目录>|--dir-fsid <目录ID>] [--file-types <格式列表>] [--page-size <数量>] --json --no-check-update
```

| 参数／选项 | 默认值 | 说明 |
|-----------|--------|------|
| `query` | 必填 | 正文搜索词或自然语言查询 |
| `--dir` | 应用根目录 | 相对于 `/apps/bdpan` 的目录，或沙盒内绝对路径；超出范围的路径拒绝执行 |
| `--dir-fsid` | 空 | 与 `--dir` 互斥；十进制目录 ID 按字符串传入，CLI 校验其为授权范围内目录 |
| `--file-types` | `pdf,docx,txt,md,pptx,xlsx` | 仅支持这六种后缀的逗号列表，在本次召回候选中筛选 |
| `--page-size` | `10` | 范围 1–50，仅裁剪本次候选，不提供下一页 |
| `--json` | false | Agent 必须启用；成功和失败均采用 `{code,data,error}` 外层 |
| `--no-check-update` | false | 能力检查、会员预检和实际搜索均启用，跳过自动版本检查 |

### get-content - 读取文件正文

```bash
bdpan get-content <fsid> [fsid...] [选项]
```

| 参数 | 说明 |
|------|------|
| `fsid` | 文件 ID（必填），一次最多 5 个 |

**选项：**
| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--page-start` | int | `0` | 起始页（从 1 开始，含）；**仅单文件的 Word/PDF/PPT 支持** |
| `--page-end` | int | `0` | 结束页（含）；**仅单文件的 Word/PDF/PPT 支持** |
| `--json` | - | - | JSON 格式输出 |

**两类文件走不同路径，返回字段不同：**

| 文件类型 | 行为 | 该命令返回 |
|----------|------|------------|
| `.txt` `.md` | 同步读取，一条命令直接出正文 | `content` |
| `.doc` `.docx` `.pdf` `.ppt` `.pptx` `.xls` `.xlsx` | 异步解析，**本命令只创建任务** | `task_id`（正文要用 `get-content-result` 再查一次） |

其余类型（图片、音频、压缩包、无后缀、目录等）直接返回该项错误。

**示例：**
```bash
# 读 txt（同步，直接出正文）
bdpan get-content 1100987500222364 --json

# 读 docx（异步，只拿到 task_id，还要再查一次）
bdpan get-content 986232775041442 --json

# 一次读多个（最多 5 个），结果按输入顺序返回
bdpan get-content 111 222 333 --json

# 只读某文档的第 1~3 页（仅单文件的 Word/PDF/PPT）
bdpan get-content 111 --page-start 1 --page-end 3 --json
```

**约束（客户端快速失败，不发起网络请求）：**
- 一次最多 5 个 fsid；
- 页参数只支持**单文件**，多文件带页参数直接拒绝；
- 页参数**不支持** `.xls`/`.xlsx`（Excel 的“页”是转成 PDF 后的分页，与 sheet/单元格无关）与 `.txt`/`.md`；
- `--page-start` 不得大于 `--page-end`。

**多文件时**：结果为数组，顺序与输入一致；**某一项失败不影响其他项**（部分成功），失败项带 `error`，整条命令退出码非零。若同一 fsid 传了多次，结果里会出现多个同 fsid 的项，**请用下标对应，不要只用 fsid 匹配**。

**异步项必须二次查询**：`.docx`/`.pdf` 等异步类型在 `get-content` 阶段**没有 `content`**，只有 `task_id`。同一批异步文件**共用同一个 task_id**，因此一次 `get-content-result` 就能取回整批。

### get-content-result - 查询文件解析任务结果

```bash
bdpan get-content-result <taskid> [--json]
```

| 参数 | 说明 |
|------|------|
| `taskid` | `get-content` 返回的任务 ID（必填） |

**任务状态：**
| status | 含义 | Agent 该怎么做 |
|--------|------|----------------|
| `running` | 任务未结束 | 稍后重试（退出码 1，**这不是失败**） |
| `succeeded` | 全部文件读取成功且未被截断 | 直接使用 `content` |
| `partial` | 有文件失败或被截断 | 逐项看 `error` / `truncated` |
| `failed` | 全部文件失败，`files` 为空 | 接口不返回失败原因 |

**正文超长（合计超 2 万字）**时服务端转存 BOS：该文件 `content` 为空、`url` 是带签名的下载链接（**有效期 2 小时**），`char_count` 仍为完整字数。

**示例：**
```bash
bdpan get-content-result 84f80cda-aa63-4619-9ee3-f5393866324d --json
```

> 任务耗时实测为**秒级到分钟级且不稳定**（同一个文件可能几秒，也可能十几分钟）。Agent 轮询时应留足时间，不要因为一次 `running` 就重复发起 `get-content`。

### mv - 移动文件或文件夹

```bash
bdpan mv <源路径> <目标目录>
```

| 参数 | 说明 |
|------|------|
| `源路径` | 要移动的文件或文件夹路径（相对于 `/apps/bdpan/`） |
| `目标目录` | 目标目录路径（相对于 `/apps/bdpan/`） |

**示例：**
```bash
# 移动文件到子目录
bdpan mv report.pdf backup

# 移动文件夹
bdpan mv old-project archive

# JSON 输出
bdpan mv report.pdf backup --json
```

**输出格式：**
```
已移动 report.pdf -> backup
```

### cp - 复制文件或文件夹

```bash
bdpan cp <源路径> <目标目录>
```

| 参数 | 说明 |
|------|------|
| `源路径` | 要复制的文件或文件夹路径（相对于 `/apps/bdpan/`） |
| `目标目录` | 目标目录路径（相对于 `/apps/bdpan/`） |

**示例：**
```bash
# 复制文件到子目录
bdpan cp report.pdf backup

# 复制文件夹
bdpan cp project project-copy

# JSON 输出
bdpan cp report.pdf backup --json
```

**输出格式：**
```
已复制 report.pdf -> backup
```

### rename - 重命名文件或文件夹

```bash
bdpan rename <路径> <新名称>
```

| 参数 | 说明 |
|------|------|
| `路径` | 要重命名的文件或文件夹路径（相对于 `/apps/bdpan/`） |
| `新名称` | 新文件名（仅名称，不含路径） |

**示例：**
```bash
# 重命名文件
bdpan rename old-name.pdf new-name.pdf

# 重命名子目录中的文件
bdpan rename docs/draft.md final.md

# JSON 输出
bdpan rename old-name.pdf new-name.pdf --json
```

**输出格式：**
```
已重命名 old-name.pdf -> new-name.pdf
```

### mkdir - 创建文件夹

```bash
bdpan mkdir <路径>
```

| 参数 | 说明 |
|------|------|
| `路径` | 要创建的文件夹路径（相对于 `/apps/bdpan/`） |

**示例：**
```bash
# 创建文件夹
bdpan mkdir backup

# 创建多级目录
bdpan mkdir backup/2026/03

# JSON 输出
bdpan mkdir backup --json
```

**输出格式：**
```
已创建文件夹: backup
```

### rm - 删除文件或文件夹

```bash
bdpan rm <路径> [路径...] [--force] [--json]
```

`rm` 支持删除一个或多个文件/文件夹。Skill 仅在用户明确提出删除意图、目标路径无歧义、且已向用户列出待删对象并取得明确确认后才调用。为避免 CLI 的交互式确认阻塞 Agent，应传入 `--force/-f --json`；`--force/-f` 只用于跳过 CLI 提示，`--json` 用于读取机器可解析结果，不得用于推断用户意图、跳过用户确认或绕过路径校验。

执行前可用 `bdpan ls --json` 核对目标并区分文件和文件夹。目标有歧义、用户取消、用户未明确确认或只是询问删除方法时，不执行命令；确认环节必须说明目录删除会影响该目录及其内容，且删除不可逆。

```bash
# 用户明确要求删除、目标无歧义，且已列出待删对象并取得用户明确确认后
bdpan rm "docs/old-report.pdf" --force --json
```

**成功输出：**
```text
已删除 N 个文件/文件夹
```

只根据 CLI 实际返回报告成功数量；失败或取消必须如实说明。

---

## 版本管理命令

### update - 自动更新 Skill

> **使用 `bash ${CLAUDE_SKILL_DIR}/scripts/update.sh` 更新 Skill 文件。CLI 更新由 `bdpan` 自身管理。**

```bash
# 检查并更新（交互式，需用户确认）
bash ${CLAUDE_SKILL_DIR}/scripts/update.sh

# 仅检查更新，不执行
bash ${CLAUDE_SKILL_DIR}/scripts/update.sh --check

# 跳过确认，自动更新（自动化场景）
bash ${CLAUDE_SKILL_DIR}/scripts/update.sh --yes
```

**功能说明：**
- 通过百度配置接口获取最新 Skill 版本信息
- 对比本地 VERSION 文件判断是否需要更新
- 下载 zip 包并解压覆盖，更新 VERSION 文件
- 支持 SHA256 完整性校验（如配置中包含 checksum）

**选项：**
| 选项 | 说明 |
|------|------|
| `--check, -c` | 仅检查更新，不执行安装 |
| `--yes, -y` | 跳过用户确认，自动执行更新 |
| `--help` | 显示帮助信息 |

### version - 查看版本信息

```bash
# 查看当前版本
bdpan version

# 检查是否有更新
bdpan version --check
```

---

## init - 查看安装信息（v3.4.0+）

```bash
bdpan init
```

显示安装路径、配置文件路径和 PATH 配置建议。

**输出示例：**
```
bdpan 安装信息
────────────────────────────
安装路径: /home/user/.local/bin/bdpan
配置路径: /home/user/.config/bdpan/config.json

PATH 配置建议:
  export PATH="$HOME/.local/bin:$PATH"
```

---

## 全局选项

| 选项 | 说明 |
|------|------|
| `--config-path <path>` | 指定配置文件完整路径（适用于 AI Agent 集成） |
| `--json` | JSON 格式输出 |
| `--no-check-update` | 禁用版本更新检查 |
| `--uid <uid>` | Agent 回端上下文 UID（文件链接使用） |
| `--traceid <traceid>` | Agent 回端上下文 Trace ID（文件链接使用） |
| `--help` | 显示帮助 |
| `--version` | 显示版本 |

---

## JSON 输出格式

### 回端链接字段（v1.7.6）

以下命令成功且链接生成成功时，JSON 结果会返回 `return_url`、`return_hint` 和 `return_markdown`（单结果在顶层，多结果在每个 item 内）：`upload`、`download`、`transfer`、`search`、`ls`、`cp`、`mv`、`rename`、`mkdir`、`get-content`、`get-content-result`。

**链接字段的取用位置按命令不同，取错位置会导致 Agent 读不到链接而漏展示：**

| 命令 | 链接所在位置 | 每项的链接字段 |
|------|-------------|----------------|
| `ls` | 顶层数组 `[...]` | `return_markdown`（缺失时 `return_url`） |
| `search` | 顶层 `items[...]`（**不是** `data`） | `return_markdown`（缺失时 `return_url`） |
| `search-content` | `data.hits[...]` | **`file_url`**（本命令**不返回** `return_markdown`） |
| `get-content` | `data[...]` | `return_markdown`（缺失时 `return_url`）；异步项另有 `task_id` |
| `get-content-result` | `data.files[...]` | `return_markdown`（缺失时 `return_url`） |

> `search-content` 是唯一例外：命中项里只有 `file_url` / `file_url_target`，没有 `return_url` / `return_markdown`，Agent 必须直接渲染 `[点击查看](file_url)`。

> `get-content` / `get-content-result` 的 `path` 与 `return_url` 都由 CLI 侧补齐：服务端 filecontents 接口只返回 `fsid` 和文件名，不含路径与链接。

当前 CLI 使用正式 `https://pan.baidu.com/union/spirit/launch` 协议生成客户端链接（文件目标 `target=file`、目录目标 `target=dir`），并生成 Web 目录兜底链接。所有 URL 必须当作不透明值处理；目标能否预览由网盘主端判断，CLI 与 Skill 都不做判断，文件和目录的用户文案统一为“点击查看”。

```json
{
  "return_url": "https://pan.baidu.com/union/spirit/launch?...",
  "return_hint": "点击查看",
  "return_markdown": "[点击查看](https://pan.baidu.com/union/spirit/launch?...)"
}
```

- `return_markdown` 是 CLI 已渲染好的 Markdown 链接，Agent 应优先原样输出，不再自行用 `return_hint` + `return_url` 拼接；只有该字段缺失时才退回自行渲染。
- 不带 `--json` 的 `ls`、`search` 表格输出把链接并入名称列（`名称 → 链接`），宿主重排表格时必须整体保留该单元格。
- `return_hint` 只是展示提示，当前固定为“点击查看”。`return_target_type` 为 `directory` 表示 Web 兜底目标是目录；`client_return_target_type=file` 表示端内文件目标，`directory` 表示端内目录目标（缺少 `fsid` 时文件会降级为目录目标，并在 `client_return_url_error` 中说明原因；Agent 上下文缺失不触发降级）。
- 每次成功任务都要返回实际目标的字符串 `fsid`（兼容保留 `fs_id`）或已生成的 `return_url`；Skill 不得仅凭文件名、相对路径或列表序号猜测文件 ID。
- 文件链接由 CLI 使用 `fs_id` 和 `owner_uid` 生成，`uid`/`traceid` 存在时一并透传、缺失不影响链接生成；目录链接使用目标 `path` 和 `owner_uid`。`owner_uid` 来自已登录账号信息，`uid`、`traceid` 由 Agent 上下文通过 `--uid`、`--traceid` 透传，不能要求用户手工提供或自行猜测。
- 降级链路始终停留在统一拉端页 `union/spirit/launch`：缺 `fsid` → 父目录 `target=dir`；连 `owner_uid` 也缺 → 仅带 `path` + `target=dir`，由落地页登录后处理身份。`web_return_url` 只是预留字段，不作为 `return_url`。
- Skill 应把 URL 当作不透明值直接展示，不自行拼接、改写或替换查询参数；缺少字段时回显路径并说明无法生成查看链接。
- `download` 的回端目标是网盘源文件/源目录，不是本地保存路径；`transfer select` 的 `status=submitted` 不代表任务完成，不能提前返回完成对象链接。
- `share` 仅返回现有 `link`/`short_url`，不额外增加回端链接；`rm` 不返回 `return_url`。
- 失败、取消、无权限结果不得返回回端链接字段。

#### 预留字段契约

统一链接生成能力接入后，服务端可在成功结果中补充以下字段；当前 CLI 未稳定提供两类独立 URL 时，这些字段可以省略，Skill 不得自行补造：

| 字段 | 类型 | 说明 |
|------|------|------|
| `client_return_url` | string | 客户端/移动端优先使用的端内链接，由服务端生成 |
| `web_return_url` | string | 客户端未安装、版本不支持或拉起失败时使用的 Web 链接，由服务端生成 |
| `return_target_type` | string | 当前 CLI 为 `directory`（Web 兜底目标始终是目录） |
| `client_return_target_type` | string | 当前 CLI 为 `file`（文件）或 `directory`（目录），表示端内目标 |
| `return_url` | string | 宿主按访问环境选择的主链接；当前兼容字段 |

预留字段示例：

```json
{
  "return_target_type": "directory",
  "return_url": "<按当前环境选择的主链接>",
  "client_return_url": "<客户端链接>",
  "web_return_url": "<Web 兜底链接>",
  "return_hint": "点击查看"
}
```

Skill/Agent 不判断客户端协议、文件扩展名或 MIME，也不拼接上述 URL。文件缺少 `fsid` 或 Agent 上下文时，CLI 会降级为所在目录的端内链接；两类链接都无法生成时，仅回显实际路径并说明“暂时无法生成查看链接”及原因。

### ls 命令输出

```json
[
  {
    "fs_id": 524080722157776,
    "fsid": "524080722157776",
    "path": "/apps/bdpan/report.pdf",
    "server_filename": "report.pdf",
    "size": 1536000,
    "isdir": false,
    "md5": "a1b2c3d4e5f6...",
    "server_mtime": "2026-02-25T15:20:00+08:00",
    "server_ctime": "2026-02-25T14:00:00+08:00",
    "return_url": "https://pan.baidu.com/union/spirit/launch?...",
    "return_target_type": "directory",
    "client_return_target_type": "file",
    "return_hint": "点击查看"
  },
  {
    "fs_id": 841873986109404,
    "fsid": "841873986109404",
    "path": "/apps/bdpan/documents",
    "server_filename": "documents",
    "size": 0,
    "isdir": true,
    "md5": "",
    "server_mtime": "2026-02-20T10:30:00+08:00",
    "server_ctime": "2026-02-20T09:00:00+08:00",
    "return_url": "https://pan.baidu.com/union/spirit/launch?...",
    "return_target_type": "directory",
    "client_return_target_type": "directory",
    "return_hint": "点击查看"
  }
]
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `fs_id` | number | 文件唯一 ID |
| `fsid` | string | 文件唯一 ID（供回端链接使用，避免大整数精度丢失） |
| `path` | string | CLI/API 使用的原始网盘路径，如 `/apps/bdpan/...` |
| `server_filename` | string | 文件名 |
| `size` | number | 文件大小（字节），目录为 0 |
| `isdir` | boolean | 是否为目录（`true`/`false`，注意是小写布尔值） |
| `md5` | string | 文件 MD5 值，目录为空字符串 |
| `server_mtime` | string | 服务端修改时间（ISO 8601 带时区） |
| `server_ctime` | string | 服务端创建时间（ISO 8601 带时区） |
| `return_url` | string | CLI/服务端生成的主回端链接；缺失时不得自行拼接 |
| `return_markdown` | string | CLI 预渲染的 `[点击查看](链接)`，Agent 优先原样输出 |
| `return_hint` | string | 用户展示提示；文件与目录统一为“点击查看” |
| `return_target_type` | string | 当前 CLI 为 `directory`；未来服务端确认 Web 预览协议后可为 `file_preview` |
| `client_return_target_type` | string | 当前 CLI 为 `file` 或 `directory`，表示端内目标 |

> **注意：** `path` 是 API 原始路径（`/apps/bdpan/...`），不是用户展示路径。面向用户展示时，优先使用命令返回的 `saved_path`；不要把 `path` 改写后再作为 API 参数传回。

### share 命令输出

```json
{
  "link": "https://pan.baidu.com/s/<分享标识>",
  "short_url": "xxxxxxx",
  "share_id": 25747091668,
  "period": 7,
  "pwd": "abcd"
}
```

### upload 命令输出

```json
{
  "code": 0,
  "data": {
    "message": "上传成功",
    "local": "./report.pdf",
    "remote": "report.pdf",
    "remote_path": "report.pdf",
    "saved_path": "我的应用数据/bdpan/report.pdf",
    "action": "created",
    "requested_path": "/apps/bdpan/report.pdf",
    "conflict_detected": false,
    "verification": "metadata",
    "content_verified": false,
    "fsid": "524080722157776",
    "return_url": "https://pan.baidu.com/union/spirit/launch?...",
    "return_target_type": "directory",
    "client_return_target_type": "file",
    "return_hint": "点击查看"
  },
  "error": ""
}
```

`upload` 成功时从 `data.saved_path` 读取面向用户的实际完整保存路径。旧版 CLI 仅返回 `remote_path` 时，应映射到“我的应用数据/bdpan/...”并在必要时用 `bdpan ls --json` 核对。

### download 命令输出

直接下载成功时，CLI 返回本地保存位置；分享链接下载还会在 `data.saved_path` 返回转存到网盘的实际路径。

```json
{
  "code": 0,
  "data": {
    "message": "下载成功",
    "remote": "report.pdf",
    "local": "./report.pdf",
    "fsid": "524080722157776",
    "return_url": "https://pan.baidu.com/union/spirit/launch?...",
    "return_target_type": "directory",
    "client_return_target_type": "file",
    "return_hint": "点击查看"
  },
  "error": ""
}
```

分享链接下载的 `data` 还包含 `share`、`count` 和 `saved_path`；`saved_path` 表示下载前转存到网盘的目录。

### transfer 命令输出

```json
{
  "saved_path": "我的应用数据/bdpan/my-folder/",
  "count": 1,
  "files": [
    {
      "name": "shared-file.pdf",
      "path": "/apps/bdpan/my-folder/shared-file.pdf",
      "fsid": "524080722157776",
      "saved_path": "我的应用数据/bdpan/my-folder/shared-file.pdf",
      "return_url": "https://pan.baidu.com/union/spirit/launch?...",
      "return_target_type": "directory",
      "client_return_target_type": "file",
      "return_hint": "点击查看",
      "size": 47104,
      "is_dir": false
    }
  ]
}
```

`transfer` 完成后返回 `count` 和 `files`；顶层 `saved_path` 是共同目标目录，逐项回复必须使用 `files[].saved_path`。兼容旧版结果中的 `files[].path` 或 `remote_path`。选择性转存 `transfer select` 使用单独的 `status=submitted` 响应，该状态只表示任务已提交，不得表述为已保存。

### search 命令输出

```json
{
  "total": 15,
  "page": 1,
  "page_size": 5,
  "items": [
    {
      "fs_id": 524080722157776,
      "fsid": "524080722157776",
      "path": "我的应用数据/bdpan/report.pdf",
      "server_filename": "report.pdf",
      "size": 1536000,
      "isdir": false,
      "category": 4,
      "server_mtime": "2026-02-25T15:20:00+08:00",
      "return_url": "https://pan.baidu.com/union/spirit/launch?...",
      "return_target_type": "directory",
      "client_return_target_type": "file",
      "return_hint": "点击查看",
      "return_markdown": "[点击查看](https://pan.baidu.com/union/spirit/launch?...)"
    }
  ]
}
```

> **注意**：`search` 的结果在**顶层 `items[]`**，不在 `data` 里；每项都带 `return_markdown`，回复时必须逐项原样输出 `[点击查看](...)`，不得把结果整理成不带链接的清单。

### search-content 命令输出

本次有限候选处理成功的示例（ID、内容为示例值，链接为占位值；实际展示使用 CLI 返回的完整链接）：

```json
{
  "code": 0,
  "data": {
    "request_id": "1234567890123456", "status": "succeeded",
    "query": "项目验收", "scope": "/apps/bdpan/docs",
    "hits": [{
      "fsid": "9007199254740993", "file_name": "report.pdf", "path": "/apps/bdpan/docs/report.pdf",
      "snippet": "项目验收前需完成资料核对与问题闭环。", "pid": "123456", "source": 7,
      "source_ref_id": "ref_001", "locator": null, "file_url_target": "file",
      "file_url": "https://pan.baidu.com/union/spirit/launch?..."
    }],
    "total": 1, "total_scope": "returned_candidates", "returned_count": 1,
    "next_page_token": null,
    "source_refs": [{
      "source_ref_id": "ref_001", "fsid": "9007199254740993", "file_name": "report.pdf",
      "path": "/apps/bdpan/docs/report.pdf", "pid": "123456", "locator": null, "file_url_target": "file",
      "file_url": "https://pan.baidu.com/union/spirit/launch?..."
    }],
    "index_status": "unknown",
    "capabilities": {"locator": false, "server_pagination": false, "index_status": false},
    "show_msg": "以下是本次找到的正文片段，可能未覆盖全部相关内容。暂不提供准确的正文位置或继续翻页，无法确认资料是否已完成搜索准备。",
    "retryable": false
  },
  "error": ""
}
```

| 字段 | 含义 |
|------|------|
| `code` / `error` | 成功为 `0` / `""`；失败 `code=1` 且非零退出，展示 `data.show_msg`（缺失时用 `error`），不能当零命中 |
| `data.status` | `succeeded` 为本次候选处理成功；`partial` 仅为客户端裁剪；失败为 `failed` 或 `unsupported` |
| `total` / `returned_count` | `total_scope=returned_candidates`：过滤、去重后且裁剪前的本次候选数 / 实际 `hits` 数，均非全网盘命中数 |
| `hits` / `source_refs` | 每个 hit 按 `source_ref_id` 匹配来源；同文件可有多个引用，ID 不跨请求复用，`fsid` 保留字符串；内部 ID 不向用户展示 |
| `file_url` / `file_url_target` | CLI 生成的查看链接，原样用于 `[点击查看](链接)`，目标为 `file` 或 `directory`；无法获取账号 UK 时降级为目录链接，另行说明实际目标；空链接不能编造 |
| `snippet` | 命中的正文片段，用于回答"文档里有没有提到某某"。**可能是服务端占位文案而非正文原话**，典型形态为「命中相关文档: {文件名}（正文索引生成中）」——此时不得当作正文片段展示，要说明索引未就绪，也不能据此断言文档里没有该内容 |
| 可选字段 | `pid` 是不透明片段标识；`source` 已知时为 7；`file_url_target` 有目标时返回，`file_url_error` 有降级/失败提示时返回；`error_code` 失败时返回 |
| `locator` / `next_page_token` / `index_status` | 当前为 null / null / `unknown`，对应三项 `capabilities=false`，不能推断定位、续页或索引完成 |
| `request_id` / `show_msg` / `retryable` | 请求排查 ID / 用户话术 / 是否允许重试，失败时保留 `request_id` 和 `error_code` |

零结果为 `hits/source_refs=[]`、`total/returned_count=0`，仍不能断言资料不存在。`path/scope` 展示时映射为 `我的应用数据/bdpan/...`；链接协议参数保持原样。

> **展示要求**：每条命中都必须在回复里带上 `[点击查看](file_url)`，不得只给文件名或片段。链接字段是 `file_url`，本命令不返回 `return_markdown`。

### mv/cp/rename/mkdir 命令输出

```json
{
  "status": "ok",
  "return_url": "https://pan.baidu.com/union/spirit/launch?...",
  "return_target_type": "directory",
  "return_hint": "点击查看"
}
```

`mv`、`cp`、`rename`、`mkdir` 的链接必须指向操作完成后的实际目标；当前 Web 对文件目标仍以所在目录兜底，其他原有状态字段保持兼容。若 CLI 无法定位目标或生成链接失败，保留成功状态和实际路径，不得填充伪链接。

### get-content 命令输出

`data` **恒为数组**，顺序与输入的 fsid 一致，一个文件一项。

同步类型（`.txt`/`.md`）—— 该项带正文：

```json
{
  "code": 0,
  "data": [
    {
      "fs_id": 1100987500222364,
      "fsid": "1100987500222364",
      "name": "test.txt",
      "path": "/apps/bdpan/test.txt",
      "content": "test content\n\nmodify\n\nhh",
      "return_url": "https://pan.baidu.com/union/spirit/launch?fsid=...&owner_uid=...&target=file",
      "return_hint": "点击查看",
      "return_markdown": "[点击查看](https://pan.baidu.com/union/spirit/launch?...)"
    }
  ],
  "error": ""
}
```

异步类型（`.docx`/`.pdf` 等）—— 该项**只有 `task_id`、没有 `content`**：

```json
{
  "code": 0,
  "data": [
    {
      "fs_id": 986232775041442,
      "fsid": "986232775041442",
      "name": "报告.docx",
      "path": "/apps/bdpan/报告.docx",
      "task_id": "2f6fa212-b2fd-4318-857a-f6dc94e3cc7e",
      "return_url": "https://pan.baidu.com/union/spirit/launch?fsid=...&target=file",
      "return_hint": "点击查看",
      "return_markdown": "[点击查看](https://pan.baidu.com/union/spirit/launch?...)"
    }
  ],
  "error": ""
}
```

部分成功 —— 数组完整返回，失败项带 `error`，信封汇总 + 退出码 1：

```json
{
  "code": 1,
  "data": [
    { "fs_id": 1100987500222364, "fsid": "...", "content": "test content", "return_url": "..." },
    { "fs_id": 123456789, "fsid": "123456789", "error": "未找到 fsid 对应的文件: 123456789" }
  ],
  "error": "1/2 个文件读取失败"
}
```

### get-content-result 命令输出

任务状态是任务级信息，因此这里 `data` 是**对象**（与 `get-content` 的数组不同）：

```json
{
  "code": 0,
  "data": {
    "task_id": "2f6fa212-b2fd-4318-857a-f6dc94e3cc7e",
    "status": "succeeded",
    "files": [
      {
        "fs_id": 986232775041442,
        "fsid": "986232775041442",
        "name": "allowlist_test_报告.docx",
        "path": "/mcp_test_folder/allowlist_test_报告.docx",
        "content": "宁德时代股价调研报告\n...",
        "page_start": 1,
        "page_end": 1,
        "page_num": 1,
        "char_count": 852,
        "return_url": "https://pan.baidu.com/union/spirit/launch?fsid=...&target=file",
        "return_hint": "点击查看",
        "return_markdown": "[点击查看](https://pan.baidu.com/union/spirit/launch?...)"
      }
    ]
  },
  "error": ""
}
```

正文超长时该文件 `content` 为空、`url` 有值：

```json
{
  "fsid": "91691574906438",
  "name": "你好.docx",
  "content": "",
  "url": "http://netdisk-ai-mcp-bj.bj.bcebos.com/ai-filecontent/...?x-bce-security-token=...",
  "page_start": 1,
  "page_end": 21,
  "page_num": 21,
  "char_count": 53300,
  "truncated": false
}
```

- `page_start`/`page_end` 是**实际读取的页范围**，`page_num` 是文档总页数，`char_count` 是正文完整字数（转存 BOS 时也准确）。
- `truncated=true` 表示因**单文件 50 万字上限**被截断，不是完整正文。
- 按文件失败时 `content` 为空、`error` 有值。**错误信息只有一个 `error` 字段（字符串），没有 `err_code`/`err_msg` 字段**——服务端返回的错误会把原始 `err_msg` 原样保留，格式为 `{服务端 err_msg}（错误码 {N}）`，用正则 `（错误码 (\d+)）` 取出错误码；CLI 本地校验类错误（如「该文件类型不支持读取正文」）没有这个后缀，需要按文案判断。

> **展示要求**：`get-content` 与 `get-content-result` 的每一项都带 `return_markdown`，回复正文时必须逐项一起给出 `[点击查看](...)`。链接和正文/`url` 出现在同一条回复里，不能只给内容。

---

## 路径规则

- 所有路径相对于应用根目录 `/apps/bdpan/`
- 支持相对路径: `backup/data.tar.gz`
- 支持绝对路径: `/apps/bdpan/backup/data.tar.gz`
- 独立父目录段 `..` 及编码穿越会被自动阻止；普通文件/目录名中的连续点号允许并保留原名

> **⛔ 双向路径映射规则：** 调用 bdpan 命令时，"我的应用数据" 必须转换为 `/apps`；向用户展示路径时，`/apps` 必须转换为 "我的应用数据"。详见 [路径规则](../SKILL.md) 章节。

---

## 配置文件位置

```
~/.config/bdpan/config.json
```

**环境变量：**

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `BDPAN_CONFIG_PATH` | 配置文件完整路径（优先级最高） | 无 |
| `BDPAN_CONFIG_DIR` | 配置文件目录 | `~/.config/bdpan` |
| `BDPAN_INSTALL_DIR` | 二进制安装目录 | `~/.local/bin` |

**配置路径优先级（v3.4.0+）：**
1. `--config-path` 命令行参数（最高优先级）
2. `BDPAN_CONFIG_PATH` 环境变量
3. `BDPAN_CONFIG_DIR` 环境变量 + `config.json`
4. `~/.config/bdpan/config.json`（默认路径）

**使用示例：**
```bash
# 使用命令行参数指定配置
bdpan --config-path /custom/path/config.json ls

# 使用环境变量指定配置
export BDPAN_CONFIG_PATH=/custom/path/config.json
bdpan ls
```

### AI Agent 集成

当 AI Agent 无法通过默认路径读取配置时，可以通过以下方式指定：

```python
import subprocess
import os

env = os.environ.copy()
env["BDPAN_CONFIG_PATH"] = "/home/user/.config/bdpan/config.json"

result = subprocess.run(
    ["bdpan", "ls", "--json"],
    env=env,
    capture_output=True,
    text=True
)
```

---

## 常见错误码

| 错误 | 说明 | 解决方案 |
|------|------|---------|
| Token expired | 访问 Token 过期 | 由 CLI 尝试刷新；需要授权时按认证指南展示状态并结束，网络/配置/未识别的刷新错误先排查 |
| Path not allowed | 路径不在允许范围 | 使用 /apps/bdpan/ 下的路径 |
| File not found | 文件不存在 | 检查路径是否正确 |
| errno=13045 | 自己的分享链接 | 文件已在网盘中，直接使用 `bdpan ls` 查找 |

### 读取正文（`get-content` / `get-content-result`）错误码

| 错误码 | 说明 | 解决方案 |
|--------|------|---------|
| 21061 / 21062 / 21064 | 文本预览：文件不存在 / 校验失败 / 超过 20MB 上限 | 确认 fsid；超过 20MB 的 `.txt`/`.md` 无法读取 |
| 40101 | 参数不合法（fsids 为空或超 5 个、多文件带页参数、页参数非法、Excel 带页参数） | 按提示调整入参 |
| 40102 | 任务不存在 | `taskid` 失效，重新发起 `get-content` |
| 40103 | 文件不存在或无权访问 | 确认文件在应用目录内 |
| 40104 | 文件类型不支持（或目标是目录） | 见上方支持的类型清单 |
| 40105 | 文件大小超出限制 | 该文件无法读取 |
| 40106 | 单次请求读取内容超出限制（页数/字符上限） | 减少文件数，或用 `--page-start`/`--page-end` 分片读取 |
| 40107 | 并发任务数超出限制 | 等当前任务结束后再发起新的读取 |
| 40108 | **当日读取配额超限**（字数 / 页数 / 不同文件数） | 次日再试，或减少单次读取量；`error` 文案会说明是哪一项到顶 |
| 50101 | **文件解析失败（总类码，必须看 `error` 文案细分）**：含「文件转换中」→ 可重试；含「获取文件解析信息失败」/「获取文件正文失败」→ 可重试；含「文件无效」→ 重试无用 | 见下方「50101 重试指引」 |
| 50102 | 任务执行超时 | 稍后重试 |
| 50103 | 服务内部错误 | 稍后重试 |

> 按文件返回的错误（40103~40108、50101）出现在该项的 `error` 字段上（**没有 `err_code`/`err_msg` 字段**），**只让该项失败**，同一批其他文件照常返回。

#### 50101 重试指引（文件解析失败）

`50101` 是「文件解析失败」的**总类码**，下面有几种完全不同的情况。**只看错误码无法判断该怎么办，必须看 `error` 里的文案**：

| `error` 文案包含 | 真实原因 | 该怎么做 |
|---|---|---|
| **文件转换中** | 该文件首次被读取，服务端正在做格式转换 | ✅ **隔一段时间后重新发起**（PPT/Excel 类通常需要 1~5 分钟） |
| 获取文件解析信息失败 | 解析服务抖动或超时 | ✅ 可重试，间隔 5~30 秒 |
| 获取文件正文失败 | 拉取正文时网络抖动 | ✅ 可重试 |
| 文件无效 | 文件本身有问题（损坏、格式异常） | ❌ 重试无用，告知用户文件无法解析 |

**重试规则：**

- **只重试失败的那几个 `fsid`**。不要把整批重发——已成功的文件会被重复读取，白白消耗当日配额（40108）。
- `status=partial` 按「部分成功」处理，只对失败项重试。
- 间隔 **30~60 秒**，总时长上限 **5 分钟**；超时后按失败告知用户。
- 重试 = 对失败 fsid 重新执行 `get-content`（旧任务已是终态，一定会新建任务）。
- 服务端自身的重试窗口只有约 1 分钟，**不足以覆盖 PPT/Excel 的转换耗时**，拉长等待窗口这件事由调用方负责。

**不要重试的情况**：`40103`/`40104`/`40105`（文件本身的问题）、`40108`（当日配额，次日 0 点重置）、`40106`（不是失败，是截断，看 `truncated`）。

**给用户的文案：**

- 等待中：`该文件首次读取需要先做格式转换（PPT、Excel 类通常需要 1~5 分钟），正在解析中，请稍候…`
- 超时：`该文件解析超时（已等待约 5 分钟）。建议稍后重新尝试；如果多次失败，可能是文件本身无法解析。`
- 文件无效：`该文件无法解析，可能是文件损坏或格式异常，请检查文件后重试。`

---

## 平台支持

| 功能 | macOS | Linux | Windows (WSL) |
|------|-------|-------|---------------|
| 基础功能 | ✅ | ✅ | ✅ |
| 登录脚本 | ✅（授权链接） | ✅（含无图形界面） | 用户需能访问授权网页 |

登录入口支持本地、远端和跨设备，不依赖 localhost 回调或原命令持续运行；网页授权后下一次业务请求单次领取凭据。
