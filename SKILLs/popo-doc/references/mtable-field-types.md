# 字段类型手册

本文件描述多维表格的字段类型系统，适用于：

- `doc_datasheet_create` 的 `template` 参数 — 建表时定义字段结构
- `doc_field_create` — 给已有表添加字段
- `doc_record_batch_create` / `doc_record_batch_update` — 写入记录时的值格式
- 读取记录返回值的解读

---

## 字段类型枚举总表

> ⚡ **Agent 速查编号用**——不确定 type 值时查此表，不要凭记忆猜。注意编号**不连续**（无 7、9、10、14-20、22、24-25）。

### 可创建字段类型（13 种）

| 分类 | type 值 | 英文名 | 中文名 | 可写入值 |
|------|---------|--------|-------|---------|
| 基础 | 1 | Text | 文本 | ✅ |
| 基础 | 2 | Number | 数字 | ✅ |
| 基础 | 3 | SingleSelect | 单选 | ✅ |
| 基础 | 4 | MultiSelect | 多选 | ✅ |
| 基础 | 5 | DateTime | 时间 | ✅ |
| 基础 | 6 | Attachment | 图片和附件 | ✅ |
| 基础 | 8 | URL | 超链接 | ✅ |
| 基础 | 11 | Checkbox | 复选框 | ✅ |
| 基础 | 12 | Rating | 评分 | ✅ |
| 基础 | 13 | Member | 人员 | ✅ |
| 高级 | 21 | CreatedTime | 创建时间 | ❌ 只读 |
| 高级 | 23 | CreatedBy | 创建人 | ❌ 只读 |
| 高级 | 26 | Formula | 公式 | ❌ 只读 |

---

## 核心规则

1. **写入前必须先 `doc_field_list` 确认字段结构** — 不可猜测 fieldId，必须从返回中提取
2. **只读字段不可写入值** — Formula(26)/CreatedBy(23)/CreatedTime(21) 只能创建字段配置
3. **单选/多选写入支持两种格式** — 字符串（推荐，如 `"已完成"`）或对象（如 `{"name":"已完成"}` / `{"id":"optXXX"}`），对象格式可通过 `name` 或 `id` 匹配选项
4. **日期推荐写入毫秒时间戳，也支持日期字符串** — 时间戳可避免时区歧义
5. **字段值为空时不传该字段** — 不要传空字符串 `""`、空数组 `[]` 或 `null`，直接省略该 key

## 禁忌

- **不要用字段名作为记录 data 的 key** — 必须用 `fieldId`
- **不要向只读字段写入值** — Formula(26)、CreatedBy(23)、CreatedTime(21) 不接受写入
- **不要在单选/多选的选项名中使用 emoji 或特殊字符** — 如 `"✅ 已完成"`、`"🔥紧急"` 应改为 `"已完成"`、`"紧急"`，避免渲染和匹配异常

---

## 字段零件清单

### 文本 (Text, type=1)

**创建字段**：

```json
{ "name": "备注", "type": 1 }
```

property 可选，通常为 null。如需默认值：

```json
{ "name": "备注", "type": 1, "property": { "defaultValue": [{ "text": "默认内容", "type": "text" }] } }
```

**写入 OpenValue**：`"字符串内容"`

**读取 OpenValue**：`"字符串内容"`

---

### 数字 (Number, type=2)

**创建字段**：

```json
{ "name": "金额", "type": 2, "property": { "precision": 2 } }
```

property 选项：
- `formatType`：0=None, 1=Integer, 2=Thousand, 3=ThousandWithDecimal, 4=Decimal, 5=Percent, 6=PercentWithDecimal
- `precision`：小数位数，0~1000
- `defaultValue`：默认数值

**写入 OpenValue**：`123.45`（number 类型）

**读取 OpenValue**：`123.45`

---

### 单选 (SingleSelect, type=3)

**创建字段**：

