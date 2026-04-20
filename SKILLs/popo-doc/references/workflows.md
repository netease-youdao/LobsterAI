# 核心工作流

本文件包含各场景的标准操作流程。执行任何工作流时，仍需遵守 [SKILL.md](../SKILL.md) 顶部的强制规范。

---

## 工作流 1: 创建文档并写入内容

> ⚠️ 写入 content **必须**使用自定义 HTML 标签，**绝对禁止 Markdown**。写入前**强制读取** [content-format.md](./content-format.md)。

```
# 1. (可选) 搜索目标文件夹
fabric_call({"tool": "doc_search_folder_path", "params": {"keyword": "项目资料"}})
# 从返回中提取 folderId 和 teamSpaceId

# 2. 创建文档
fabric_call({"tool": "doc_create_doc", "params": {"docType": 1, "title": "项目周报", "parentId": "<FOLDER_ID>"}})
# 从返回中提取 docId, url, type

# 3. 写入内容 (仅POPO文档，不需要 nodeId，使用 doc.insert_after 自动追加到文档末尾)
# ❌ 禁止: "## 本周总结\n- 完成 API 开发"
# ✅ 必须: 使用 <h2>、<doc-li>、<code-block> 等自定义 HTML 标签
fabric_call({"tool": "doc_update_doc", "params": {"docId": "<DOC_ID>", "command": {"type": "doc.insert_after", "content": "<h2>本周总结</h2><p>完成了以下工作：</p><doc-li list-id=\"l1\" list-type=\"unordered\">完成 API 开发</doc-li><doc-li list-id=\"l1\" list-type=\"unordered\">修复 3 个 Bug</doc-li><code-block language=\"python\">def deploy():\n    print(\"done\")</code-block>"}}})

# 4. 【重要】若环境有 save_artifact 工具，必须保存文档链接
# save_artifact(artifact_type="link", url="<URL>", title="项目周报", content_type="<TYPE>")
```

---

## 工作流 2: 下载文档内嵌文件

```
# 1. 获取文档详情，从 content 中提取文件 URL
fabric_call({"tool": "doc_get_doc_detail", "params": {"docIdOrUrl": "<DOC_ID>"}})

# 2. 获取预签名下载地址
fabric_call({"tool": "doc_get_file_download_url", "params": {"docId": "<DOC_ID>", "urls": ["url1", "url2"]}})
```

---

## 工作流 3: 创建表格并写入数据

```
# 1. 创建POPO表格
fabric_call({"tool": "doc_create_doc", "params": {"docType": 2, "title": "销售数据", "parentId": "<FOLDER_ID>"}})
# 从返回中提取 docId, url, type

# 2. 获取表格完整数据（含 sheetId 等元信息）
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.getFullData", "payload": {}}}})
# 从返回中提取 sheetId

# 3. 批量写入数据
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.batchSetCells", "payload": {"sheetId": "<SHEET_ID>", "cells": [{"row": 0, "col": 0, "value": "姓名"}, {"row": 0, "col": 1, "value": "销售额"}, {"row": 1, "col": 0, "value": "张三"}, {"row": 1, "col": 1, "value": 5000}]}}}})

# 4. (可选) 读取指定区域验证
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.batchGetCells", "payload": {"sheetId": "<SHEET_ID>", "row": 0, "col": 0, "rowCount": 10, "colCount": 5}}}})

# 5. (可选) 修改单个单元格
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.setCell", "payload": {"sheetId": "<SHEET_ID>", "row": 1, "col": 1, "value": 6000}}}})

# 6. 【重要】若环境有 save_artifact 工具，必须保存表格链接
# save_artifact(artifact_type="link", url="<URL>", title="销售数据", content_type="<TYPE>")
```

---

## 工作流 4: 创建图表

```
# 1. 确保表格有数据（先用 workbook.getFullData 或 sheet.batchGetCells 查看）

# 2. 添加图表
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.addChart", "payload": {"sheetId": "<SHEET_ID>", "title": "销售趋势", "domain": "A1:C5", "type": "line", "location": [300, 500, 400, 500]}}}})

# 3. 查看图表列表
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.chartList", "payload": {"sheetId": "<SHEET_ID>"}}}})
```

---

## 工作流 5: 创建多维表并写入数据

> 创建数据表时需要定义字段结构。可参考 [mtable-field-types.md](./mtable-field-types.md) 中的 Recipes 示例，按用户需求增删字段。

