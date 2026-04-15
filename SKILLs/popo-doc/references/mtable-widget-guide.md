# 图表配置指南

本文件描述如何为 `doc_widget_add`、`doc_widget_update`、`doc_dashboard_create`（带 template）构造图表配置。

## 调用结构

`doc_widget_add` 需要以下语义参数：

| 参数 | 说明 | 来源 |
|------|------|------|
| documentId | 云空间多维表文档 ID | `doc_create_doc`(docType=9) 或 `doc_search_doc` 返回的 `docId` |
| dashboardId | 仪表盘节点 ID | `doc_dashboard_create` 返回的 `nodeId` |
| name | 图表名称 | 用户指定 |
| relativeMetaId | 数据来源的数据表 nodeId | `doc_datasheet_list` 返回的 `nodeId` |
| snapshot | 图表配置 JSON | 下方模板 |

`doc_widget_update` 可更新 `name`、`relativeMetaId`、`snapshot` 中的任意字段。

> 下方所有模板 JSON 都是 **snapshot** 部分的内容。调用格式见 [mtable-tool-reference.md](./mtable-tool-reference.md)。

---

## 支持的图表类型

| chartType | 中文 | graphType 选项 | 说明 |
|-----------|------|----------------|------|
| `bar` | 柱状图 | `basic` / `stack` / `percentStack` | 竖向柱状 |
| `column` | 条形图 | `basic` / `stack` / `percentStack` | 横向条形 |
| `line` | 折线图 | `basic` / `smooth` | 趋势分析 |
| `pie` | 饼图 | `basic` / `ring` | 占比分析 |
| `nps` | NPS 图 | — | 满意度评分 |

## 核心规则

1. **dstId、viewId、fieldId 必须从实际数据表中获取** — 通过 `doc_field_list` 和 `doc_view_list`（`dstId` 即数据表的 `nodeId`）
2. **yAxisFields 至少 1 个** — 不能为空数组
3. **aggregateMethod 只能是** `sum` / `max` / `min` / `average`
4. **yAxisValueType** 决定 Y 轴含义：`"count"` = 计数模式，`"fieldValue"` = 字段值聚合

## 禁忌

- **不要编造 dstId / viewId / fieldId** — 必须从命令返回中获取
- **不要省略 required 字段** — chartType、dstId、viewId、xAxisFieldId、yAxisValueType、yAxisFields、chartUI、xAxisSortBy、xAxisSortOrder 均为必填
- **bar/column/line 必须指定 graphType** — pie 也必须指定

## 通用动态参数

每个图表都需要填入以下参数（来源见上下文传递表）：

| 参数 | 来源 | 说明 |
|------|------|------|
| `dstId` | `doc_datasheet_list` 的 nodeId | 图表数据来源的数据表（`dstId` 即数据表的 `nodeId`） |
| `viewId` | `doc_view_list` 的 views[].id | 图表数据范围的视图 |
| `xAxisFieldId` | `doc_field_list` 的 fields[].id | X 轴分组维度字段 |
| `yAxisFields[].fieldId` | `doc_field_list` 的 fields[].id | Y 轴统计对象字段 |

## chartUI 选项

```json
["legend", "dataLabel", "axis", "gridLine", "list", "total"]
```

按需选择：
- `legend` — 显示图例
- `dataLabel` — 显示数据标签
- `axis` — 显示坐标轴
- `gridLine` — 显示网格线
- `list` — 显示数据列表
- `total` — 显示合计

---

## 柱状图模板 (bar)

```json
{
  "chartType": "bar",
  "graphType": "basic",
  "dstId": "{{DST_ID}}",
  "viewId": "{{VIEW_ID}}",
  "xAxisFieldId": "{{X_FIELD_ID}}",
  "aggregateSameValue": true,
  "xAxisNumberAsText": false,
  "yAxisValueType": "count",
  "yAxisFields": [
    { "fieldId": "{{Y_FIELD_ID}}", "aggregateMethod": "sum" }
  ],
  "chartUI": ["legend", "dataLabel", "axis", "gridLine"],
  "xAxisSortBy": "xAxisValue",
  "xAxisSortOrder": "asc"
}
```

