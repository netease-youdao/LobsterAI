# nsp-clawguard 启动兼容补丁

## 原因与修复范围

本地 `nsp-clawguard 2.5.0` 可以复现 QA 日志中的网关启动异常。插件单文件
ESM 产物内的 esbuild `__require` 没有绑定原生 `require`：

- 经旧的 OpenClaw 加载路径转换后，内嵌 `graceful-fs` 取得的 `fs` 代理不能正常
  访问 symbol 队列。插件修改共享的 `fs.close/closeSync` 后，网关在关闭文件时
  抛出 `Cannot read properties of undefined (reading 'length')`，连诊断日志写入也失败。
- 修正 Windows file URL 的原生加载路径后，原插件改为在加载时抛出
  `Dynamic require of "util" is not supported`，插件无法注册。
- 只补齐 `require` 后，插件能够注册，但 `gateway_start` 的异步数据库初始化仍会
  在内嵌 SQL.js 中访问缺失的 `__dirname` / `__filename`。未处理的 rejection
  会使刚进入 ready 的网关退出；不能以插件注册成功或首次 ready 作为验收结果。

LobsterAI 在配置同步开始时、调用 OpenClaw 迁移 CLI 之前，检查已启用的用户插件，
将该插件已知的 `__require` helper 替换为 `createRequire(import.meta.url)`，
并由 `fileURLToPath(import.meta.url)` 和 `dirname()` 补齐模块内的 CommonJS 路径。
路径按文件 URL 解码，支持 Windows 盘符、空格和中文。兼容原始包及上一版只补齐
`require` 的 v1 入口；不会跳过插件的 `gateway_start` 回调。
其他依赖代码、插件配置和权限保持原样。
文件改变需要新网关进程，沿用现有的重启、活跃任务延期和自重启等待机制。

`2.4.13` 还存在一个真实包验证中发现的差异：它将 `register(api)` 声明为 `async`，
当前 OpenClaw 会以 `plugin register must be synchronous` 拒绝注册，丢弃插件钩子。
核对发布包后，完整函数体与 `2.5.0` 去掉 `async` 的版本完全相同，且没有顶层
`await`。兼容处理只在完整注册函数的 SHA-256 为
`2eff634d2ade5e952927b6c4647ade0003db515165e2344437adf9099ea6ce60` 时移除该声明，
保留内部所有异步回调；未知函数体直接跳过。已经补齐模块上下文但尚未修正注册函数
的安装也可以继续修复，并另存当时的原入口备份。

该版本的 manifest 也缺少 `activation.onStartup`，新版网关因此不会在启动阶段
加载其安全监控钩子。仅当原 manifest（统一为 LF、去除末尾空白后）的 SHA-256 为
`1cc6ff67c8ceaa9c502db5d70d6550cf8f9da4b70a9dc043e55e87afe936067a`，且入口的
上述两项兼容都已完成时，补上 `activation: { onStartup: true }`。不增加 hooks、
contracts 或权限授权字段，不覆盖自定义 manifest。

补丁只识别包名及 manifest ID 为 `nsp-clawguard`、入口为 `./dist/index.mjs`，
且具有已知 helper 的以下发布包组合。其他版本或结构记录诊断后跳过。

| package.json | openclaw.plugin.json |
| --- | --- |
| 2.4.13 | 2.4.12 |
| 2.5.0 | 2.5.0 |

`2.4.13` 的 manifest 版本落后一版是 npm 实际发布包的内容，不应按两个版本号
相等来判断；本补丁保留原 manifest 的版本号，不改写它来绕过版本检查。

## 用户状态与文件处理

| 状态 | 行为 |
| --- | --- |
| 未安装，或只有其他用户插件 | 直接返回，不访问、创建或下载插件文件，不改变网关重启需求 |
| 已安装但未启用 | 不读取或修改插件文件；不会自动启用 |
| 已安装且启用，版本和结构匹配 | 备份原入口后替换 helper；在网关加载前完成 |
| 已有 v1 native require 补丁 | 备份 v1 入口后升级到 v2 模块上下文，保留原来的备份 |
| 已打补丁，再次启动或同步 | 不重复写入或新增备份，不因补丁再次触发重启 |
| 重新安装或更新覆盖入口 | 下次配置同步重新检查；禁用状态下等到再次启用才处理 |
| 安装记录残留、目录已不存在 | 不重建目录或安装插件；仅满足下文条件时对齐到已有安装 |
| 版本或入口结构不匹配 | 不修改文件；由日志说明跳过原因 |

检查范围仅为本地插件管理记录和两个安装位置：

- `userData/third-party-extensions/nsp-clawguard`
- `stateDir/extensions/nsp-clawguard`

