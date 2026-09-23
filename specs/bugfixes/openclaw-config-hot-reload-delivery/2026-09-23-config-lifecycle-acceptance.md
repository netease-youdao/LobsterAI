# OpenClaw 配置生命周期客户端验收

## 1. 范围与环境

- 基线：`release/2026.9.23` / `8a478bffa`；分支：`fix/openclaw-config-lifecycle`；固定 OpenClaw `v2026.8.1`。
- 真实 Electron main/preload/renderer、真实 Gateway、真实本地套餐代理，使用独立 appData、工作区和重建运行时。
- Electron 主进程 inspector + `webContents.debugger` CDP 操作界面输入、模型选择和截图。没有使用 computer-use 或系统键鼠。
- 合成账号与本地 OpenAI SSE 服务替代生产套餐服务；测试覆盖客户端链路，不代表生产账号权限、计费或模型服务可用性。
- ACK、回包丢失和限流只在调试启动器中包装 `config.apply` 请求。原生校验拒绝实际调用 Gateway，配置文件外部编辑实际经过 watcher；生产代码没有测试注入接口。
- 调研与清理条件见 [调研记录](2026-09-23-config-lifecycle-research.md)、[设计文档](2026-09-23-config-lifecycle-design.md)。

## 2. 验收结果（2026-09-23）

| 场景 | 端侧操作与结果 | 证据文件前缀 |
| --- | --- | --- |
| 正常任务 | 界面发送 `CONFIG_QA_BASELINE`，请求通过套餐代理抵达 SSE 服务，界面显示完整回复 | `01-` |
| 三个反馈模型 | 通过界面选择 `deepseek-flash`、`deepseek-v4-pro`、`glm-5.3-flash`，三个模型均有端点记录及可见回复 | `06-`、`07-`、`09-` |
| ACK 但未应用 | 保持真实流式任务活动，代理 57511→55729；注入只 ACK 的 apply。pending 保留，源文件仍为旧端口，新任务被阻止，端点没有收到 `CONFIG_QA_UI_BLOCKED` | `05-` |
| 无新设置事件自动恢复 | 解除注入并结束原任务；空闲轮询应用新端口，revision 一致，pending 清除；PID 22536 / 代次 1 不变，遮罩自动消失，新任务成功 | `06-` |
| 失败页面直接重试 | 重复准入拒绝，在同一个失败页面发送 `CONFIG_QA_RETRY_OK`；重新创建真实会话并显示回复，不再向主进程传临时 ID | `12-`、`13-` |
| 实际应用后丢回包 | 实际 apply 后抛传输超时；只读查询确认已应用，仅一次 apply，没有重复写入和进程重启；随后 GLM 请求成功 | `08-`、`09-` |
| 原生校验拒绝 | 提交包含 `agents.defaults.notAConfigField` 的非法配置；返回可见错误，停止自动重启。修正目标后错误清除，同 PID 下正常对话 | `10-`、`11-` |
| 外部写入候选缓存 | 先读取 config.get，再直接添加未知顶层字段。watcher 观察后 config.get 返回 valid=false 和新 revision，applied 仍为旧值；恢复原文件后重新一致 | `04-` |
| 忙碌保护及最新目标 | 流式任务期间提出真实进程重建要求，再连续代理 55436→64420→64421 的普通同步；原任务未被杀，源文件未提前发布，重建要求未被普通同步取消 | `14-` |
| 排空后真实新进程 | 原任务完成后自动重启，PID 22536→17284，代次 1→2；加载最后的 64421 端口，pending/respawn 清除，界面继续对话成功 | `15-` |
| 控制面限流 | 注入 `retryAfterMs=45000`，新任务被阻止。实际 48,594 ms 后才自动重试，PID/代次不变；原失败页发送 `CONFIG_QA_RATE_OK` 成功 | `16-`、`17-` |
| 保留脚本复跑 | 使用仓库内调试启动器、合成服务及 CDP 控制器重开客户端，正常启动后发送 `CONFIG_QA_PORTABLE_SMOKE` 并收到可见回复 | `18-` |

`model-requests.jsonl` 记录核心矩阵 12 次实际模型请求及脚本复跑 1 次；所有 `*_BLOCKED` 标记均未抵达模型服务。
快照同时保存源文件套餐代理地址、valid、原始/解析/应用 revision、pending、进程 PID/代次和工作负载状态。
已查看基线、拒绝、恢复后任务及限流恢复截图，未仅凭主进程状态判定端侧通过。

本轮实操发现并修正两项端侧问题：

1. 热应用后 manager 仍为 running，不会自然发出状态迁移事件；最新同步收敛后补发状态，清除准入失败造成的 starting 遮罩。
2. 首次创建被拒绝时只存在临时 UI 会话；后续新提交改走创建流程，不再调用 continue(temp-id)。不会自动重放此前被拒绝的请求。

证据目录：`C:/Users/yangwn/AppData/Local/Temp/codex-config-lifecycle-20260923`。
其中 `01`—`18` 的 JSON/PNG、`model-requests.jsonl`、测试/构建日志及隔离 appData 保留供本机复核；不提交运行时、账号状态或数据库。

## 3. 自动验证及限制

