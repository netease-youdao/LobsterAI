# code-block（代码块）

标签：`code-block`

## 基本用法

```html
<code-block language="javascript">const a = 1; console.log(a);</code-block>
```

## 属性

| 属性       | 值       | 说明                                    |
| ---------- | -------- | --------------------------------------- |
| `language` | 语言名称 | 如 `javascript`、`python`、`typescript` |
| `wrap`     | `"true"` | 溢出自动换行（可选）                    |
| `folded`   | `"true"` | 折叠状态（可选）                        |

## 关键规则

- 内容是**纯文本**，行与行之间用换行符 `\n`
- **不要**为每一行包 `<code>` 标签
- **不要**使用 `<pre><code>` 结构
- 开始标签与代码内容之间不要有多余空白

## 带属性示例

```html
<code-block language="python" wrap="true">def hello(): print("Hello!") hello()</code-block>
```
