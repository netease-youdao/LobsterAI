# 多维表操作工具参考

所有操作通过 `fabric_call` tool 完成，传入 `tool`（操作名）和 `params`（业务参数）。

> **公共说明**
> - 所有多维表接口统一使用 POST
> - `locationType`：`"cloudspace"`（云空间）或 `"teamspace"`（团队空间）。**选择规则：有 teamSpaceId 时传 `"teamspace"`，无 teamSpaceId 时传 `"cloudspace"`**
> - `documentId`：多维表文档ID，从 `doc_create_doc`（docType=9）或 `doc_search_doc` 返回的 `docId` 获取
> - `datasheetId`：数据表ID，从 `doc_datasheet_list` 返回的 `nodeId` 获取
> - `dashboardId`：仪表盘节点ID，从 `doc_dashboard_create` 返回的 `nodeId` 获取
> - ⚠️ **创建多维表文档后会自带一个默认数据表**，在交付前，必须用 `doc_datasheet_delete` 删除

---

## 一、数据表操作

---

### doc_datasheet_list

查询多维表文档下的所有数据表列表。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型：`cloudspace` / `teamspace` |
| `documentId` | String | 是 | 多维表文档ID |

#### 返回值（数组）

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | String | **数据表ID（后续操作的 datasheetId 从此取）** |
| `nodeName` | String | 数据表名称 |
| `spaceId` | String | 空间ID |
| `preNodeId` | String | 前一个节点ID |
| `type` | String | 节点类型，值为 `"datasheet"` |
| `parentId` | String | 父节点ID |
| `status` | Integer | 状态 |
| `createdAt` | Long | 创建时间（毫秒时间戳） |
| `updatedAt` | Long | 更新时间（毫秒时间戳） |

#### 示例

```
fabric_call({"tool": "doc_datasheet_list", "params": {"locationType": "cloudspace", "documentId": "d305508f33be41ba9de3ed323832393d"}})
```

---

### doc_datasheet_create

在多维表文档下创建新的数据表/收集表。fields字段必传，不能创建不带fields的数据表。（field必须读取 [mtable-field-types.md](./mtable-field-types.md)）。

#### 参数

| 参数 | 类型 | 必填 | 说明                                                                              |
|------|------|----|---------------------------------------------------------------------------------|
| `locationType` | String | 是  | 空间类型：`cloudspace` / `teamspace`                                                 |
| `documentId` | String | 是  | 多维表文档ID                                                                         |
| `payload` | Object | 是  | 创建配置                                                                            |
| `payload.name` | String | 是  | 数据表名称                                                                           |
| `payload.description` | String | 否  | 数据表描述                                                                           |
| `payload.icon` | String | 否  | 图标 emoji                                                                        |
| `payload.template` | Object | 是  | 初始化模板（含字段和视图定义）                                                                 |
| `payload.template.fields` | Array | 是  | 字段列表，必须读取[mtable-field-types.md](./mtable-field-types.md)，按照说明去创建字段
| `payload.template.views` | Array | 否  | 视图列表，每项含 `name`、`type`（1=表格视图，2=看板视图，4=表单视图，6=甘特图视图）                            |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | String | 新数据表ID（即 datasheetId） |
| `name` | String | 数据表名称 |
| `type` | String | 节点类型 `"datasheet"` |
| `parentId` | String | 父节点ID |

#### 示例

```
fabric_call({"tool": "doc_datasheet_create", "params": {"locationType": "cloudspace", "documentId": "doc001", "payload": {"name": "项目任务表", "template": {"fields": [{"name": "任务名称", "type": 1, "property": {}}, {"name": "截止日期", "type": 5, "property": {}}], "views": [{"name": "默认视图", "type": 1}]}}}})
```

---

### doc_datasheet_update

更新数据表的名称或描述。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 更新内容 |
| `payload.name` | String | 否 | 新名称 |

#### 返回值

无返回体（成功时 data 为 null）。

#### 示例

```
fabric_call({"tool": "doc_datasheet_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"name": "新名称"}}})
```

---

### doc_datasheet_duplicate

复制数据表（含结构和数据）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 要复制的数据表ID |
| `payload` | Object | 是 | 可传空对象 `{}` |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | String | 新数据表ID |
| `name` | String | 新数据表名称（原名称+`_副本`） |
| `type` | String | 节点类型 |
| `parentId` | String | 父节点ID |