- 宿主定向 Vitest：9 文件，546 通过、3 跳过；补丁清单：19 通过；renderer 状态/服务回归：3 文件 48 通过。
- 修改 TypeScript 文件 ESLint 无错误/警告；`npm run compile:electron`、完整 `npm run build` 通过。
- 生产改动提交 `908be1e40` 的 GitHub CI 全部通过；保留脚本均通过 `node --check`，并完成上述实际客户端复跑。
- 上游配置读取与 managed-secrets 定向测试：13 通过；Windows 适用补丁 57 项成功应用。
- 扩展上游 `config-reload.test.ts` 在本机出现 watcher/journal 断言失败和超时；没有无补丁对照，不能当作通过，也不能断言为上游既有问题。这里的缓存回迁另由真实外部写入 + 无效候选实操覆盖。
- 没有让 IM/cron 产生真实业务流量；其忙碌保护保留既有行为并有宿主回归。真实环境密钥轮换未操作，本轮验证了相同重建要求路径的显式请求及代次收敛。
- `Session transcript keyed user is outside the current turn` 是网络失败后同 run 重试的独立上游约束。本次消除旧代理配置这个触发源，不承诺任意网络异常后都不会触发该独立问题。
- CI 以 [PR #2755](https://github.com/netease-youdao/LobsterAI/pull/2755) 最新提交为准。

## 4. 复跑方法

调试工具保留于 `scripts/qa/openclaw-config-lifecycle/`，不参与产品构建或默认测试。
必须在隔离工作树中先完成客户端构建和包含补丁的当前平台运行时构建；不能只使用另一个分支的 Gateway bundle。
工具通过编译后 main 模块注入观察点；如果升级后内部函数改名，应更新 `debug-hooks.cjs`，不能改生产逻辑来迁就脚本。

### 4.1 启动与登录

在工作树根目录执行以下 PowerShell 示例（确认端口空闲；共享实操资源需先协调）：

```powershell
$env:LOBSTER_CONFIG_QA_ROOT = (Get-Location).Path
$env:LOBSTER_CONFIG_QA_DIR = Join-Path $env:TEMP 'lobster-config-lifecycle-qa'
$env:LOBSTER_CONFIG_QA_INSPECTOR_PORT = '19564'
$env:LOBSTER_CONFIG_QA_FIXTURE_PORT = '19565'
$env:ELECTRON_RUN_AS_NODE = $null
New-Item -ItemType Directory -Path $env:LOBSTER_CONFIG_QA_DIR -Force | Out-Null
$qaScripts = Join-Path $env:LOBSTER_CONFIG_QA_ROOT 'scripts/qa/openclaw-config-lifecycle'
$qaFixture = Start-Process -FilePath (Get-Command node).Source -ArgumentList ('"{0}"' -f (Join-Path $qaScripts 'fixture.cjs')) -WindowStyle Hidden -PassThru
$qaElectron = Join-Path $env:LOBSTER_CONFIG_QA_ROOT 'node_modules/electron/dist/electron.exe'
$qaClient = Start-Process -FilePath $qaElectron -ArgumentList @('--inspect=19564', ('"{0}"' -f (Join-Path $qaScripts 'bootstrap.cjs'))) -WindowStyle Hidden -PassThru
node "$qaScripts/cdp.cjs" renderer eval 'window.electron.auth.exchange("config-qa")'
node "$qaScripts/cdp.cjs" renderer eval 'location.reload();true'
node "$qaScripts/cdp.cjs" main eval 'globalThis.__configQa.snapshot()'
```

等客户端窗口和 inspector 就绪再登录；等快照 pending=false、engine.phase=running 再操作任务。
不会打开 DevTools 或抢夺系统焦点；renderer 控制经 Electron 的 `webContents.debugger` 进行。
`LOBSTER_CONFIG_QA_DIR` 为必填，所有合成状态写入其 `appdata`、`home`、`documents` 子目录。

### 4.2 核心反例

```powershell
node "$qaScripts/cdp.cjs" renderer type 'CONFIG_QA_HOLD 请保持回复用于验收。'
node "$qaScripts/cdp.cjs" renderer key Enter
```

等 `model-requests.jsonl` 记录 HOLD 且 activeTurns=1，再通过 main eval 运行：

```javascript
(async () => {
  const qa = globalThis.__configQa;
  qa.inject('ack-unapplied', 100);
  const ports = await qa.rebind();
  const sync = await qa.sync({ reason: 'qa:rebind', restartGatewayIfRunning: false });
  return { ports, sync, state: await qa.snapshot() };
})()
```

通过 renderer DOM 点击“新建任务”、输入 `CONFIG_QA_BLOCKED` 并按 Enter，核对可见等待状态且服务没有该标记。
然后 `main eval 'globalThis.__configQa.inject(null)'`，POST `http://127.0.0.1:19565/__qa/release` 释放原流式任务。
不触发新设置，等待自动恢复；在原失败页发送 `CONFIG_QA_RECOVERED`，核对真正的模型回复和端点记录。
截图命令：`node "$qaScripts/cdp.cjs" renderer screenshot <绝对路径.png>`。

其他反例：

- `qa.inject('timeout-committed')`：下一次实际 apply 后丢弃回包；rebind + sync 后核对只提交一次。
- `qa.inject('invalid')`：下一次 apply 使用原生不合规字段；检查可见错误和无重启，再解除注入、改变目标并 sync。
- `qa.inject('rate-limit')`：下一次返回 45 秒限流；对比 `qa.events` 时间戳，不要用新的 sync 事件替代定时恢复。
- 保持 HOLD，先 `sync({reason:'qa:respawn',restartGatewayIfRunning:true})`，再两次 rebind + 普通 sync，释放 HOLD；检查旧任务完成、PID/代次变更和最后目标生效。
- 外部无效候选必须先备份隔离目录的 `openclaw.json`，添加未知字段后读取 config.get，再恢复原始字节；不要在生产配置上注入。

清理时调用 `main eval 'globalThis.__configQa.shutdown()'` 停止本次客户端/Gateway，再停止启动时记录的 `$qaFixture.Id`。
如有本次客户端派生的后台辅助进程遗留，核对父 PID 和工作树路径后单独停止；不要批量停止机器上的 Electron/Node。
