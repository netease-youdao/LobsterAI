# doc-li-head（带编号标题的列表项）

标签：`doc-li-head`

## 基本用法

```html
<doc-li-head list-id="l1" list-type="ordered" heading-level="1">第一章 绪论</doc-li-head>
<doc-li-head list-id="l1" list-type="ordered" heading-level="1">第二章 方法</doc-li-head>
```

## 属性

| 属性            | 值                      | 说明                 |
| --------------- | ----------------------- | -------------------- |
| `list-id`       | 字符串                  | 同一列表共享同一 id  |
| `list-type`     | `ordered` / `unordered` | 有序或无序           |
| `list-level`    | 数字，默认 `1`          | 层级缩进             |
| `heading-level` | `1`~`6`                 | 标题字体级别         |
| `style`         | CSS                     | block 级样式（可选） |

## 视觉说明

论文大纲风格：**自动层级编号 + 标题字体**。编号格式为 `1.` `1.1.` `1.1.1.`，随 `list-level` 自动推导。

适合有编号章节结构的文档（如技术规范、报告大纲）。

与其他标签的区别：

- 与 `h1`~`h6` 的区别：带自动层级序号，序号跨 block 连续，不需要手动维护编号
- 与 `doc-li` 的区别：使用标题字体（更大更粗），视觉上是章节标题而非普通列表项

## 多级章节示例

```html
<doc-li-head list-id="l1" list-type="ordered" list-level="1" heading-level="1">绪论</doc-li-head>
<doc-li-head list-id="l1" list-type="ordered" list-level="2" heading-level="2">研究背景</doc-li-head>
<doc-li-head list-id="l1" list-type="ordered" list-level="2" heading-level="2">研究目标</doc-li-head>
<doc-li-head list-id="l1" list-type="ordered" list-level="1" heading-level="1">方法</doc-li-head>
```

渲染效果：`1. 绪论` → `1.1. 研究背景` → `1.2. 研究目标` → `2. 方法`
