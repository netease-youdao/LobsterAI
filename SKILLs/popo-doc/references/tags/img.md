# img（图片）

标签：`img`

## 基本用法

```html
<img src="https://example.com/image.png" />
```

## 属性

| 属性    | 值  | 说明                                                                     |
| ------- | --- | ------------------------------------------------------------------------ |
| `src`   | URL | 图片地址                                                                 |
| `style` | CSS | block 级样式（可选），如 `margin-left`、`text-align`、`background-color` |

## 带样式

```html
<img src="https://example.com/image.png" style="margin-left: 24px; text-align: center;" />
```

## 图片容器

多张图片并排放在 `<p>` 中：

```html
<p>
  <img src="https://example.com/a.png" />
  <img src="https://example.com/b.png" />
</p>
```

## 说明

- 图片节点不需要额外容器
- 不要使用 `float` 样式
- 段落内图片容器中的 `<img>` 不需要写 `style`
