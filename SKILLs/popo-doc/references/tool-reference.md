# POPO 文档工具参考

所有操作通过 `fabric_call` tool 完成，传入 `tool`（操作名）和 `params`（业务参数）。

---

## doc_create_doc

创建文档、文件夹、表格或多维表。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `docType` | Integer | 是 | 文档类型: 0-文件夹, 1-POPO文档, 2-POPO表格, 9-多维表 |
| `title` | String | 是 | 文档标题 |
| `parentId` | String | 否 | 父文件夹ID，默认根目录 |
| `teamSpaceId` | String | 否 | 团队空间ID，传递则创建在团队空间 |

### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `docId` | String | 文档ID |
| `url` | String | 文档访问URL |
| `type` | Integer | 文档类型（同 docType：0/1/2/9） |
| `teamSpaceId` | String | 团队空间ID(仅团队空间文档返回) |

### 示例

```
fabric_call({"tool": "doc_create_doc", "params": {"docType": 1, "title": "项目周报", "parentId": "abc123"}})

fabric_call({"tool": "doc_create_doc", "params": {"docType": 0, "title": "项目资料"}})

fabric_call({"tool": "doc_create_doc", "params": {"docType": 2, "title": "数据统计", "teamSpaceId": "ts_xxx"}})
```

---

## doc_delete_doc

删除文档、文件夹、表格或多维表。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `docId` | String | 是 | 文档ID |
| `teamSpaceId` | String | 否 | 团队空间ID，传递则删除团队空间文档，不传则删除云空间文档 |

### 返回值

无返回体 (成功返回 status=1)。

### 示例

```
fabric_call({"tool": "doc_delete_doc", "params": {"docId": "abc123"}})

fabric_call({"tool": "doc_delete_doc", "params": {"docId": "page_xxx", "teamSpaceId": "ts_xxx"}})
```

---

## doc_search_doc

文档语义检索，支持搜索文档、表格、多维表，支持时间、权限等多维表语义，直接传入用户的原始query即可，不需要你做query改写。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | String | 是 | 检索查询(语义搜索) |

### 返回值 (数组)

| 字段 | 类型 | 说明 |
|------|------|------|
| `docId` | String | 文档ID(团队空间为pageId) |
| `title` | String | 文档标题 |
| `url` | String | 文档访问URL |
| `type` | Integer | 文档类型 |

> 返回值不含 `teamSpaceId`。如搜到团队空间文档（URL 含 `/team/`），需通过 `doc_get_folder_path` 传入该 URL 来获取 `teamSpaceId`。

### 示例

```
fabric_call({"tool": "doc_search_doc", "params": {"query": "季度总结报告"}})
```

---

## doc_get_doc_detail

获取文档详情，包含元信息和内容(仅POPO文档有 content)。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `docIdOrUrl` | String | 是 | 文档ID或文档URL |

### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | String | 文档标题 |
| `creatorName` | String | 创建者姓名 |
| `createdAt` | String | 创建时间，ISO-8601 格式（如 `2024-01-15T10:30:00+08:00`） |
| `ownerName` | String | 所有者姓名 |
| `viewCount` | Integer | 总浏览次数 |
| `userViewCount` | Integer | 用户浏览次数 |
| `fileSize` | Long | 文件大小(字节) |
| `content` | String | 文档内容(自定义HTML格式，仅POPO文档类型)。返回的标签带 `id` 属性，用于 doc_update_doc 按块更新。格式见 [content-format.md](./content-format.md) |
| `type` | Integer | 文档类型: 0-文件夹, 1-POPO文档, 2-POPO表格, 9-多维表 |

### 示例

```
fabric_call({"tool": "doc_get_doc_detail", "params": {"docIdOrUrl": "abc123"}})

fabric_call({"tool": "doc_get_doc_detail", "params": {"docIdOrUrl": "https://docs.popo.netease.com/doc/xxx"}})
```

---

## doc_update_doc

