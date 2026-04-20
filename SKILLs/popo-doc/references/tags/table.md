# table（表格）

标签：`table`

## 基本用法

```html
<table>
  <colgroup>
    <col style="width: 200px;" />
    <col style="width: 200px;" />
  </colgroup>
  <tbody>
    <tr>
      <td>A1</td>
      <td>B1</td>
    </tr>
    <tr>
      <td>A2</td>
      <td>B2</td>
    </tr>
  </tbody>
</table>
```

## 属性

| 属性              | 值      | 说明                   |
| ----------------- | ------- | ---------------------- |
| `title-bar-open`  | boolean | 第一列为标题列（可选） |
| `title-line-open` | boolean | 第一行为标题行（可选） |
| `style`           | CSS     | block 级样式（可选）   |

## 结构规则

- 必须包含 `<colgroup>` 定义列宽
- 必须用 `<tbody>` 包裹行
- 行 `<tr>` 可选 `style="height: 40px;"` 设定行高（默认 40px）
- 单元格使用 `<td>` 或 `<th>`

## 合并单元格

使用 `colspan` 和 `rowspan`：

```html
<table>
  <colgroup>
    <col style="width: 150px;" />
    <col style="width: 150px;" />
    <col style="width: 150px;" />
  </colgroup>
  <tbody>
    <tr>
      <td colspan="2">跨两列</td>
      <td>C1</td>
    </tr>
    <tr>
      <td rowspan="2">跨两行</td>
      <td>B2</td>
      <td>C2</td>
    </tr>
    <tr>
      <td>B3</td>
      <td>C3</td>
    </tr>
  </tbody>
</table>
```

## 单元格嵌套 block

单元格内可以放 paragraph、heading、list、code-block 等 block 标签：

```html
<td>
  <p><b>标题</b></p>
  <doc-li list-id="l1" list-type="unordered">项目 1</doc-li>
  <doc-li list-id="l1" list-type="unordered">项目 2</doc-li>
</td>
```

如果单元格只有纯文本，会自动包成 paragraph。
