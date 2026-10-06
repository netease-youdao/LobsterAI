# 模型生成视频分享页 Web Demo

这是视频分享方案的本地交互原型，不连接 LobsterAI 服务端，也不修改生产页面。

本版方案将视频下载入口移动到 Header，并沿用其他可下载文件分享页的操作结构：

- Header 左侧显示 LobsterAI 品牌，中间显示文件名和大小；
- Header 右侧依次放置图标式“下载当前视频”、分隔线和“下载 LobsterAI”；
- 播放器下方不再重复展示下载按钮，避免同一主操作出现两次；
- 主区域使用原生 `<video controls playsinline preload="metadata">`；
- 视频不自动播放；
- 移动端隐藏中间文件信息，但始终保留视频下载图标；超窄屏隐藏“下载 LobsterAI”次级按钮；
- 分享码验证前不展示播放器和文件信息；
- 分享关闭或过期时展示统一不可访问状态；
- 右下角 `DEMO` 控制器仅用于切换原型状态，正式页面不展示。

本地预览：

```bash
python3 -m http.server 4178 --bind 127.0.0.1 --directory specs/features/artifacts/generated-video-share-web-demo
```

然后访问 `http://127.0.0.1:4178/`。分享码状态的演示码为 `LOBSTER`。
