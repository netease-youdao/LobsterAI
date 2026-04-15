# 在线表格工具参考

所有表格操作统一使用 `doc_execute_table` 工具，通过 `fabric_call` 调用：

```
fabric_call({"tool": "doc_execute_table", "params": {
  "docId": "<DOC_ID>",
  "command": {
    "type": "<commandType>",
    "payload": { ... }
  },
  "teamSpaceId": "<可选>"
}})
```

## 通用说明

| 术语 | 含义 |
|------|------|
| **可见索引** | 跳过隐藏行/列后的序号（0-based） |
| **物理索引** | 包含所有行/列（含隐藏）的原始序号（0-based） |
| `version` | 操作后的版本号；幂等操作无变化时可能为 `undefined` |
| `sheetId` | 全局唯一 Sheet 标识，UUID 格式 |
| 公式格式 | 入参以 `=` 开头（如 `=SUM(A1:B2)`） |

**索引规则**：
- 插入 / 删除 / 调整大小 / 隐藏 操作使用**可见索引**
- 显示隐藏行列（sheet.showRows / sheet.showCols）使用**物理索引**

---

## workbook.getFullData — 获取表格完整数据

获取整个 Workbook 或指定 Sheet 的完整数据，包括单元格值、合并区域、Sheet 元信息等。只读操作。

### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 否 | 指定 Sheet ID；不填则返回所有 Sheet 的数据 |

### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.getFullData", "payload": {}}}})

fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.getFullData", "payload": {"sheetId": "<SHEET_ID>"}}}})
```

### 返回值

```json
{
  "tabs": ["sheet-id-1", "sheet-id-2"],
  "sheets": [
    {
      "sheetId": "sheet-id-1",
      "title": "Sheet1",
      "rowCount": 200,
      "colCount": 20,
      "cells": { "0,0": "Hello", "0,1": "=SUM(A1:A5)", "1,0": 42 },
      "spans": { "0,0": [2, 3] },
      "rowHeights": { "0": 25, "5": 50 },
      "colWidths": { "0": 80, "3": 200 },
      "hiddenRows": [3, 7],
      "hiddenCols": [2],
      "charts": [
        {
          "chartId": "123456789",
          "title": "销售趋势",
          "domain": "A1:C5",
          "type": "line",
          "location": [300, 500, 400, 500],
          "colorScheme": "s0"
        }
      ],
      "hidden": false
    }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `tabs` | string[] | Sheet 顺序数组（sheetId 列表） |
| `sheets[].sheetId` | string | Sheet ID |
| `sheets[].title` | string | Sheet 名称 |
| `sheets[].rowCount` | number | 行总数（含隐藏行） |
| `sheets[].colCount` | number | 列总数（含隐藏列） |
| `sheets[].cells` | Record\<"row,col", value\> | 单元格值映射；公式以 `=` 前缀返回；空单元格不出现 |
| `sheets[].spans` | Record\<"row,col", [rowCount, colCount]\> | 合并单元格区域 |
| `sheets[].rowHeights` | Record\<string, number\> | 自定义行高(px)；未设置的行使用默认值 |
| `sheets[].colWidths` | Record\<string, number\> | 自定义列宽(px)；未设置的列使用默认值 |
| `sheets[].hiddenRows` | number[] | 被隐藏的行的物理索引(0-based) |
| `sheets[].hiddenCols` | number[] | 被隐藏的列的物理索引(0-based) |
| `sheets[].charts` | ChartInfo[] | 图表列表 |
| `sheets[].hidden` | boolean | 该 Sheet 是否隐藏 |

> 指定不存在的 `sheetId` 不会报错，返回空结构。

---

## sheet.setCell — 设置单元格

设置指定单元格的值或公式。

### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `row` | Integer | 是 | 行索引（可见行，0-based） |
| `col` | Integer | 是 | 列索引（可见列，0-based） |
| `value` | any | 与 formula 二选一 | 单元格值（数字/字符串） |
| `formula` | String | 与 value 二选一 | 公式，以 `=` 开头，如 `=SUM(A1:A3)` |

### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.setCell", "payload": {"sheetId": "<SHEET_ID>", "row": 0, "col": 0, "value": 100}}}})

fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.setCell", "payload": {"sheetId": "<SHEET_ID>", "row": 0, "col": 0, "formula": "=SUM(A1:A3)"}}}})
```

### 返回值

```json
{ "sheetId": "string", "row": 0, "col": 0, "version": 1 }
```

---

## sheet.clearCell — 清空单元格

清除指定单元格的内容，幂等操作。

### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `row` | Integer | 是 | 行索引（0-based） |
| `col` | Integer | 是 | 列索引（0-based） |

### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.clearCell", "payload": {"sheetId": "<SHEET_ID>", "row": 0, "col": 0}}}})
```

### 返回值

```json
{ "sheetId": "string", "row": 0, "col": 0, "version": 1 }
```

---

## sheet.batchSetCells — 批量设置单元格（最多一次新set50个单元格）

一次性设置多个单元格的值或公式。

### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `cells` | Array | 是 | 单元格数组，每项含 `row`、`col` 和 `value` 或 `formula` |

`cells` 每项结构:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `row` | number >= 0 | 是 | 行索引 |
| `col` | number >= 0 | 是 | 列索引 |
| `value` | any | 与 formula 二选一 | 单元格值 |
| `formula` | string | 与 value 二选一 | 公式（以 `=` 开头） |

### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.batchSetCells", "payload": {"sheetId": "<SHEET_ID>", "cells": [{"row": 0, "col": 0, "value": "Name"}, {"row": 0, "col": 1, "formula": "=SUM(B2:B10)"}]}}}})
```

### 返回值

```json
{ "sheetId": "string", "updatedCount": 3, "version": 1 }
```

---

## sheet.batchGetCells — 批量读取单元格

获取矩形区域内所有单元格的值。只读操作。

### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `row` | Integer | 是 | 起始行（0-based） |
| `col` | Integer | 是 | 起始列（0-based） |
| `rowCount` | Integer | 是 | 行数（>= 1） |
| `colCount` | Integer | 是 | 列数（>= 1） |

### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.batchGetCells", "payload": {"sheetId": "<SHEET_ID>", "row": 0, "col": 0, "rowCount": 5, "colCount": 3}}}})
```

### 返回值

```json
{
  "sheetId": "string",
  "row": 0, "col": 0,
  "rowCount": 2, "colCount": 3,
  "values": [
    ["A1", "=SUM(B1:B2)", null],
    [1, 2, 3]
  ]
}
```

> 公式以 `=` 前缀返回；无值的单元格返回 `null`。

---

## sheet.mergeCells / sheet.unmergeCells — 合并/取消合并单元格

合并或取消合并矩形区域内的单元格。

### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `row` | Integer | 是 | 左上角行（0-based） |
| `col` | Integer | 是 | 左上角列（0-based） |
| `rowCount` | Integer | 是 | 行数（>= 1） |
| `colCount` | Integer | 是 | 列数（>= 1） |

### 示例

```
# 合并
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.mergeCells", "payload": {"sheetId": "<SHEET_ID>", "row": 0, "col": 0, "rowCount": 2, "colCount": 2}}}})

# 取消合并
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.unmergeCells", "payload": {"sheetId": "<SHEET_ID>", "row": 0, "col": 0, "rowCount": 2, "colCount": 2}}}})
```

### 返回值（mergeCells）

```json
{ "sheetId": "string", "row": 0, "col": 0, "rowCount": 2, "colCount": 2, "version": 1 }
```

### 返回值（unmergeCells）

```json
{ "sheetId": "string", "row": 0, "col": 0, "rowCount": 2, "colCount": 2, "unmergedCount": 1, "version": 1 }
```

> - 1x1 区域为 no-op
> - merge 时区域内第一个非空值移到左上角，其余清空
> - 与已有合并区域部分相交时报错

---

## 工作表管理

### workbook.createSheet — 新建 Sheet

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetName` | String | 是 | Sheet 名称 |
| `index` | Integer | 否 | 插入位置，默认追加到末尾 |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.createSheet", "payload": {"sheetName": "Sheet2"}}}})

fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.createSheet", "payload": {"sheetName": "Sheet3", "index": 0}}}})
```

#### 返回值

```json
{ "sheetId": "uuid", "sheetName": "Sheet2", "index": 1, "version": 1 }
```

### workbook.deleteSheet — 删除 Sheet

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | 要删除的 Sheet ID |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.deleteSheet", "payload": {"sheetId": "<SHEET_ID>"}}}})
```

#### 返回值

```json
{ "sheetId": "string", "version": 1 }
```

> 最后一张 Sheet 不可删除。

### workbook.renameSheet — 重命名 Sheet

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `newName` | String | 是 | 新名称 |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.renameSheet", "payload": {"sheetId": "<SHEET_ID>", "newName": "NewName"}}}})
```

#### 返回值

```json
{ "sheetId": "string", "newName": "NewName", "version": 1 }
```

### workbook.copySheet — 复制 Sheet

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | 源 Sheet ID |
| `newTitle` | String | 否 | 新 Sheet 名称，默认沿用原名 |
| `insertIndex` | Integer | 否 | 插入位置，默认紧跟源 Sheet 之后 |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.copySheet", "payload": {"sheetId": "<SHEET_ID>"}}}})

fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.copySheet", "payload": {"sheetId": "<SHEET_ID>", "newTitle": "Copy", "insertIndex": 2}}}})
```

#### 返回值

```json
{ "sheetId": "new-uuid", "sourceSheetId": "string", "insertIndex": 2, "version": 1 }
```

### workbook.hideSheet — 隐藏 Sheet

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.hideSheet", "payload": {"sheetId": "<SHEET_ID>"}}}})
```

#### 返回值

```json
{ "sheetId": "string", "version": 1 }
```

> 幂等，已隐藏时 `version` 为 `undefined`。

### workbook.showSheet — 显示 Sheet

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "workbook.showSheet", "payload": {"sheetId": "<SHEET_ID>"}}}})
```

#### 返回值

```json
{ "sheetId": "string", "version": 1 }
```

> 幂等，已显示时 `version` 为 `undefined`。

---

## 行列操作

### sheet.insertRows — 插入行

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `startRowIndex` | Integer | 是 | 插入位置（可见行索引）；等于可见行总数时追加到末尾 |
| `count` | Integer | 是 | 插入行数（1-1000） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.insertRows", "payload": {"sheetId": "<SHEET_ID>", "startRowIndex": 2, "count": 3}}}})
```