**graphType 变体**：
- `"basic"` — 基础柱状图
- `"stack"` — 堆叠柱状图（需要 `enableGroupAggregate: true` + `groupAggregateFieldId`）
- `"percentStack"` — 百分比堆叠

**Y 轴模式**：
- `"yAxisValueType": "count"` — 按 X 轴分组计数（yAxisFields 的 fieldId 可以是任意字段）
- `"yAxisValueType": "fieldValue"` — 按字段值聚合（yAxisFields 的 fieldId 必须是数字类型字段）

---

## 条形图模板 (column)

结构与柱状图完全相同，仅 `chartType` 改为 `"column"`：

```json
{
  "chartType": "column",
  "graphType": "basic",
  "dstId": "{{DST_ID}}",
  "viewId": "{{VIEW_ID}}",
  "xAxisFieldId": "{{X_FIELD_ID}}",
  "aggregateSameValue": true,
  "yAxisValueType": "count",
  "yAxisFields": [
    { "fieldId": "{{Y_FIELD_ID}}", "aggregateMethod": "sum" }
  ],
  "chartUI": ["legend", "dataLabel", "axis", "gridLine"],
  "xAxisSortBy": "xAxisValue",
  "xAxisSortOrder": "asc"
}
```

---

## 折线图模板 (line)

```json
{
  "chartType": "line",
  "graphType": "basic",
  "dstId": "{{DST_ID}}",
  "viewId": "{{VIEW_ID}}",
  "xAxisFieldId": "{{X_FIELD_ID}}",
  "aggregateSameValue": true,
  "yAxisValueType": "fieldValue",
  "yAxisFields": [
    { "fieldId": "{{Y_FIELD_ID}}", "aggregateMethod": "sum" }
  ],
  "chartUI": ["legend", "dataLabel", "axis", "gridLine"],
  "xAxisSortBy": "xAxisValue",
  "xAxisSortOrder": "asc"
}
```

**graphType 变体**：
- `"basic"` — 直线折线
- `"smooth"` — 平滑曲线

---

## 饼图模板 (pie)

> ⚠️ **饼图必填字段**：chartType、graphType、dstId、viewId、xAxisFieldId、aggregateSameValue、yAxisValueType、yAxisFields、chartUI、xAxisSortBy、xAxisSortOrder **缺一不可**，否则图表创建会失败。

```json
{
  "chartType": "pie",
  "graphType": "basic",
  "dstId": "{{DST_ID}}",
  "viewId": "{{VIEW_ID}}",
  "xAxisFieldId": "{{X_FIELD_ID}}",
  "aggregateSameValue": true,
  "yAxisValueType": "count",
  "yAxisFields": [
    { "fieldId": "{{Y_FIELD_ID}}", "aggregateMethod": "sum" }
  ],
  "chartUI": ["legend", "dataLabel"],
  "xAxisSortBy": "xAxisValue",
  "xAxisSortOrder": "asc"
}
```

**字段说明**：
- `chartType`：必填，固定值 `"pie"`
- `graphType`：必填，`"basic"`（实心饼）或 `"ring"`（环形图）
- `dstId`：必填，数据来源数据表的 nodeId（通过 `doc_datasheet_list` 获取）
- `viewId`：必填，数据范围视图 ID（通过 `doc_view_list` 获取）
- `xAxisFieldId`：必填，用于分组的字段（推荐单选/多选类型）
- `aggregateSameValue`：必填，固定 `true`（合并相同分组）
- `yAxisValueType`：必填，饼图通常用 `"count"`（计数），也可用 `"fieldValue"`（数值聚合）
- `yAxisFields`：必填，至少一个元素，fieldId 用于聚合的字段
- `chartUI`：必填，饼图推荐 `["legend", "dataLabel"]`
- `xAxisSortBy`：必填，`"xAxisValue"`（按分组名排序）或 `"yAxisValue"`（按值排序）
- `xAxisSortOrder`：必填，`"asc"` 或 `"desc"`

**graphType 变体**：
- `"basic"` — 实心饼图
- `"ring"` — 环形图

---

## NPS 图模板 (nps)

NPS 图用于满意度评分分析，需要 `npsRange` 参数来划分三类人群：