#### 示例

```
fabric_call({"tool": "doc_datasheet_duplicate", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {}}})
```

---

### doc_datasheet_delete

删除数据表/收集表/仪表盘。**执行前必须与用户二次确认。**

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 要删除的数据表收集表/仪表盘ID |

#### 返回值

无返回体（成功时 data 为 null）。

#### 示例

```
fabric_call({"tool": "doc_datasheet_delete", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001"}})
```

---

## 二、记录操作

---

### doc_record_page

分页查询数据表的记录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `pageNum` | Integer | 否 | 页码，默认 1 |
| `pageSize` | Integer | 否 | 每页条数，默认 20 |
| `selectFields` | Array\<String\> | 否 | 只返回指定 fieldId 的字段，不传则返回全部 |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `records` | Array | 记录列表，每条含 `recordId`、`data`（字段值Map，key为fieldId） |
| `pageNum` | Integer | 当前页码 |
| `pageSize` | Integer | 每页条数 |
| `total` | Integer | 总记录数 |

#### 示例

```
fabric_call({"tool": "doc_record_page", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "pageNum": 1, "pageSize": 20}})
```

---

### doc_record_batch_get

按 recordId 批量查询记录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 查询参数 |
| `payload.recordIds` | Array\<String\> | 是 | recordId 列表 |
| `payload.selectFields` | Array\<String\> | 否 | 只返回指定 fieldId 的字段 |

#### 返回值（数组）

每条记录含 `recordId`、`data`（字段值Map）、`createdAt`、`updatedAt` 等。

#### 示例

```
fabric_call({"tool": "doc_record_batch_get", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"recordIds": ["rec001", "rec002"], "selectFields": ["fld001", "fld002"]}}})
```

---

### doc_record_filter

按条件筛选记录（支持分页游标）。筛选条件结构见 [mtable-filter-guide.md](./mtable-filter-guide.md)。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 筛选参数 |
| `payload.filterInfo` | Object | 否 | 筛选条件（`conjunction` + `conditions`），见 [mtable-filter-guide.md](./mtable-filter-guide.md) |
| `payload.pageSize` | Integer | 否 | 每页条数，默认 20 |
| `payload.pageToken` | String | 否 | 游标分页 token（首页传 null，下一页传上次返回的 `nextPageToken`） |
| `payload.selectFields` | Array\<String\> | 否 | 只返回指定 fieldId 的字段 |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `records` | Array | 记录列表 |
| `total` | Integer | 符合条件的总数 |
| `nextPageToken` | String | 下一页游标（为 null 时无更多数据） |

#### 示例

```
fabric_call({"tool": "doc_record_filter", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"filterInfo": {"conjunction": "and", "conditions": [{"fieldId": "fld001", "operator": "is", "value": "Hello"}]}, "pageSize": 20, "pageToken": null}}})
```

---

### doc_record_batch_create

批量创建记录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 创建参数 |
| `payload.records` | Array\<Object\> | 是 | 记录数组，每条为字段值Map（key=fieldId，value=字段值）。字段值格式见 [mtable-field-types.md](./mtable-field-types.md) |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | Integer | 成功条数 |
| `fail` | Integer | 失败条数 |
| `records` | Array | 创建成功的记录列表（含 recordId） |

#### 示例

```
fabric_call({"tool": "doc_record_batch_create", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"records": [{"fld001": "任务A", "fld002": 100}, {"fld001": "任务B", "fld002": 200}]}}})
```

---

### doc_record_batch_update

按 recordId 批量更新记录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 更新参数 |
| `payload.records` | Array\<Object\> | 是 | 记录数组，每条含 `recordId`（必填）和 `data`（要更新的字段值Map） |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | Integer | 成功条数 |
| `fail` | Integer | 失败条数 |

#### 示例

```
fabric_call({"tool": "doc_record_batch_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"records": [{"recordId": "rec001", "data": {"fld001": "已更新", "fld002": 999}}]}}})
```

---

### doc_record_filter_update

按筛选条件批量更新记录。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 更新参数 |
| `payload.filterInfo` | Object | 是 | 筛选条件，见 [mtable-filter-guide.md](./mtable-filter-guide.md) |
| `payload.data` | Object | 是 | 要更新的字段值Map（key=fieldId，value=新值） |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | Integer | 更新成功条数 |
| `fail` | Integer | 失败条数 |

#### 示例