#### 返回值

```json
{ "sheetId": "string", "startRowIndex": 2, "count": 3, "version": 1 }
```

> 自动更新公式中的行引用，并调整合并区域。

### sheet.deleteRows — 删除行

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `startRowIndex` | Integer | 是 | 起始可见行索引 |
| `count` | Integer | 是 | 删除行数（1-1000） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.deleteRows", "payload": {"sheetId": "<SHEET_ID>", "startRowIndex": 2, "count": 1}}}})
```

#### 返回值

```json
{ "sheetId": "string", "startRowIndex": 2, "count": 1, "version": 1 }
```

> 被删行的公式引用替换为 `#REF!`。

### sheet.insertCols — 插入列

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `startColIndex` | Integer | 是 | 插入位置（可见列索引） |
| `count` | Integer | 是 | 插入列数（1-1000） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.insertCols", "payload": {"sheetId": "<SHEET_ID>", "startColIndex": 1, "count": 2}}}})
```

#### 返回值

```json
{ "sheetId": "string", "startColIndex": 1, "count": 2, "version": 1 }
```

### sheet.deleteCols — 删除列

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `startColIndex` | Integer | 是 | 起始可见列索引 |
| `count` | Integer | 是 | 删除列数（1-1000） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.deleteCols", "payload": {"sheetId": "<SHEET_ID>", "startColIndex": 1, "count": 2}}}})
```

#### 返回值

```json
{ "sheetId": "string", "startColIndex": 1, "count": 2, "version": 1 }
```

### sheet.resizeRows — 调整行高

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `row` | Integer | 是 | 可见行索引 |
| `height` | Integer | 是 | 行高（像素） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.resizeRows", "payload": {"sheetId": "<SHEET_ID>", "row": 0, "height": 40}}}})
```

#### 返回值

```json
{ "sheetId": "string", "row": 0, "height": 40, "version": 1 }
```

### sheet.resizeCols — 调整列宽

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `col` | Integer | 是 | 可见列索引 |
| `width` | Integer | 是 | 列宽（像素） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.resizeCols", "payload": {"sheetId": "<SHEET_ID>", "col": 1, "width": 120}}}})
```

#### 返回值

```json
{ "sheetId": "string", "col": 1, "width": 120, "version": 1 }
```