```
# 1. 创建多维表文档
fabric_call({"tool": "doc_create_doc", "params": {"docType": 9, "title": "项目管理"}})
# 从返回中提取 docId（即 documentId）, url

# 2. 【必须先执行】创建用户需要的数据表
# ⚠️ 严禁跳过此步！必须先创建新数据表，才能删除默认数据表（多维表至少要保留一个数据表，否则删除会报错）
新建数据表（含初始字段，字段定义参考 [mtable-field-types.md](./mtable-field-types.md) 中的 Recipes 示例）
fabric_call({"tool": "doc_datasheet_create", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "payload": {"name": "任务跟踪", "template": {"fields": [{"name": "任务名称", "type": 1, "property": {}}, {"name": "状态", "type": 3, "property": {"options": [{"name": "待处理"}, {"name": "进行中"}, {"name": "已完成"}]}}, {"name": "截止日期", "type": 5, "property": {"dateFormat": 0}}], "views": [{"name": "默认视图", "type": 1}]}}}})
# 确认创建成功后，再进入下一步

# 3. 【创建成功后才执行】清理默认数据表和默认仪表盘
# ⚠️ 执行顺序：步骤 2 成功 → 步骤 3。绝对不能在步骤 2 之前执行！
# 3a. 查询所有数据表
fabric_call({"tool": "doc_datasheet_list", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>"}})
# 从返回中找出默认自带的数据表（不是步骤 2 创建的那个），提取其 nodeId
# 3b. 删除默认数据表（只删默认自带的，不要删步骤 2 创建的！）
fabric_call({"tool": "doc_datasheet_delete", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DEFAULT_DATASHEET_ID>"}})
# 3c. 查询所有仪表盘
fabric_call({"tool": "doc_dashboard_list", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>"}})
# 3d. 删除默认仪表盘
fabric_call({"tool": "doc_datasheet_delete", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DEFAULT_DASHBOARD_ID>"}})

# 4. 获取字段列表（确认 fieldId）
fabric_call({"tool": "doc_field_list", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DATASHEET_ID>"}})
# 从返回中提取各字段的 id

# 5. 批量写入记录（key 用 fieldId，不用字段名）
fabric_call({"tool": "doc_record_batch_create", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DATASHEET_ID>", "payload": {"records": [{"<FIELD_ID_1>": "设计评审", "<FIELD_ID_2>": "进行中", "<FIELD_ID_3>": 1711353600000}]}}})

# 6. 【重要】若环境有 save_artifact 工具，必须保存多维表链接
# save_artifact(artifact_type="link", url="<URL>", title="项目管理", content_type="9")
```

---

## 工作流 6: 在已有多维表中查询和更新记录

```
# 1. 搜索多维表文档
fabric_call({"tool": "doc_search_doc", "params": {"query": "项目管理多维表"}})
# 确认 type=9（多维表），提取 docId

# 2. 获取数据表列表
fabric_call({"tool": "doc_datasheet_list", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>"}})
# 提取目标数据表的 nodeId（datasheetId）

# 3. 获取字段列表
fabric_call({"tool": "doc_field_list", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DATASHEET_ID>"}})

# 4. 按条件筛选记录
fabric_call({"tool": "doc_record_filter", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DATASHEET_ID>", "payload": {"filterInfo": {"conjunction": "and", "conditions": [{"fieldId": "<STATUS_FIELD_ID>", "operator": "is", "value": "待处理"}]}}}})

# 5. 按条件批量更新
fabric_call({"tool": "doc_record_filter_update", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DATASHEET_ID>", "payload": {"filterInfo": {"conjunction": "and", "conditions": [{"fieldId": "<STATUS_FIELD_ID>", "operator": "is", "value": "待处理"}]}, "data": {"<STATUS_FIELD_ID>": "进行中"}}}})
```

---

## 工作流 7: 创建多维表仪表盘

> ⚠️ Widget 的 snapshot 必须包含完整配置（chartType、dstId、viewId、xAxisFieldId 等），不能只传 `{"chartType": "pie"}`。写入前**必读** [mtable-widget-guide.md](./mtable-widget-guide.md)。

```
# 1. 确保已有多维表文档和数据表（获取 documentId 和 datasheetId）

# 2. 获取数据表的 viewId 和 fieldId（构造 snapshot 必需）
fabric_call({"tool": "doc_view_list", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DATASHEET_ID>"}})
# 从返回中提取 viewId
fabric_call({"tool": "doc_field_list", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "datasheetId": "<DATASHEET_ID>"}})
# 从返回中提取 xAxisFieldId、yAxisFields 的 fieldId

# 3. 创建仪表盘（可含初始 Widget，snapshot 必须完整）
fabric_call({"tool": "doc_dashboard_create", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "payload": {"name": "数据概览", "template": {"widgets": [{"name": "状态分布", "relativeMetaId": "<DATASHEET_ID>", "snapshot": {"chartType": "pie", "graphType": "basic", "dstId": "<DATASHEET_ID>", "viewId": "<VIEW_ID>", "xAxisFieldId": "<X_FIELD_ID>", "aggregateSameValue": true, "yAxisValueType": "count", "yAxisFields": [{"fieldId": "<Y_FIELD_ID>", "aggregateMethod": "sum"}], "chartUI": ["legend", "dataLabel"], "xAxisSortBy": "xAxisValue", "xAxisSortOrder": "asc"}}]}}}})
# 从返回中提取 nodeId（dashboardId）

# 4. 追加更多 Widget（snapshot 同样必须完整，参考 mtable-widget-guide.md 模板）
fabric_call({"tool": "doc_widget_add", "params": {"locationType": "cloudspace", "documentId": "<DOC_ID>", "dashboardId": "<DASHBOARD_ID>", "payload": {"widget": {"name": "趋势图", "relativeMetaId": "<DATASHEET_ID>", "snapshot": {"chartType": "line", "graphType": "basic", "dstId": "<DATASHEET_ID>", "viewId": "<VIEW_ID>", "xAxisFieldId": "<X_FIELD_ID>", "aggregateSameValue": true, "yAxisValueType": "fieldValue", "yAxisFields": [{"fieldId": "<Y_FIELD_ID>", "aggregateMethod": "sum"}], "chartUI": ["legend", "dataLabel", "axis", "gridLine"], "xAxisSortBy": "xAxisValue", "xAxisSortOrder": "asc"}}}}})
```
