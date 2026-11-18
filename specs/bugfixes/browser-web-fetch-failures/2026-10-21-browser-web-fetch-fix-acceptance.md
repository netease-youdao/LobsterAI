# browser / web_fetch 修复与验收摘要

验收日期：2026-10-21。目标分支：`release/2026.10.19`，基线 `0fdd8c0a1efab0d3723d5edac204086826896471`，OpenClaw `v2026.8.1`。

## 修复与实际验证

- Windows 进程枚举暂时超时：保留待核验的 Chrome MCP transport，后续调用重新核验并清理；保留 PID 复用保护。实际注入两次枚举超时后，下一次打开与 snapshot 成功，网关 PID 和启动时间不变。
- 挂起图片阻塞导航：新主文档提交并 `dom-ready` 后允许继续操作，保留主文档失败处理。同一合成页面修复前触发 20 秒导航超时，修复后打开、snapshot、点击及再次 snapshot 成功。
- `web_fetch` 代理偏好：仅在全局代理与工具跟随设置均开启时启用 `useTrustedEnvProxy`。实际界面开关、生成配置和独立 CONNECT 日志确认路由生效；保留本地 DNS、私网、重定向、Host/SNI/TLS 校验。
- 工具错误分类：解析有界错误信封，避免外站正文或恢复建议污染分类。实际测试事件确认 404/403 为 `http_error` 并携带 `httpStatus`，DNS/连接拒绝为 `network`，私网拒绝为 `policy_blocked`；失败后正常页面仍可操作，不上报原始异常或页面正文。

运行时修复保存在 `scripts/patches/v2026.8.1/` 下的 `openclaw-chrome-mcp-process-recovery.patch` 与 `openclaw-web-fetch-proxy.patch`，发行时需重建运行时。

## 验证结果与范围

- 客户端首轮 7 文件 / 264 项通过；最终分类 2 文件 / 40 项、提交前补丁清单与分类 3 文件 / 60 项通过。修改的 TypeScript 文件 ESLint 和 Electron 主进程编译通过。
- OpenClaw 定向回归：浏览器 117 项、web_fetch 63 项、连接释放 10 项、dispatcher 14 项通过；完整 Windows x64 运行时重建及实际启动、配置同步验证完成。
- SSRF 完整分组 108 项通过、3 项失败；无本次补丁的基线同样失败，三项单独运行前后均通过。上游 `ssrf.ts` 仍超既有 max-lines 阈值（712 → 743 行，阈值 700）；附加类型感知 lint 因内存压力未完成。
- 本次为开发态 Electron 加完整运行时验收，未验收安装包。修复前运行时完整补丁集合与 release 不同，但相关源码已核对一致；现场耗时不是严格性能基准。测试事件采集成功不代表生产 Hive 入库或线上失败率下降。