不扫描其他目录，不修改随包 OpenClaw 文件，不跟随插件目录、入口目录或入口文件的
符号链接。仅由外部配置引用、尚未同步到 LobsterAI 插件管理记录的安装不在本次范围内。

原文件备份位于入口旁，格式为
`index.mjs.lobsterai-native-module-v2.<修改前文件 SHA-256>.bak`。
重复遇到同一原文件时验证并复用备份，不覆盖已有备份。写入复用项目的安全文件替换
逻辑，支持 Windows 的 rename 限制和失败恢复。备份或替换失败会记录错误，不继续
强制改写，不修改其他插件。此时本插件的启动问题可能仍然存在。

2.4.13 的启动声明修改另存
`openclaw.plugin.json.lobsterai-startup-manifest-v1.<原文件 SHA-256>.bak`。
两个文件分别备份和安全替换；入口修复成功而 manifest 写入失败时保留已完成进度，
下次同步继续补齐。manifest 不会在入口仍不兼容时提前激活。

如需回滚，先在插件管理中禁用插件并退出应用，再用匹配的备份恢复入口及已修改的 manifest；保持禁用，
避免下次启用时再次应用补丁。

## 2026-09-22：旧安装记录导致的启动阻断

本次 macOS 日志中，LobsterAI 已给 `third-party-extensions/nsp-clawguard` 下的
`2.5.0` 打过 v2 补丁，但 OpenClaw 仍在验证缺失的
`openclaw/state/extensions/nsp-clawguard`，随后报告
`Failed to update nsp-clawguard: npm package not found for nsp-clawguard@2.4.13`，
拒绝报告 gateway ready。因此仅增加 2.4.13 的入口兼容不能覆盖日志里的阻断。
日志没有安装数据库快照；旧记录的完整字段仍以原机数据为准。

启动前兼容 helper 增加一项定向修复，必须同时满足：

- 当前配置明确启用、允许 clawguard，且加载路径包含当前用户受管的第三方插件目录。
- OpenClaw 的 npm 安装记录明确引用受支持版本，安装路径恰为当前
  `stateDir/extensions/nsp-clawguard`，且目录确实缺失，不是符号链接或无访问权限。
- 当前 `userData/third-party-extensions/nsp-clawguard` 中存在上述受支持发布包，
  文件不是链接，并通过固定版本 OpenClaw 的静态 payload 检查。

修复在停止网关的维护锁及插件生命周期锁内完成：先用 SQLite online backup 保存
包含 WAL 的原数据库，再通过 OpenClaw 官方安装索引接口，将该条旧 npm 记录改为
指向当前已有目录的本地 path 记录，版本取自实际 package.json。旧 npm spec、哈希
不再冒充当前包的下载凭据；已有能力授权字段原样保留，不自动接受新能力。
其他插件记录及当前配置不变。实际安装和更新仍由 LobsterAI 的插件管理入口负责。

备份位于 `stateDir/startup-recovery-backups/nsp-clawguard-*/openclaw.sqlite`。
备份、校验或写入失败时报告启动兼容错误。修复后再次启动不会重复改写或备份。
禁用插件、未知版本、自定义目录、旧安装仍存在，以及新旧目录都缺失的情况均跳过，
不下载、不创建插件目录，也不运行通用 Doctor 修复。

## 验证及限制

自动测试覆盖未安装、禁用、启用、两个安装目录、重复执行、重新安装、未知结构、
CRLF、符号链接、备份冲突、写入失败，以及原生 ESM 和模拟 interop 代理下的
插件注册与宿主文件关闭。异步启动回归用例覆盖原始 helper 和 v1 helper，实际执行
回调并校验带中文、空格、`#` 和 `%` 的模块路径及文件读写；还覆盖 v1 备份保留、
重复升级和已有路径变量时的保守跳过。

此前 v1 的 Windows 隔离网关实验使用真实 `2.5.0` 插件副本、临时状态和独立端口，结果如下。
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

上述历史实验屏蔽了插件的 `gateway_start` 回调，未覆盖异步数据库初始化，
因此没有发现 ready 后退出的问题，不能证明完整启动成功。

2026-09-21 的 v2 验收使用 Electron 43.5.0（Node 24.19.0）客户端、隔离的
用户目录和 npm 发布的 `nsp-clawguard@2.5.0`，通过调试端口和 Playwright/CDP
操作页面，不接管系统键鼠。原始 `dist/index.mjs` 的 SHA-256 为
`5b82694031dfeb06964a00ecb218bec4f2e8ff250f2c23cb0a1057614b90eb25`。
插件保持真实的 `gateway_start`、SQL.js 和后台初始化；配置为 offline，远端
请求由本地拒绝代理返回 503，未屏蔽启动回调。

