# 筛选条件构造指南

本文件描述如何构造筛选条件（`filterInfo`）。适用于以下场景：
- **记录筛选**：`doc_record_filter`、`doc_record_filter_update`、`doc_record_filter_delete`
- **视图筛选**：`doc_view_create`（通过 `view.property.filterInfo`）、`doc_view_update`（通过 `updates.filterInfo`）

---

## 返回格式

`doc_record_filter` 返回标准响应结构：

```json
{
  "status": 1,
  "message": "success",
  "data": {
    "records": [
      {
        "recordId": "recXXXXXXXXXXXXXXXXX",
        "data": {
          "fld001": "字段值",
          "fld002": 123
        }
      }
    ],
    "total": 100
  }
}
```

- `records`: 记录数组，每项包含 `recordId` 和 `data`（字段值映射）
- `total`: 符合条件的总记录数（用于分页）
- 默认返回最多 1000 条记录
- 支持分页参数：`pageNum`（页码，从1开始）、`pageSize`（每页条数，最大1000）

---

## 筛选结构

```json
{
  "conjunction": "and",
  "conditions": [
    { "fieldId": "fld001", "operator": "is", "value": "某个值" },
    { "fieldId": "fld002", "operator": "isEmpty", "value": null }
  ]
}
```

- `conjunction`：`"and"`（所有条件都满足）或 `"or"`（任一条件满足）
- `conditions`：条件数组，每个条件包含 `fieldId`、`operator`、`value`

## 核心规则

1. **fieldId 必须从 `doc_field_list` 获取** — 不可编造
2. **operator 必须在该字段类型支持的范围内** — 见下方各类型支持表
3. **value 的格式因字段类型而异** — 这是筛选 OpenFilterValue，和写入 OpenValue 不同
4. **isEmpty/isNotEmpty 的 value 为 null** — 不需要传值

## 禁忌

- **不要混淆 OpenValue 和 OpenFilterValue** — 筛选单选字段用 `"选项名"` (string)，不是 `{id, name}` (object)
- **不要对不支持的字段类型使用 contains** — 数字/日期不支持 contains
- **不要对附件字段使用 is/isNot** — 附件只支持 isEmpty/isNotEmpty

---

## 操作符总览

> ⚠️ **操作符必须使用英文字符串**，禁止使用 `>`、`>=`、`<`、`<=`、`==` 等符号。

| 操作符 | 适用范围 |
|--------|---------|
| `is` | 文本/数字/单选/多选/日期/复选框/评分/成员/网址/创建人/创建时间 |
| `isNot` | 文本/数字/单选/多选/成员/网址/创建人 |
| `contains` | 文本/单选/多选/成员/网址/创建人 |
| `doesNotContain` | 文本/单选/多选/成员/网址/创建人 |
| `isGreater` | 数字/日期/评分/创建时间 |
| `isGreaterEqual` | 数字/评分 |
| `isLess` | 数字/日期/评分/创建时间 |
| `isLessEqual` | 数字/评分 |
| `isEmpty` | 全部类型 |
| `isNotEmpty` | 全部类型 |

## 各字段类型的 FilterValue 格式

### 文本 (type=1) / 网址 (type=8)

```json
{ "fieldId": "fld001", "operator": "contains", "value": "关键词" }
```

value：`string` 或 `null`（isEmpty/isNotEmpty）

支持操作符：is, isNot, contains, doesNotContain, isEmpty, isNotEmpty

---

### 数字 (type=2) / 评分 (type=12)

```json
{ "fieldId": "fld002", "operator": "isGreater", "value": 100 }
```

value：`number` 或 `null`

支持操作符：is, isNot, isGreater, isGreaterEqual, isLess, isLessEqual, isEmpty, isNotEmpty

---

### 单选 (type=3)

```json
{ "fieldId": "fld003", "operator": "is", "value": "已完成" }
```

value：`string`（选项名称），**不是** `{id, name}` 对象

支持操作符：is, isNot, contains, doesNotContain, isEmpty, isNotEmpty

---

### 多选 (type=4)

```json
{ "fieldId": "fld004", "operator": "contains", "value": ["紧急", "重要"] }
```

value：`string[]`（选项名称数组）