### sheet.hideRows — 隐藏行

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `row` | Integer | 是 | 起始**可见**行索引 |
| `count` | Integer | 是 | 隐藏行数（1-1000） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.hideRows", "payload": {"sheetId": "<SHEET_ID>", "row": 3, "count": 2}}}})
```

#### 返回值

```json
{ "sheetId": "string", "version": 1 }
```

### sheet.showRows — 显示隐藏行

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `row` | Integer | 是 | 起始**物理**行索引（含隐藏行） |
| `count` | Integer | 是 | 显示行数（1-1000） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.showRows", "payload": {"sheetId": "<SHEET_ID>", "row": 3, "count": 2}}}})
```

#### 返回值

```json
{ "sheetId": "string", "version": 1 }
```

### sheet.hideCols — 隐藏列

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `col` | Integer | 是 | 起始**可见**列索引 |
| `count` | Integer | 是 | 隐藏列数（1-1000） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.hideCols", "payload": {"sheetId": "<SHEET_ID>", "col": 2, "count": 1}}}})
```

#### 返回值

```json
{ "sheetId": "string", "version": 1 }
```

### sheet.showCols — 显示隐藏列

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `col` | Integer | 是 | 起始**物理**列索引（含隐藏列） |
| `count` | Integer | 是 | 显示列数（1-1000） |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.showCols", "payload": {"sheetId": "<SHEET_ID>", "col": 2, "count": 1}}}})
```

#### 返回值

```json
{ "sheetId": "string", "version": 1 }
```

---

## 图表操作

### sheet.addChart — 添加图表

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `title` | String | 是 | 图表标题 |
| `domain` | String | 是 | 数据范围，如 `"A1:C5"` |
| `type` | String | 是 | `line` / `pie` / `verticalBar` / `horizontalBar` |
| `location` | Array | 是 | `[x, y, width, height]`（单位是pt，300 pt ≈ 10.58 厘米，一般图表大小设置为400*300，根据数据来调整） |
| `colorScheme` | String | 否 | `s0` ~ `s5`，默认 `s0` |
| `stack` | Boolean | 否 | 默认 `false` |
| `showLabel` | Boolean | 否 | 默认 `false` |
| `transpose` | Boolean | 否 | 默认 `false` |
| `useLegend` | Boolean | 否 | 默认 `true` |
| `useAxis` | Boolean | 否 | 默认 `false` |
| `useCountMode` | Boolean | 否 | 默认 `false` |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.addChart", "payload": {"sheetId": "<SHEET_ID>", "title": "Sales", "domain": "A1:C5", "type": "line", "location": [300, 400, 400, 500]}}}})
```

#### 返回值

```json
{ "sheetId": "string", "chartId": "uuid", "version": 1 }
```

### sheet.updateChart — 更新图表

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `chartId` | String | 是 | 图表 ID |
| 其余参数 | -- | 否 | 同 addChart，至少提供一个修改项 |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.updateChart", "payload": {"sheetId": "<SHEET_ID>", "chartId": "<CHART_ID>", "title": "New Title"}}}})
```

#### 返回值

```json
{ "sheetId": "string", "chartId": "string", "version": 1 }
```

### sheet.removeChart — 删除图表

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 是 | Sheet ID |
| `chartId` | String | 是 | 图表 ID |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.removeChart", "payload": {"sheetId": "<SHEET_ID>", "chartId": "<CHART_ID>"}}}})
```

#### 返回值

```json
{ "sheetId": "string", "chartId": "string", "version": 1 }
```

### sheet.chartList — 列出图表

#### payload 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheetId` | String | 否 | 过滤指定 Sheet；不填返回所有图表 |

#### 示例

```
fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.chartList", "payload": {}}}})

fabric_call({"tool": "doc_execute_table", "params": {"docId": "<DOC_ID>", "command": {"type": "sheet.chartList", "payload": {"sheetId": "<SHEET_ID>"}}}})
```

#### 返回值

```json
{
  "charts": [
    {
      "sheetId": "string",
      "chartId": "string",
      "title": "销售趋势",
      "domain": "A1:C5",
      "type": "line",
      "location": [0, 0, 6, 4],
      "colorScheme": "s0",
      "stack": false,
      "showLabel": false,
      "transpose": false,
      "useLegend": true,
      "useAxis": false,
      "useCountMode": false
    }
  ]
}
```
