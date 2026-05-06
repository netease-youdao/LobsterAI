# MCP 启动实时发现解耦（P2 子项）

## 1. 背景与问题

在当前启动链路中，`startMcpBridge()` 需要同步等待 `mcpServerManager.startServers()` 完成后，才能继续 `syncOpenClawConfig -> startGateway`。  
当启用的 MCP server 启动慢（例如 `npx` 启动的 stdio server）时，会直接拉长主启动路径。

基于最近两轮启动日志（mac）：

- `start-mcp-servers` 分段耗时分别约 `13.6s`、`14.2s`
- MCP bridge 总耗时分别约 `13.9s`、`14.5s`
- `start-callback-server` 与 `wait-callback-ready` 均为毫秒级

结论：MCP 启动慢点高度集中在“实时发现（startServers + listTools）”，且当前架构把这段耗时硬绑定在启动关键路径上。

---

## 2. 目标

本次仅实现一个目标：

- **启动路径不依赖每次实时发现**

明确不包含：

- 不做内置 MCP 版本固定（如 `@latest -> pin`）
- 不做 server 粒度策略（critical/lazy/on-demand）
- 不做 UI 交互改动

---

## 3. 方案设计（本次实现）

### 3.1 启动快路径：缓存工具清单优先

在 `startMcpBridge()` 中增加缓存命中逻辑：

1. 读取已启用 server 列表并计算指纹（配置 + `updatedAt`）
2. 尝试从本地 `kv` 读取工具清单缓存
3. 若缓存有效（版本、指纹、有效期通过）：
   - 直接使用缓存工具构建 mcp-bridge 配置
   - 不阻塞等待 `startServers()`
   - 主链路继续执行，保证启动流畅

### 3.2 后台校准：异步实时发现

缓存命中后，在后台启动一次实时发现：

1. 异步执行 `mcpServerManager.startServers(enabledServers)`
2. 发现完成后更新内存工具清单与缓存
3. 对比工具签名：
   - 未变化：跳过 sync
   - 有变化：触发一次配置补偿 sync（若网关未 running，则延后到 running 后执行）

### 3.3 运行态补偿

新增一个“running 后补偿”开关：

- 当后台刷新发生在 `ready/starting` 阶段，不立即强行推进重配置
- 在状态 forwarder 监听到 `running` 后，执行一次补偿 `syncOpenClawConfig`

---

## 4. 数据与状态

新增缓存键（SQLite `kv`）：

- `openclaw_mcp_bridge_tools_cache_v1`

缓存结构：

- `version`
- `generatedAt`
- `enabledServersFingerprint`
- `tools[]`

校验规则：

- 版本匹配
- 指纹匹配
- 未过期（当前设置：7 天）

---

## 5. 涉及代码文件

- `src/main/main.ts`
  - MCP 工具清单缓存读写
  - `startMcpBridge()` 快路径命中
  - 后台刷新与运行态补偿 sync
  - 启动追踪日志补充

本次不修改数据库 schema（仅复用 `kv`），对老用户覆盖安装兼容。

---

## 6. 风险与回退

### 6.1 风险

- 缓存过旧时，短时间内可能看到旧工具清单（后台刷新后会校准）
- 背景刷新若检测到工具清单变化，可能触发一次后续补偿 sync

### 6.2 保护措施

- 指纹匹配 + 有效期校验
- 工具签名不变则不触发 sync
- 非 running 阶段延后到 running 再补偿

### 6.3 回退方式

可通过移除缓存命中分支，恢复为“每次启动强制实时发现”的旧路径（代码级可快速回退）。

---

## 7. 验证计划

1. 冷启动 10 次，记录：
   - `mcp-bridge-start-phase:start-mcp-servers`
   - `mcp-bridge-started:totalElapsedMs`
   - `ensure-running-start-gateway` 到 `gateway ready` 耗时
2. 验证缓存命中日志出现（startup cache hit）
3. 验证后台刷新：
   - 变化时仅触发一次补偿 sync
   - 不变化时跳过 sync
4. 验证功能正确性：
   - 网关启动后 MCP 工具可用
   - 不引入额外异常重启/死循环

---

## 8. 后续（未在本次实现）

- server 粒度启动策略（critical/lazy/on-demand）
- 内置 registry 默认项版本固定（降低 `@latest` 抖动）
- UI 层 server 状态可视化（cached/refreshing/ready/error）