```
fabric_call({"tool": "doc_record_filter_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"filterInfo": {"conjunction": "and", "conditions": [{"fieldId": "fld001", "operator": "is", "value": "待处理"}]}, "data": {"fld001": "已完成"}}}})
```

---

### doc_record_batch_delete

按 recordId 批量删除记录。**执行前必须与用户二次确认。**

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 删除参数 |
| `payload.recordIds` | Array\<String\> | 是 | 要删除的 recordId 列表 |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | Integer | 删除成功条数 |
| `fail` | Integer | 失败条数 |

#### 示例

```
fabric_call({"tool": "doc_record_batch_delete", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"recordIds": ["rec001", "rec002"]}}})
```

---

### doc_record_filter_delete

按筛选条件批量删除记录。**执行前必须与用户二次确认。**

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 删除参数 |
| `payload.filterInfo` | Object | 是 | 筛选条件，见 [mtable-filter-guide.md](./mtable-filter-guide.md) |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | Integer | 删除成功条数 |
| `fail` | Integer | 失败条数 |

#### 示例

```
fabric_call({"tool": "doc_record_filter_delete", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"filterInfo": {"conjunction": "and", "conditions": [{"fieldId": "fld001", "operator": "is", "value": "已废弃"}]}}}})
```

---

## 三、单元格操作

---

### doc_cell_get

获取单个单元格的值。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `recordId` | String | 是 | 记录ID |
| `fieldId` | String | 是 | 字段ID |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `fieldId` | String | 字段ID |
| `value` | Any | 字段值（类型由字段类型决定） |

#### 示例

```
fabric_call({"tool": "doc_cell_get", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "recordId": "rec001", "fieldId": "fld001"}})
```

---

### doc_cell_update

更新单个单元格的值。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `recordId` | String | 是 | 记录ID |
| `fieldId` | String | 是 | 字段ID |
| `payload` | Object | 是 | 更新参数 |
| `payload.value` | Any | 是 | 新值，格式见 [mtable-field-types.md](./mtable-field-types.md) |

#### 返回值

无返回体（成功时 data 为 null）。

#### 示例

```
fabric_call({"tool": "doc_cell_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "recordId": "rec001", "fieldId": "fld001", "payload": {"value": "新内容"}}})
```

---

## 四、文件操作

---

### doc_file_batch_get

批量获取附件字段中的文件信息（含下载URL）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 查询参数 |
| `payload.fileRequests` | Object | 是 | 嵌套Map，格式：`{ fieldId: { recordId: [fileId, ...] } }` |

#### 返回值（Map）

key 为 fileId，value 为文件信息对象，含 `fileId`、`fileName`、`fileType`、`url`、`fileSize`、`mimeType`、`md5` 等。

#### 示例

```
fabric_call({"tool": "doc_file_batch_get", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"fileRequests": {"fldAttach001": {"rec001": ["file_a", "file_b"]}}}}})
```

---

### doc_file_upload_token

获取文件上传 Token（上传后调用 `doc_file_save` 保存）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 文件元信息 |
| `payload.fileName` | String | 是 | 文件名（含扩展名） |
| `payload.fileSize` | Long | 是 | 文件大小（字节） |
| `payload.mimeType` | String | 是 | MIME类型（如 `"application/pdf"`） |
| `payload.md5` | String | 是 | 文件 MD5 |
| `payload.permission` | Integer | 否 | 权限（0=私有，默认0） |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `uploadUrl` | String | 上传地址 |
| `token` | String | 上传凭证 |
| `permission` | Integer | 权限 |

#### 示例

```
fabric_call({"tool": "doc_file_upload_token", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"fileName": "report.pdf", "fileSize": 1048576, "mimeType": "application/pdf", "md5": "d41d8cd98f00b204e9800998ecf8427e"}}})
```

---

### doc_file_save

