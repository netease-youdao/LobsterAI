# nsp-clawguard 启动兼容补丁

## 原因与修复范围

本地 `nsp-clawguard 2.5.0` 可以复现 QA 日志中的网关启动异常。插件单文件
ESM 产物内的 esbuild `__require` 没有绑定原生 `require`：

- 经旧的 OpenClaw 加载路径转换后，内嵌 `graceful-fs` 取得的 `fs` 代理不能正常
  访问 symbol 队列。插件修改共享的 `fs.close/closeSync` 后，网关在关闭文件时
  抛出 `Cannot read properties of undefined (reading 'length')`，连诊断日志写入也失败。
- 修正 Windows file URL 的原生加载路径后，原插件改为在加载时抛出
  `Dynamic require of "util" is not supported`，插件无法注册。

LobsterAI 在配置同步开始时、调用 OpenClaw 迁移 CLI 之前，检查已启用的用户插件，
将该插件已知的 `__require` helper 替换为
`createRequire(import.meta.url)`。其他依赖代码、插件配置和权限保持原样。
文件改变需要新网关进程，沿用现有的重启、活跃任务延期和自重启等待机制。

补丁只识别包名及 manifest ID 为 `nsp-clawguard`、版本均为 `2.5.0`、入口为
`./dist/index.mjs` 且具有已知 helper 的包。其他版本或结构记录诊断后跳过。
QA 归档没有插件包体及可核对的版本，仍需原机确认版本并回测。

## 用户状态与文件处理

| 状态 | 行为 |
| --- | --- |
| 未安装，或只有其他用户插件 | 直接返回，不访问、创建或下载插件文件，不改变网关重启需求 |
| 已安装但未启用 | 不读取或修改插件文件；不会自动启用 |
| 已安装且启用，版本和结构匹配 | 备份原入口后替换 helper；在网关加载前完成 |
| 已打补丁，再次启动或同步 | 不重复写入或新增备份，不因补丁再次触发重启 |
| 重新安装或更新覆盖入口 | 下次配置同步重新检查；禁用状态下等到再次启用才处理 |
| 安装记录残留、目录已不存在 | 不重建目录或安装插件 |
| 版本或入口结构不匹配 | 不修改文件；由日志说明跳过原因 |

检查范围仅为本地插件管理记录和两个安装位置：

- `userData/third-party-extensions/nsp-clawguard`
- `stateDir/extensions/nsp-clawguard`

不扫描其他目录，不修改随包 OpenClaw 文件，不跟随插件目录、入口目录或入口文件的
符号链接。仅由外部配置引用、尚未同步到 LobsterAI 插件管理记录的安装不在本次范围内。

原文件备份位于入口旁，格式为
`index.mjs.lobsterai-native-require-v1.<原文件 SHA-256>.bak`。
重复遇到同一原文件时验证并复用备份，不覆盖已有备份。写入复用项目的安全文件替换
逻辑，支持 Windows 的 rename 限制和失败恢复。备份或替换失败会记录错误，不继续
强制改写，不修改其他插件。此时本插件的启动问题可能仍然存在。

如需回滚，先在插件管理中禁用插件并退出应用，再用匹配的备份恢复入口；保持禁用，
避免下次启用时再次应用补丁。

## 验证及限制

自动测试覆盖未安装、禁用、启用、两个安装目录、重复执行、重新安装、未知结构、
CRLF、符号链接、备份冲突、写入失败，以及原生 ESM 和模拟 interop 代理下的
插件注册与宿主文件关闭。

Windows 隔离网关使用真实 `2.5.0` 插件副本、临时状态和独立端口，结果如下。
旧加载路径对照通过临时 runtime 副本恢复 file URL 转换修复前的行为实现，
没有修改开发目录的 runtime。

| 场景 | 插件注册 | 网关启动 |
| --- | --- | --- |
| 未安装 | 不加载 | ready |
| 已安装但禁用 | 不加载 | ready |
| 原插件，旧加载路径 | 注册后污染宿主 fs | `.length` 异常，退出 1 |
| 打补丁，旧加载路径 | 成功 | ready |
| 原插件，当前原生加载路径 | `Dynamic require` 失败 | ready，但插件未加载 |
| 打补丁，当前原生加载路径 | 成功 | ready |

这些实验屏蔽了插件的 `gateway_start` 回调，避免启动真实扫描、后台服务和远程
上报。验证结论限于插件注册和网关启动，未覆盖插件全部业务功能。
`agent_end` / `llm_output` 的会话访问权限仍由 OpenClaw 检查，补丁没有自动授权。
macOS、Linux 及 QA 原机上的完整插件功能仍需回测。