修改文档标题（全部类型）或内容（仅POPO文档）。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `docId` | String | 是 | 文档ID或pageId |
| `title` | String | 否 | 新标题 |
| `command` | Object | 否 | 编辑命令，支持 `doc.replace_node`/`doc.insert_before`/`doc.insert_after`。`doc.insert_after` 不传 `nodeId` 时内容追加到文档末尾。详见 [content-format.md](./content-format.md#updateDoc-command-格式) |
| `teamSpaceId` | String | 否 | 团队空间ID，传递则修改团队空间文档 |

> `title` 和 `command` 至少传一个。

### 返回值

无返回体 (成功返回 status=1)。

### 示例

```
fabric_call({"tool": "doc_update_doc", "params": {"docId": "abc123", "title": "新标题"}})

fabric_call({"tool": "doc_update_doc", "params": {"docId": "abc123", "command": {"type": "doc.replace_node", "nodeId": "node_1", "content": "<p>新内容</p>"}}})

fabric_call({"tool": "doc_update_doc", "params": {"docId": "page_xxx", "title": "新标题", "teamSpaceId": "ts_xxx"}})
```

---

## doc_get_comments

获取文档或表格的评论列表(分页)。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `docId` | String | 是 | 文档ID(云空间为docId，团队空间为pageId) |
| `teamSpaceId` | String | 否 | 团队空间ID，传递则查询团队空间文档评论 |
| `pageNum` | Integer | 否 | 页码，默认1 |
| `pageSize` | Integer | 否 | 每页条数，默认20，最大50 |

### 返回值 (分页)

```json
{
  "total": 100,
  "pageNum": 1,
  "pageSize": 20,
  "list": [
    {
      "commentId": "...",
      "content": "评论内容",
      "author": "作者",
      "createTime": "2024-01-15T10:30:00+08:00",
      "updateTime": "2024-01-15T10:30:00+08:00",
      "replies": [...]
    }
  ]
}
```

### 示例

```
fabric_call({"tool": "doc_get_comments", "params": {"docId": "abc123", "pageNum": 1, "pageSize": 20}})

fabric_call({"tool": "doc_get_comments", "params": {"docId": "page_xxx", "teamSpaceId": "ts_xxx"}})
```

---

## doc_get_folder_path

通过文档 URL 解析文件夹 ID。用于从已知 URL 提取 folderId 和 teamSpaceId。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | String | 是 | 文档URL |

### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `folderId` | String | 文件夹ID |
| `teamSpaceId` | String | 团队空间ID(仅团队空间文档返回) |

### 示例

```
fabric_call({"tool": "doc_get_folder_path", "params": {"url": "https://docs.popo.netease.com/team/xxx/folder/yyy"}})
```

---

## doc_search_folder_path

通过关键词搜索文件夹(包含云空间和团队空间)。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyword` | String | 是 | 搜索关键词 |

### 返回值 (数组)

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | String | 文件夹名称 |
| `url` | String | 访问地址 |
| `folderId` | String | 文件夹ID |
| `teamSpaceId` | String | 团队空间ID(仅团队空间文件夹有值) |

### 示例

```
fabric_call({"tool": "doc_search_folder_path", "params": {"keyword": "项目资料"}})
```

---

## doc_get_file_download_url

获取文档内嵌文件的临时下载地址(预签名URL)。

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `docId` | String | 是 | 云空间为docId，团队空间为pageId |
| `teamSpaceId` | String | 否 | 团队空间ID(传值表示团队空间文档) |
| `urls` | List\<String\> | 是 | 未签名的POPO文件下载地址列表 |

### 返回值

| 字段 | 类型 | 说明 |
|------|------|------|
| `downloadUrls` | Map\<String, String\> | key为原链接，value为预签名下载地址 |

### 示例

```
fabric_call({"tool": "doc_get_file_download_url", "params": {"docId": "abc123", "urls": ["https://nos.netease.com/xxx/file1.png", "https://nos.netease.com/xxx/file2.pdf"]}})
```