上传完成后保存文件记录（获取可用的 fileId）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `payload` | Object | 是 | 文件信息 |
| `payload.pong` | String | 是 | 上传凭证回调（从上传响应中获取） |
| `payload.fileName` | String | 是 | 文件名 |
| `payload.fileType` | String | 是 | 文件扩展名类型（如 `"pdf"`） |
| `payload.url` | String | 是 | 文件访问地址 |
| `payload.fileSize` | Long | 是 | 文件大小（字节） |
| `payload.mimeType` | String | 是 | MIME类型 |
| `payload.md5` | String | 是 | 文件 MD5 |
| `payload.partSize` | Long | 否 | 分片大小（非分片上传传 null） |
| `payload.partMd5` | String | 否 | 分片 MD5（非分片上传传 null） |
| `payload.picSize` | Object | 否 | 图片尺寸（图片文件可传） |
| `payload.color` | String | 否 | 主色调 |
| `payload.videoCover` | String | 否 | 视频封面 |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `fileId` | String | 文件ID（用于写入附件字段） |
| `fileName` | String | 文件名 |
| `fileType` | String | 文件类型 |
| `fileSize` | Long | 文件大小 |
| `mimeType` | String | MIME类型 |

#### 示例

```
fabric_call({"tool": "doc_file_save", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "payload": {"pong": "abc123xyz", "fileName": "report.pdf", "fileType": "pdf", "url": "https://fp.example.com/files/abc123.pdf", "fileSize": 1048576, "mimeType": "application/pdf", "md5": "d41d8cd98f00b204e9800998ecf8427e"}}})
```

---

## 五、视图操作

---

### doc_view_list

获取数据表的视图列表。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `views` | Array | 视图列表，每条含 `id`（viewId）、`name`、`type`（1=表格视图，2=看板视图，4=表单视图，6=甘特图视图）、`filterInfo`、`sortInfo`、`groupInfo` 等 |

#### 示例

```
fabric_call({"tool": "doc_view_list", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001"}})
```

---

### doc_view_create

创建新视图。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `view` | Object | 是 | 视图配置 |
| `view.name` | String | 是 | 视图名称 |
| `view.type` | Integer | 是 | 视图类型（1=表格视图，2=看板视图，4=表单视图，6=甘特图视图） |
| `view.property.filterInfo` | Object | 否 | 视图筛选条件，结构为 `{"conjunction":"and","conditions":[...]}` ，详见 [mtable-filter-guide.md](./mtable-filter-guide.md) |
| `view.property.sortInfo` | Object | 否 | 视图排序配置，结构为 `{"keepSort":true,"rules":[{"fieldId":"<FIELD_ID>","desc":false}]}`。`keepSort`=是否持久排序，`rules`=排序规则数组（`fieldId`=排序字段，`desc`=true降序/false升序） |
| `view.property.groupInfo` | Object | 否 | 视图分组配置（按字段对记录进行分组展示） |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | 新视图ID（viewId） |
| `name` | String | 视图名称 |
| `type` | Integer | 视图类型 |

#### 示例

基本创建（不含筛选/排序）：

```
fabric_call({"tool": "doc_view_create", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "view": {"name": "进行中视图", "type": 1}}})
```

创建带筛选和排序的视图：

```
fabric_call({"tool": "doc_view_create", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "view": {"name": "进行中-按日期排序", "type": 1, "property": {"filterInfo": {"conjunction": "and", "conditions": [{"fieldId": "fld001", "operator": "is", "value": "进行中"}]}, "sortInfo": {"keepSort": true, "rules": [{"fieldId": "fld002", "desc": false}]}}}}})
```

---

### doc_view_update

更新视图属性（名称、筛选、排序等）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `viewId` | String | 是 | 视图ID |
| `updates` | Object | 是 | 更新内容 |
| `updates.name` | String | 否 | 视图名称 |
| `updates.filterInfo` | Object | 否 | 视图筛选条件，结构为 `{"conjunction":"and","conditions":[...]}` ，详见 [mtable-filter-guide.md](./mtable-filter-guide.md) |
| `updates.sortInfo` | Object | 否 | 视图排序配置，结构为 `{"keepSort":true,"rules":[{"fieldId":"<FIELD_ID>","desc":false}]}`。`keepSort`=是否持久排序，`rules`=排序规则数组（`fieldId`=排序字段，`desc`=true降序/false升序） |
| `updates.groupInfo` | Object | 否 | 视图分组配置（按字段对记录进行分组展示） |

#### 返回值

更新后的完整视图对象（含 `id`、`name`、`type`、`filterInfo` 等）。

#### 示例

更新视图名称：

```
fabric_call({"tool": "doc_view_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "viewId": "viw001", "updates": {"name": "重命名视图"}}})
```

为视图设置筛选条件：

```
fabric_call({"tool": "doc_view_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "viewId": "viw001", "updates": {"filterInfo": {"conjunction": "and", "conditions": [{"fieldId": "fld001", "operator": "is", "value": "已完成"}]}}}})
```

