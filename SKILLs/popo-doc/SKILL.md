---
name: popo-doc
description: 管理POPO文档产品能力(文件夹/在线文档（文档、云文档）/在线表格/多维表)。当用户需要创建文档、搜索文档、找材料、查看文档详情、修改文档内容、管理文件夹、获取评论、下载文档内嵌文件、操作在线表格、操作多维表时使用。当用户输入内容包含 docs.popo.netease.com 域名时，也一定要唤起此 skill。
metadata:
  version: "1.1.0"
---

# POPO 文档 Skill

通过 `fabric_call` 工具调用 POPO 网关 API 管理 POPO 文档产品能力。所有操作传入 `tool`（操作名）和 `params`（业务参数）。

---

## ⚠️ 铁律（违反将导致严重错误）

1. **content 禁止 Markdown** — 写入文档内容时只允许自定义 HTML 标签，写入前**必读** [content-format.md](./references/content-format.md)
2. **记录 data 的 key 必须用 fieldId** — 禁止用字段名，写入前**必调** `doc_field_list` 获取 fieldId
3. **建表时 fields 必传** — `doc_datasheet_create` 创建字段前**必读** [mtable-field-types.md](./references/mtable-field-types.md)
4. **新建多维表自带默认数据表和仪表盘** — 必须先用 `doc_datasheet_create` 创建好用户需要的数据表，**确认创建成功后**，再用 `doc_datasheet_list` 和 `doc_dashboard_list` 查出默认自带的，最后用 `doc_datasheet_delete` 删掉（⚠️ 严禁在创建新数据表之前删除默认数据表，否则会报错；注意不要删用户创建的）
5. **所有参数必须查阅参考文档** — 必须到 `./references/` 目录下查询工具参数，不得捏造
6. **区分云空间和团队空间** — 团队空间所有操作必须传 `teamSpaceId`
7. **文档/表格内的图片资源不能直接使用** — 必须通过 `doc_get_file_download_url` 获取临时下载链接
8. **禁止手动构造任何 ID** — docId / folderId / teamSpaceId / datasheetId / fieldId / recordId 等全部从接口返回中提取
9. **删除操作前必须与用户二次确认** — 唯一例外：工作流 5 中清理新建多维表自带的默认数据表和默认仪表盘，无需确认

---

## 云空间 vs 团队空间

| 类型   | URL 特征                                                                    | teamSpaceId                           |
|------|---------------------------------------------------------------------------|---------------------------------------|
| 云空间  | `https://docs.popo.netease.com/{占位}/{docId}`                              | 不传                                    |
| 团队空间 | `https://docs.popo.netease.com/team/pc/{teamSpaceKey}/pageDetail/{docId}` | 必传，通过 `doc_get_folder_path` 从 URL 中提取 |

遇到团队空间 URL 时，先调用 `fabric_call({"tool": "doc_get_folder_path", "params": {"url": "团队空间URL"}})` 获取 `teamSpaceId`，后续所有操作都带上该值。

---

## 文档类型

| docType | 类型 | 说明 |
|---------|------|------|
| `0` | 文件夹 | 目录容器，不含内容 |
| `1` | POPO文档 | 富文本文档，支持读写内容 |
| `2` | POPO表格 | 在线表格，内容通过 `doc_execute_table` 操作 |
| `9` | 多维表 | 多维数据表，内容通过 `doc_datasheet_*` 等专用工具操作 |

---

## 操作路由

### 通用操作（所有文档类型共用）→ [tool-reference.md](./references/tool-reference.md)

| 工具 | 用途 |
|------|------|
| `doc_create_doc` | 创建文档/文件夹（docType: 0/1/2/9） |
| `doc_delete_doc` | 删除文档/文件夹（全部类型）⚠️ |
| `doc_search_doc` | 语义搜索文档（直接传原始 query，禁止改写） |
| `doc_get_doc_detail` | 查看详情+内容（仅 POPO文档 有 content） |
| `doc_update_doc` | 改标题（全类型）/ 改内容（仅 POPO文档，格式**必读** [content-format.md](./references/content-format.md)） |
| `doc_get_comments` | 获取评论 |
| `doc_get_folder_path` | 从 URL 解析 folderId / teamSpaceId |
| `doc_search_folder_path` | 按关键词搜索文件夹 |
| `doc_get_file_download_url` | 获取内嵌文件临时下载地址 |

### 表格内容操作（docType=2）