```json
{
  "chartType": "nps",
  "dstId": "{{DST_ID}}",
  "viewId": "{{VIEW_ID}}",
  "xAxisFieldId": "{{RATING_FIELD_ID}}",
  "npsRange": [2, 4],
  "chartUI": ["legend", "dataLabel"]
}
```

> `xAxisFieldId` 应指向评分(Rating, type=12)或数字(Number, type=2)类型字段。

### npsRange 语义

`npsRange` 是 **`[detractorMax, passiveMax]`** 二元组，表示贬损者和被动者的**上界分界线**，而非数据取值范围。

以评分字段 1~5 分、`npsRange: [2, 4]` 为例：

| 评分区间 | 人群分类 | 说明 |
|---------|---------|------|
| ≤ 2 | 贬损者 (Detractors) | 不满意 |
| 3 ~ 4 | 被动者 (Passives) | 中立 |
| ≥ 5 | 推荐者 (Promoters) | 满意 |

**NPS = 推荐者占比 − 贬损者占比**（取值 -100 ~ 100）

⚠️ **常见错误**：将 `npsRange` 设为字段的取值范围（如 `[0, 5]` 或 `[1, 5]`），会导致所有数据落入被动者区间，NPS 恒为 0.0。

---

## 分组聚合（堆叠图）

当需要在柱状/条形/折线图中按第二维度分组时：

```json
{
  "chartType": "bar",
  "graphType": "stack",
  "dstId": "{{DST_ID}}",
  "viewId": "{{VIEW_ID}}",
  "xAxisFieldId": "{{X_FIELD_ID}}",
  "enableGroupAggregate": true,
  "groupAggregateFieldId": "{{GROUP_FIELD_ID}}",
  "groupFieldSortOrder": "asc",
  "yAxisValueType": "count",
  "yAxisFields": [
    { "fieldId": "{{Y_FIELD_ID}}", "aggregateMethod": "sum" }
  ],
  "chartUI": ["legend", "dataLabel", "axis", "gridLine"],
  "xAxisSortBy": "xAxisValue",
  "xAxisSortOrder": "asc"
}
```

- `enableGroupAggregate`：启用分组
- `groupAggregateFieldId`：分组字段（通常是单选/多选字段）
- `groupFieldSortOrder`：`"asc"` 或 `"desc"`

---

## Recipes

### 按状态统计任务数（柱状图）

X 轴=状态字段（单选），Y 轴=计数

```json
{
  "chartType": "bar",
  "graphType": "basic",
  "dstId": "dst001",
  "viewId": "viw001",
  "xAxisFieldId": "fld_status",
  "aggregateSameValue": true,
  "yAxisValueType": "count",
  "yAxisFields": [{ "fieldId": "fld_status", "aggregateMethod": "sum" }],
  "chartUI": ["legend", "dataLabel", "axis", "gridLine"],
  "xAxisSortBy": "yAxisValue",
  "xAxisSortOrder": "desc"
}
```

### 按月份看销售额趋势（折线图）

X 轴=日期字段，Y 轴=金额字段求和

```json
{
  "chartType": "line",
  "graphType": "smooth",
  "dstId": "dst001",
  "viewId": "viw001",
  "xAxisFieldId": "fld_date",
  "aggregateSameValue": true,
  "yAxisValueType": "fieldValue",
  "yAxisFields": [{ "fieldId": "fld_amount", "aggregateMethod": "sum" }],
  "chartUI": ["legend", "dataLabel", "axis", "gridLine"],
  "xAxisSortBy": "xAxisValue",
  "xAxisSortOrder": "asc"
}
```

### 各部门占比（饼图）

```json
{
  "chartType": "pie",
  "graphType": "ring",
  "dstId": "dst001",
  "viewId": "viw001",
  "xAxisFieldId": "fld_department",
  "aggregateSameValue": true,
  "yAxisValueType": "count",
  "yAxisFields": [{ "fieldId": "fld_department", "aggregateMethod": "sum" }],
  "chartUI": ["legend", "dataLabel"],
  "xAxisSortBy": "yAxisValue",
  "xAxisSortOrder": "desc"
}
```
