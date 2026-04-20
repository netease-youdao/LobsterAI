# callout（高亮提示块）

标签：`callout`

## 基本用法

```html
<callout emoji="💡" bg-color="rgb(255, 251, 235)">
  <p>提示内容</p>
</callout>
```

## 属性

| 属性       | 值               | 说明                            |
| ---------- | ---------------- | ------------------------------- |
| `emoji`    | 任意 emoji 字符  | 左侧图标                        |
| `bg-color` | 任意颜色值或渐变 | 整块背景色，不要写在 `style` 里 |

## 视觉说明

彩色背景圆角块，左侧固定展示 emoji 图标，内容区在 emoji 右侧。`bg-color` 填充整个容器（含内边距区域）。

与 `blockquote` 的区别：callout 有背景色和 emoji，视觉强调度高；blockquote 只有左侧竖线，适合低调引用。

## bg-color 取值

支持任意 CSS 颜色值，包括渐变：

```html
<!-- 纯色 -->
<callout emoji="💡" bg-color="rgb(255, 251, 235)">...</callout>
<callout emoji="⚠️" bg-color="rgb(255, 243, 240)">...</callout>
<callout emoji="ℹ️" bg-color="rgb(235, 245, 255)">...</callout>
<callout emoji="✅" bg-color="rgb(240, 255, 240)">...</callout>

<!-- 渐变 -->
<callout emoji="🎨" bg-color="linear-gradient(135deg, rgb(255, 251, 235), rgb(235, 245, 255))">...</callout>
```

## 嵌套 block

内部可以放任意 block 标签：

```html
<callout emoji="⚠️" bg-color="rgb(255, 243, 240)">
  <p><b>风险提示</b></p>
  <p>此操作不可撤销。</p>
  <doc-li list-id="l1" list-type="ordered">确认权限</doc-li>
  <doc-li list-id="l1" list-type="ordered">备份数据</doc-li>
</callout>
```