当需要操作**表格内部数据**（读写单元格、行列增删、Sheet管理、图表）时：
→ **必读** [sheet-tool-reference.md](./references/sheet-tool-reference.md)

- 统一入口：`doc_execute_table`，通过 `command.type` 区分操作
- 前置条件：先有 `docId`，再通过 `workbook.getFullData` 获取 `sheetId`
- 批量写入限制：`sheet.batchSetCells` 每次最多 50 个单元格

### 多维表内部操作（docType=9）

当需要操作**多维表内部数据**（数据表、记录、字段、视图、仪表盘、Widget）时：
→ **必读** [mtable-tool-reference.md](./references/mtable-tool-reference.md)

按需补充阅读：

| 场景 | 必读文件 |
|------|---------|
| 创建字段 / 写入记录 | [mtable-field-types.md](./references/mtable-field-types.md) |
| 构造筛选条件 | [mtable-filter-guide.md](./references/mtable-filter-guide.md) |
| 配置仪表盘 Widget | [mtable-widget-guide.md](./references/mtable-widget-guide.md) |

---

## 快速决策表

**通用操作：**

| 用户说的 | 选什么 | 不要用 |
|---------|-------|-------|
| "建一个表格" | `doc_create_doc`(docType=2) | docType=1 |
| "建一个多维表" | `doc_create_doc`(docType=9) | `doc_datasheet_create` |
| "搜文档/找周报" | `doc_search_doc` | `doc_search_folder_path` |
| "搜文件夹/找目录" | `doc_search_folder_path` | `doc_search_doc` |
| "这个链接是什么" | `doc_get_doc_detail` | — |
| "这个链接的文件夹ID" | `doc_get_folder_path` | `doc_search_folder_path` |
| "改文档标题" | `doc_update_doc`(title) | `doc_create_doc` |
| "下载文档里的图片" | 先 `doc_get_doc_detail` 提取URL → 再 `doc_get_file_download_url` | — |

**POPO表格(docType=2)操作：**

| 用户说的 | 选什么 | 不要用 |
|---------|-------|-------|
| "看看表格里有什么数据" | `doc_execute_table`(workbook.getFullData) | `doc_get_doc_detail` |
| "表格里写数据/填入数据" | `doc_execute_table`(sheet.batchSetCells) | `doc_update_doc` |
| "在表格A1写入100" | `doc_execute_table`(sheet.setCell) | `doc_update_doc` |
| "合并前两行" | `doc_execute_table`(sheet.mergeCells) | — |
| "新建一个Sheet" | `doc_execute_table`(workbook.createSheet) | `doc_create_doc` |
| "在第3行后插入两行" | `doc_execute_table`(sheet.insertRows) | — |
| "在表格加个柱状图" | `doc_execute_table`(sheet.addChart) | `doc_widget_add` |

**多维表(docType=9)操作：**

| 用户说的 | 选什么 | 不要用 |
|---------|-------|-------|
| "在多维表里加数据表" | `doc_datasheet_create` | `doc_create_doc` |
| "多维表里加记录" | `doc_record_batch_create` | `doc_execute_table` |
| "多维表里找状态=已完成的" | `doc_record_filter` | `doc_record_page` |
| "把待处理的都改成进行中" | `doc_record_filter_update` | `doc_record_batch_update` |
| "看看多维表有哪些字段" | `doc_field_list` | `doc_record_page` |
| "多维表里加一列" | `doc_field_create` | `doc_execute_table`(insertCols) |
| "建个仪表盘" | `doc_dashboard_create` | `doc_execute_table`(addChart) |
| "在仪表盘加个饼图" | `doc_widget_add` | `doc_execute_table`(addChart) |
| "收集表/表单/问卷/报名" | `doc_datasheet_create` + views 含 `{"type":4}` 表单视图 | — |

**多维表记录操作三路选择：**

| 场景 | 查询 | 更新 | 删除 |
|------|------|------|------|
| 无条件/浏览全部 | `doc_record_page` | — | — |
| 已知 recordId | `doc_record_batch_get` | `doc_record_batch_update` | `doc_record_batch_delete`⚠️ |
| 按条件筛选 | `doc_record_filter` | `doc_record_filter_update` | `doc_record_filter_delete`⚠️ |
| 单个单元格 | `doc_cell_get` | `doc_cell_update` | — |

---

## 核心流程