为视图设置排序（按日期升序）：

```
fabric_call({"tool": "doc_view_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "viewId": "viw001", "updates": {"sortInfo": {"keepSort": true, "rules": [{"fieldId": "fld002", "desc": false}]}}}})
```

---

### doc_view_duplicate

复制视图。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `viewId` | String | 是 | 要复制的视图ID |

#### 返回值

新视图对象（含新 `id` 和 `name`，名称为原名+`_副本`）。

#### 示例

```
fabric_call({"tool": "doc_view_duplicate", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "viewId": "viw001"}})
```

---

### doc_view_delete

删除视图。**执行前必须与用户二次确认。**

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `viewId` | String | 是 | 要删除的视图ID |

#### 返回值

无返回体（成功时 data 为 null）。

#### 示例

```
fabric_call({"tool": "doc_view_delete", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "viewId": "viw001"}})
```

---

## 六、字段操作

---

### doc_field_list

获取数据表的字段（列）列表。**操作记录前必须先调用此接口确认 fieldId。**

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `fields` | Array | 字段列表，每条含 `id`（fieldId）、`name`、`type`（见 [mtable-field-types.md](./mtable-field-types.md)）、`property` |

#### 示例

```
fabric_call({"tool": "doc_field_list", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001"}})
```

---

### doc_field_create

在数据表中创建新字段（列）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `field` | Object | 是 | 字段配置 |
| `field.name` | String | 是 | 字段名称 |
| `field.type` | Integer | 是 | 字段类型，见 [mtable-field-types.md](./mtable-field-types.md) |
| `field.property` | Object | 否 | 字段属性（类型相关，如单选的 options） |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | String | 新字段ID（fieldId） |
| `name` | String | 字段名称 |
| `type` | Integer | 字段类型 |
| `property` | Object | 字段属性 |
| `isPrimary` | Boolean | 是否主字段 |

#### 示例

```
fabric_call({"tool": "doc_field_create", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "field": {"name": "优先级", "type": 3, "property": {"options": [{"name": "高"}, {"name": "中"}, {"name": "低"}]}}}})
```

---

### doc_field_update

更新字段属性（名称、配置等）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `fieldId` | String | 是 | 字段ID |
| `updates` | Object | 是 | 更新内容，可包含 `name`、`property` |

#### 返回值

更新后的完整字段对象（含 `id`、`name`、`type`、`property` 等）。

#### 示例

```
fabric_call({"tool": "doc_field_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "fieldId": "fld002", "updates": {"name": "数量(件)", "property": {"precision": 0}}}})
```

---

### doc_field_reorder

调整视图中字段（列）的显示顺序。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `viewId` | String | 是 | 视图ID（排序仅影响该视图的列顺序） |
| `fieldMoves` | Array | 是 | 移动指令数组，每条含 `fieldId`（字段ID）和 `newIndex`（目标位置，0-based） |

#### 返回值

无返回体（成功时 data 为 null）。

#### 示例

```
fabric_call({"tool": "doc_field_reorder", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "viewId": "viw001", "fieldMoves": [{"fieldId": "fld002", "newIndex": 0}, {"fieldId": "fld001", "newIndex": 1}]}})
```

---

### doc_field_delete

删除数据表字段（列）及其所有数据。**执行前必须与用户二次确认。**

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `datasheetId` | String | 是 | 数据表ID |
| `fieldId` | String | 是 | 要删除的字段ID |

#### 返回值

无返回体（成功时 data 为 null）。

#### 示例

```
fabric_call({"tool": "doc_field_delete", "params": {"locationType": "cloudspace", "documentId": "doc001", "datasheetId": "dst001", "fieldId": "fld003"}})
```

---

## 七、仪表盘操作
---

### doc_dashboard_list

获取所有仪表盘。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |

#### 返回值

| 字段 | 类型 | 说明       |
|------|------|----------|
| `nodeId` | String | 仪表盘节点ID  |
| `nodeName` | String | 仪表盘名称    |

#### 示例

```
fabric_call({"tool": "doc_dashboard_list", "params": {"locationType": "cloudspace", "documentId": "doc001"}})
```
---

### doc_dashboard_detail

获取仪表盘详情（含 Widget 列表）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `dashboardId` | String | 是 | 仪表盘节点ID |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `node` | Object | 仪表盘节点信息（nodeId、nodeName、type 等） |
| `meta` | Object | 仪表盘元数据 |
| `views` | Array | Widget 列表 |