```json
{
  "name": "状态",
  "type": 3,
  "property": {
    "options": [
      { "name": "待处理", "color": "--color-neutral-dark" },
      { "name": "进行中", "color": "--color-warning-base" },
      { "name": "已完成", "color": "--color-success-base" }
    ]
  }
}
```

> ⚠️ `doc_datasheet_create` 模板建表时，options 的 `id` 和 `color` **可选**，后端会自动生成。`doc_field_create` 单独创建字段时同理。若手动指定 `id`，格式为 `opt` + 17 位字母数字（如 `optAbc123Xyz456789`）。

property 选项：
- `options`：选项数组，每项含 `name`（必填）、`id`（可选）、`color`（可选）
- `showWay`：`"tiling"` 或 `"dropdown"`

> ⚠️ **color 语义自检（仅在构造 options 时执行）**：对每个选项，先判断它在该字段语境下的语义类型，再强制映射 color——不可凭直觉随机指定：
> - 正面结果（完成/通过/成功/正常/恢复）→ `--color-success-base`
> - 负面结果（失败/拒绝/故障/流失/阻塞）→ `--color-danger-base`
> - 中间过程（进行中/审批中/告警/降级）→ `--color-warning-base`
> - 中性初始（未开始/草稿/未知/待处理）→ `--color-neutral-dark`
> - 纯分类标签（无好坏之分）→ `info / primary / accent / neutral` 按视觉区分度选择
> - 需要更柔和配色时，使用 `-light`、`-lighter`、`-lightest` 变体（如 `--color-success-light`）；`neutral` 例外，其变体为 `light / medium / strong / darkest`（无 `-lighter` / `-lightest`）

**写入 OpenValue**：`"待处理"`（string，推荐）或 `{ "name": "待处理" }` / `{ "id": "optXXX" }`（对象格式）

**读取 OpenValue**：`{ "id": "optABCDEFGH12345678", "name": "待处理", "color": "--color-neutral-dark" }`

**筛选 OpenFilterValue**：`"待处理"`（string，同写入格式）

---

### 多选 (MultiSelect, type=4)

**创建字段**：

```json
{
  "name": "标签",
  "type": 4,
  "property": {
    "options": [
      { "name": "紧急", "color": "--color-danger-base" },
      { "name": "重要", "color": "--color-warning-base" },
      { "name": "日常", "color": "--color-info-base" }
    ]
  }
}
```

property 同单选。

**写入 OpenValue**（数组）：`["紧急", "重要"]`（string 数组，推荐）或 `[{ "name": "紧急" }, { "name": "重要" }]`（对象数组格式）

**读取 OpenValue**：

```json
[
  { "id": "optAAAAAAAAAAAAAABBB", "name": "紧急", "color": "--color-danger-base" },
  { "id": "optCCCCCCCCCCCCCCDDD", "name": "重要", "color": "--color-warning-base" }
]
```

（读取返回对象数组格式）

**筛选 OpenFilterValue**：`["紧急", "重要"]`（string 数组，同写入格式）

---

### 日期 (DateTime, type=5)

**创建字段**：

```json
{ "name": "截止日期", "type": 5, "property": { "dateFormat": 0 } }
```

dateFormat 枚举：
- 0 = `YYYY-MM-DD`
- 1 = `YYYY-MM-DD HH:mm`
- 2 = `YYYY-MM-DD HH:mm（GMT+8）`
- 3 = `MM-DD`
- 4 = `YYYY/MM/DD`
- 5 = `YYYY/MM/DD HH:mm`
- 6 = `YYYY/MM/DD HH:mm（GMT+8）`
- 7 = `MM/DD/YY`
- 8 = `DD/MM/YY`

**写入 OpenValue**：`1711353600000`（毫秒级时间戳，推荐）

> 💡 API 也兼容日期字符串（如 `"2024-03-25"`、`"2024-03-25T00:00:00Z"`），但推荐使用毫秒时间戳以避免时区歧义。

**读取 OpenValue**：`1711353600000`