1. **意图分类** — 判断用户需要对什么类型的文档执行什么操作
2. **歧义处理** — 指令模糊时主动追问澄清
3. **路由选择** — 查阅上方路由表和快速决策表，确定使用的工具
4. **读取参考** — 按路由指引读取对应的参考文档，获取准确的参数格式
5. **执行操作** — 按 [workflows.md](./references/workflows.md) 中的标准流程执行

> 详细工作流见 [workflows.md](./references/workflows.md)，涵盖：
> - 工作流 1: 创建文档并写入内容
> - 工作流 2: 下载文档内嵌文件
> - 工作流 3: 创建表格并写入数据
> - 工作流 4: 创建图表
> - 工作流 5: 创建多维表并写入数据（含模板匹配）
> - 工作流 6: 在已有多维表中查询和更新记录
> - 工作流 7: 创建多维表仪表盘

---

## 产物保存

doc_create_doc调用成功时（status==1）,返回值会包含url和type字段：
- **环境有 `save_artifact` 工具** → 立即调用 `save_artifact(artifact_type="link", url="<url>", title="<标题>", content_type="<type>")`
- **环境无 `save_artifact` 工具** → 跳过，直接返回链接给用户

---

## 上下文传递表

| 操作 | 提取字段 | 用于 |
|------|---------|------|
| `doc_create_doc` | `docId`, `url`, `type`, `teamSpaceId` | update_doc / get_doc_detail / delete_doc / execute_table / save_artifact / 多维表操作的 `documentId` |
| `doc_search_doc` | `docId`, `url`, `type` | 同上 |
| `doc_get_doc_detail` | `content` 中的文件 URL | get_file_download_url |
| `doc_get_folder_path` | `folderId`, `teamSpaceId` | create_doc 的 parentId / teamSpaceId |
| `doc_search_folder_path` | `folderId`, `teamSpaceId` | create_doc 的 parentId / teamSpaceId |
| `doc_execute_table`(getFullData) | `sheetId` | 后续所有 execute_table 操作 |
| `doc_execute_table`(createSheet) | `sheetId` | 后续所有需 sheetId 的操作 |
| `doc_execute_table`(addChart) | `chartId` | updateChart / removeChart |
| `doc_datasheet_list` | `nodeId`→datasheetId | 所有需 datasheetId 的多维表操作 |
| `doc_datasheet_create` | `nodeId`→datasheetId | 记录/字段/视图操作 |
| `doc_field_list` | `id`→fieldId | 记录 data 的 key、筛选条件、单元格操作 |
| `doc_record_page/filter/batch_get` | `recordId` | 记录更新/删除、单元格操作 |
| `doc_view_list/create` | `id`→viewId | 视图更新/删除/复制、字段排序 |
| `doc_dashboard_list/create` | `nodeId`→dashboardId | Widget 操作 |
| `doc_widget_add` | `widgetId` | Widget 更新/删除 |

---

## 错误处理

| 错误类型                 | 处理方式 |
|----------------------|---------|
| 500 服务端错误            | 根据错误信息调整参数后重试（最多 2 次） |
| 4xx 客户端错误（认证失败/权限不足） | **禁止重试**，告知用户检查权限 |
| 文档/记录不存在             | 确认 ID 是否正确，必要时重新搜索 |
| 字段类型不匹配              | 调用 `doc_field_list` 确认字段类型后重新构造值 |
| batch 操作部分失败         | 检查返回的 `fail` 计数，根据错误信息修正后重试失败项 |

---

## 参考文档索引

| 文件 | 内容 | 何时读 |
|------|------|-------|
| [tool-reference.md](./references/tool-reference.md) | 通用 API 参数与返回值 | 使用通用操作时 |
| [sheet-tool-reference.md](./references/sheet-tool-reference.md) | 在线表格 API 参数与返回值 | 操作表格内容时 |
| [content-format.md](./references/content-format.md) | 文档 HTML 内容格式规范 | 读写文档内容时 |
| [mtable-tool-reference.md](./references/mtable-tool-reference.md) | 多维表 API 参数与返回值 | 操作多维表时 |
| [mtable-field-types.md](./references/mtable-field-types.md) | 字段类型手册 | 创建字段/写入记录时 |
| [mtable-filter-guide.md](./references/mtable-filter-guide.md) | 筛选条件构造指南 | 按条件查询/更新/删除记录时 |
| [mtable-widget-guide.md](./references/mtable-widget-guide.md) | 仪表盘 Widget 配置指南 | 创建/更新 Widget 时 |
| [workflows.md](./references/workflows.md) | 核心工作流步骤 | 执行完整流程时 |
