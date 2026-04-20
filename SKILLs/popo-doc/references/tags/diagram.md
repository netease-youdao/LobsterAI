# diagram（图表）

标签：`diagram`

## 基本用法

```html
<diagram language="PlantUML">@startuml Alice -> Bob: Hi Bob -> Alice: Hello @enduml</diagram>
```

## 属性

| 属性        | 值       | 说明                              |
| ----------- | -------- | --------------------------------- |
| `language`  | 语言名称 | 枚举：`PlantUML`, `Mermaid`. 必填 |
| `view-type` | 字符串   | 视图类型（可选）                  |

## 说明

- 内容是纯文本，行间用换行符
- 不要使用 `<pre>` 标签
