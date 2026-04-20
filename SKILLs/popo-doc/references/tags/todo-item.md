# todo-item（待办项）

标签：`todo-item`

## 基本用法

```html
<todo-item checked="">未完成事项</todo-item> <todo-item checked="checked">已完成事项</todo-item>
```

## 属性

| 属性      | 值                  | 说明                                |
| --------- | ------------------- | ----------------------------------- |
| `checked` | `""` 或 `"checked"` | 空字符串=未完成，`"checked"`=已完成 |

## 说明

- `checked=""` 表示未完成
- `checked="checked"` 表示已完成
- 内容是行内文本，支持 `<b>`、`<a>` 等行内元素