本机 Windows 的既有加载路径会回退到 Jiti 转译，v1 在该路径下不复现缺失路径变量。
为覆盖日志中的原生 ESM 故障，额外以测试进程预加载脚本，仅将隔离目录内的 NSP
入口改由 Node 原生 ESM 加载，其他插件和 runtime 文件不修改。该对照中，v1
先 ready，随后 `gateway_start` 抛出 `ReferenceError: __dirname is not defined`，
网关退出 1 并重试；v2 自动升级同一份 v1 安装，完成 `lm-security.db` 初始化，
ready 后持续运行超过 90 秒，进程 PID 不变且没有异常退出。

同一客户端内，通过设置页切换插件开关并点击保存，完成禁用和重新启用；随后经
Electron preload 的 `restartGateway()` 接口主动重启。三次操作均恢复 running，
旧进程正常退出 0，启用时真实启动回调和数据库初始化成功。入口 SHA-256、修改时间
及备份列表在反复同步中保持不变，没有因为兼容补丁产生额外重启。
移除原生加载对照脚本后，重新启动 Windows 客户端，常规加载路径也持续运行超过
60 秒；插件启用、数据库可读，`PRAGMA integrity_check` 返回 `ok`。

本次定向 Vitest 用例 24 项通过，两个改动 TypeScript 文件的 ESLint 和
`npm run compile:electron` 通过。验收关注插件启动及网关持续可用性；远端 503
等可恢复日志保留，不作为本次阻塞项处理。

`agent_end` / `llm_output` 的会话访问权限仍由 OpenClaw 检查，补丁没有自动授权。
macOS、Linux 及 QA 原机上的完整插件功能仍需回测。

### 2026-09-22 验收

在 Windows / Electron 43.5.0（Node 24.19.0）上，使用从 npm 发布归档提取的
2.4.13、2.5.0 分别完成旧记录复现、自动修复、正常启动及原生 ESM 重启。
2.4.13 原始入口 SHA-256 为
`782580e2139398d9d66a86c426aa114696d7d0e620a74fd41270adf6b38a6033`；
2.5.0 原始入口 SHA-256 与上文一致。

| 场景 | 结果 |
| --- | --- |
| 旧 npm 记录指向缺失目录，当前包已做入口兼容 | 仍复现启动验证失败及 npm 下载错误 |
| 自动对齐到现有 2.4.13 / 2.5.0 | 原数据库备份保留，旧目录未被重建 |
| 2.4.13 同步注册及启动声明补齐后 | 实际加载并执行 `gateway_start`，SQL.js 初始化成功 |
| 两版本常规启动 | ready 后持续运行 60 秒，插件数据库完整性检查通过 |
| 两版本原生 ESM 再次启动 | 持续运行 15 秒，数据库再次初始化，无缺失模块上下文错误 |
| 再次应用补丁和启动前修复 | 不重复写入入口、manifest 或安装记录，不新增备份 |

测试同时验证 manifest 只增加启动声明、原始字节备份保留，以及已补模块上下文但
仍为 async 注册的 2.4.13 可以继续修复。定向单元测试 54 项、已有启动兼容回归
36 项通过。macOS 原机及在线完整业务功能仍需回测。

### 真实包集成测试的运行方式

`tests/nspClawguardStartup.integration.test.ts` 是显式启用的集成测试，默认跳过。
准备含最新 `openclaw-startup-compat.mjs` 的隔离 runtime，以及已核验的
`nsp-clawguard-2.4.13.tgz`、`nsp-clawguard-2.5.0.tgz` 后设置：

```powershell
$env:NSP_CLAWGUARD_TEST_RUNTIME = '<隔离 runtime 目录>'
$env:NSP_CLAWGUARD_TEST_ARCHIVES = '<两个 tgz 所在目录>'
$env:NSP_CLAWGUARD_TEST_NODE = '<electron.exe 或兼容版本的 node 路径>'
npm test -- tests/nspClawguardStartup.integration.test.ts --maxWorkers=1
```

测试从发布包构造隔离用户目录，以旧 2.4.13 npm 记录指向缺失目录来复现原始阻断，
再验证启动 helper 对齐记录、SQLite 备份、重复启动幂等性。真实 `gateway_start`
及 SQL.js 保持启用，通过插件数据库修改时间和 `integrity_check` 确认每次启动的
初始化确实执行。常规网关启动后观察 60 秒；第二次启动在 Windows 上仅对该临时插件
绕过 Jiti 使用原生 ESM，继续观察 15 秒。远端请求经本地拒绝代理处理，不调用生产服务。
