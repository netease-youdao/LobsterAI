# media（第三方嵌入）

标签：`media`

## 基本用法

```html
<media href="https://example.com/embed" title="Figma" source="figma"></media>
```

## 属性

| 属性     | 值     | 说明                                                                           |
| -------- | ------ | ------------------------------------------------------------------------------ |
| `href`   | URL    | 嵌入地址                                                                       |
| `title`  | 字符串 | 显示标题（通常由 source 推导）                                                 |
| `source` | 字符串 | 来源类型，如 `figma`、`bilibili`、`gaodemap`、`baidumap`                       |
| `mode`   | 字符串 | 显示模式（可选）,枚举`Title` 超链接形式, `Card` 卡片形式, `Embed` iframe 内嵌. |
