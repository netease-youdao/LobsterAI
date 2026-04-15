# doc-li（列表项）

标签：`doc-li`

## 基本用法

```html
<doc-li list-id="l1" list-type="unordered">无序项</doc-li> <doc-li list-id="l2" list-type="ordered">有序项</doc-li>
```

## 属性

| 属性         | 值                      | 说明                                |
| ------------ | ----------------------- | ----------------------------------- |
| `list-id`    | 字符串                  | 同一列表共享同一 id，决定编号连续性 |
| `list-type`  | `ordered` / `unordered` | 有序或无序                          |
| `list-level` | 数字，默认 `1`          | 层级缩进                            |
| `style`      | CSS                     | block 级样式（可选）                |

## 视觉说明

unordered 和 ordered 的布局结构相同，差异只在前缀符号：

- `unordered`：前缀按层级循环为实心圆（●）→ 空心圆（○）→ 实心方块（■）
- `ordered`：前缀按层级循环为数字（1.）→ 小写字母（a.）→ 小写罗马数字（i.）

## list-id 编号连续性

有序列表的序号由 `list-id` 维系，而不是 DOM 相邻关系。**相同 `list-id` 的项目共享计数，中间插入其他 block 不会打断编号**：

```html
<doc-li list-id="l1" list-type="ordered">项目 1</doc-li>
<p>中间插入一个段落，序号不中断。</p>
<doc-li list-id="l1" list-type="ordered">项目 2</doc-li>
```

渲染效果：`1. 项目 1` → `（段落）` → `2. 项目 2`

不同列表使用不同的 `list-id`，序号各自独立计数。

## 多级列表

层级由 `list-level` 控制，`list-id` 保持一致：

```html
<doc-li list-id="l1" list-type="ordered">第一章</doc-li>
<doc-li list-id="l1" list-type="ordered" list-level="2">第一节</doc-li>
<doc-li list-id="l1" list-type="ordered" list-level="2">第二节</doc-li>
<doc-li list-id="l1" list-type="ordered">第二章</doc-li>
```