---

### 附件 (Attachment, type=6)

**创建字段**：

```json
{ "name": "附件", "type": 6 }
```

property 通常为 null。

**写入 OpenValue**：

```json
[
  { "fileId": "file_xxx", "name": "报告.pdf", "mimeType": "application/pdf" }
]
```

**读取 OpenValue**：同写入格式

---

### 网址 (URL, type=8)

**创建字段**：

```json
{ "name": "链接", "type": 8 }
```

**写入 OpenValue**：

```json
{ "link": "https://example.com", "title": "示例网站" }
```

**读取 OpenValue**：`{ "link": "https://example.com", "title": "示例网站" }`

---

### 复选框 (Checkbox, type=11)

**创建字段**：

```json
{ "name": "是否完成", "type": 11 }
```

**写入 OpenValue**：`true` 或 `false`

**读取 OpenValue**：`true` 或 `false`

---

### 评分 (Rating, type=12)

**创建字段**：

```json
{ "name": "优先级", "type": 12, "property": { "icon": "star", "max": 5 } }
```

property：
- `icon`：图标名称（如 `"star"`）
- `max`：最大评分值，0~10

**写入 OpenValue**：`3`（number，1~max 之间的整数）

**读取 OpenValue**：`3`

---

### 成员 (Member, type=13)

**创建字段**：

```json
{ "name": "负责人", "type": 13, "property": { "isMulti": false } }
```

property：
- `isMulti`：是否允许多人

**写入 OpenValue**：

```json
[{ "uid": "user_xxx", "name": "张三" }]
```

> 即使 `isMulti=false`，写入格式仍为数组（单元素）

**读取 OpenValue**：`[{ "uid": "user_xxx", "name": "张三", "type": "member", "avatar": "..." }]`

---

## 高级字段（可创建、值只读）

### 公式 (Formula, type=26)

**创建字段**：通过 `doc_field_create` 或 `doc_datasheet_create` 的 template 创建，需配置 `expression` 表达式。

**不可写入** — 值由系统自动计算。

**读取 OpenValue**：取决于表达式，可能是 string、number 或 boolean

---

### 创建人 (CreatedBy, type=23)

**创建字段**：

```json
{ "name": "创建人", "type": 23 }
```

**不可写入** — 值由系统自动填充。

**读取 OpenValue**：`[{ "uid": "user_xxx", "name": "张三" }]`

---

### 创建时间 (CreatedTime, type=21)

**创建字段**：

```json
{ "name": "创建时间", "type": 21, "property": { "dateFormat": 1 } }
```

property 同日期字段的 dateFormat。

**不可写入** — 值由系统自动填充。

**读取 OpenValue**：`1711353600000`（毫秒时间戳）

---

## Recipes

> 以下示例展示如何组装 `doc_datasheet_create` 的 `template.fields`。用户需求不完全匹配时，按「字段零件清单」自由组装即可。

### 项目跟踪表示例

```json
{
  "fields": [
    { "name": "任务名称", "type": 1 },
    { "name": "状态", "type": 3, "property": { "options": [
      { "name": "待处理", "color": "--color-neutral-dark" },
      { "name": "进行中", "color": "--color-warning-base" },
      { "name": "已完成", "color": "--color-success-base" },
      { "name": "已取消", "color": "--color-danger-base" }
    ]}},
    { "name": "优先级", "type": 12, "property": { "icon": "star", "max": 5 } },
    { "name": "负责人", "type": 13, "property": { "isMulti": false } },
    { "name": "截止日期", "type": 5, "property": { "dateFormat": 0 } },
    { "name": "是否完成", "type": 11 }
  ]
}
```

> **color 语义锚点**：成功/通过/正常 → `success-base`；失败/故障/拒绝 → `danger-base`；进行中/警告 → `warning-base`；未开始/草稿/未知 → `neutral-dark`。生成新场景的 options 时，必须对照此锚点选色，不可随机指定。