支持操作符：is, isNot, contains, doesNotContain, isEmpty, isNotEmpty

---

### 复选框 (type=11)

```json
{ "fieldId": "fld005", "operator": "is", "value": true }
```

value：`boolean`

支持操作符：is

---

### 附件 (type=6)

```json
{ "fieldId": "fld006", "operator": "isEmpty", "value": null }
```

**仅支持**：isEmpty, isNotEmpty

---

### 成员 (type=13) / 创建人 (type=23)

```json
{ "fieldId": "fld007", "operator": "is", "value": { "uid": "user_xxx" } }
```

```json
{ "fieldId": "fld007", "operator": "contains", "value": ["user_xxx", "user_yyy"] }
```

value 支持多种格式：
- `string`（单个 uid）
- `string[]`（多个 uid）
- `{ uid: string }`（对象）
- `{ uid: string }[]`（对象数组）

支持操作符：is, isNot, contains, doesNotContain, isEmpty, isNotEmpty

---

### 日期 (type=5) / 创建时间 (type=21)

日期筛选是最复杂的类型，支持多种特殊语法。

**精确日期**：

```json
{ "fieldId": "fld008", "operator": "is", "value": ["ExactDate", 1711353600000] }
```

**日期范围**：

```json
{ "fieldId": "fld008", "operator": "is", "value": ["DateRange", 1711353600000, 1711440000000] }
```

范围也可以传 null 表示开放边界：

```json
{ "fieldId": "fld008", "operator": "is", "value": ["DateRange", null] }
```

**N 天前**：

```json
{ "fieldId": "fld008", "operator": "is", "value": ["SomeDayBefore", 7] }
```

**N 天后**：

```json
{ "fieldId": "fld008", "operator": "is", "value": ["SomeDayAfter", 3] }
```

**相对日期快捷词**：

```json
{ "fieldId": "fld008", "operator": "is", "value": ["Today"] }
{ "fieldId": "fld008", "operator": "is", "value": ["Tomorrow"] }
{ "fieldId": "fld008", "operator": "is", "value": ["Yesterday"] }
{ "fieldId": "fld008", "operator": "is", "value": ["ThisWeek"] }
{ "fieldId": "fld008", "operator": "is", "value": ["PreviousWeek"] }
{ "fieldId": "fld008", "operator": "is", "value": ["ThisMonth"] }
{ "fieldId": "fld008", "operator": "is", "value": ["PreviousMonth"] }
{ "fieldId": "fld008", "operator": "is", "value": ["ThisYear"] }
{ "fieldId": "fld008", "operator": "is", "value": ["TheLastWeek"] }
{ "fieldId": "fld008", "operator": "is", "value": ["TheNextWeek"] }
{ "fieldId": "fld008", "operator": "is", "value": ["TheLastMonth"] }
{ "fieldId": "fld008", "operator": "is", "value": ["TheNextMonth"] }
```

**清空筛选**：

```json
{ "fieldId": "fld008", "operator": "is", "value": null }
```

支持操作符：is, isGreater, isLess, isEmpty, isNotEmpty

---

## Recipes

### 筛选"状态=已完成"的记录

```json
{
  "conjunction": "and",
  "conditions": [
    { "fieldId": "fld002", "operator": "is", "value": "已完成" }
  ]
}
```

### 筛选"本月创建且评分>=3"的记录

```json
{
  "conjunction": "and",
  "conditions": [
    { "fieldId": "fld_created_time", "operator": "is", "value": ["ThisMonth"] },
    { "fieldId": "fld_rating", "operator": "isGreaterEqual", "value": 3 }
  ]
}
```

### 筛选"负责人是张三 或 状态=紧急"的记录

```json
{
  "conjunction": "or",
  "conditions": [
    { "fieldId": "fld_member", "operator": "is", "value": { "uid": "user_zhangsan" } },
    { "fieldId": "fld_status", "operator": "is", "value": "紧急" }
  ]
}
```

### 筛选"7天内截止且未完成"的记录

```json
{
  "conjunction": "and",
  "conditions": [
    { "fieldId": "fld_deadline", "operator": "isLess", "value": ["SomeDayAfter", 7] },
    { "fieldId": "fld_done", "operator": "is", "value": false }
  ]
}
```