#### 示例

```
fabric_call({"tool": "doc_dashboard_detail", "params": {"locationType": "cloudspace", "documentId": "doc001", "dashboardId": "dsb001"}})
```

---

### doc_dashboard_create

在多维表文档下创建仪表盘。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `payload` | Object | 是 | 创建配置 |
| `payload.name` | String | 是 | 仪表盘名称 |
| `payload.template` | Object | 否 | 初始模板（可含 widgets 列表） |
| `payload.template.widgets` | Array | 否 | 初始 Widget 列表，每条含 `name`、`relativeMetaId`（关联数据表ID）、`snapshot`（图表配置，见 [mtable-widget-guide.md](./mtable-widget-guide.md)） |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | String | 新仪表盘ID（后续操作的 dashboardId 从此取） |
| `name` | String | 仪表盘名称 |
| `type` | String | 节点类型 `"dashboard"` |
| `parentId` | String | 父节点ID |

#### 示例

```
fabric_call({"tool": "doc_dashboard_create", "params": {"locationType": "cloudspace", "documentId": "doc001", "payload": {"name": "数据大屏"}}})
```

---

## 八、Widget 操作

> Widget 操作详细配置参考 [mtable-widget-guide.md](./mtable-widget-guide.md)。

---

### doc_widget_add

向仪表盘添加 Widget（图表）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `dashboardId` | String | 是 | 仪表盘ID |
| `payload` | Object | 是 | Widget 参数 |
| `payload.widget` | Object | 是 | Widget 配置 |
| `payload.widget.name` | String | 是 | Widget 名称 |
| `payload.widget.relativeMetaId` | String | 是 | 关联数据表ID（datasheetId） |
| `payload.widget.snapshot` | Object | 是 | 图表配置（chartType 等），见 [mtable-widget-guide.md](./mtable-widget-guide.md) |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `widgetId` | String | 新 Widget ID |
| `name` | String | Widget 名称 |
| `relativeMetaId` | String | 关联数据表ID |
| `nodeId` | String | 所属仪表盘ID |
| `snapshot` | Object | 图表配置 |
| `layout` | Object | 布局位置（x、y、w、h） |

#### 示例

```
fabric_call({"tool": "doc_widget_add", "params": {"locationType": "cloudspace", "documentId": "doc001", "dashboardId": "dsb001", "payload": {"widget": {"name": "销售柱状图", "relativeMetaId": "dst001", "snapshot": {"chartType": "bar", "graphType": "basic", "dstId": "dst001", "viewId": "viw001", "xAxisFieldId": "fld001", "aggregateSameValue": true, "yAxisValueType": "count", "yAxisFields": [{"fieldId": "fld001", "aggregateMethod": "sum"}], "chartUI": ["legend", "dataLabel", "axis", "gridLine"], "xAxisSortBy": "xAxisValue", "xAxisSortOrder": "asc"}}}}})
```

---

### doc_widget_update

更新 Widget 配置（名称、关联数据表、图表类型等）。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `dashboardId` | String | 是 | 仪表盘ID |
| `widgetId` | String | 是 | Widget ID |
| `payload` | Object | 是 | 更新参数 |
| `payload.updates` | Object | 是 | 更新内容，可含 `name`、`relativeMetaId`、`snapshot` |

#### 返回值

更新后的完整 Widget 对象（含 widgetId、name、snapshot、layout 等）。

#### 示例

```
fabric_call({"tool": "doc_widget_update", "params": {"locationType": "cloudspace", "documentId": "doc001", "dashboardId": "dsb001", "widgetId": "wgt001", "payload": {"updates": {"name": "新图表名", "snapshot": {"chartType": "line"}}}}})
```

---

### doc_widget_delete

删除仪表盘中的 Widget。**执行前必须与用户二次确认。**

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `locationType` | String | 是 | 空间类型 |
| `documentId` | String | 是 | 多维表文档ID |
| `dashboardId` | String | 是 | 仪表盘ID |
| `widgetId` | String | 是 | 要删除的 Widget ID |

#### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | Boolean | 是否成功 |

#### 示例

```
fabric_call({"tool": "doc_widget_delete", "params": {"locationType": "cloudspace", "documentId": "doc001", "dashboardId": "dsb001", "widgetId": "wgt001"}})
```
