# 手机删除任务后桌面侧边栏残留任务

日期：2026-10-21

## 问题与目标

手机删除任务后，桌面 Agent 侧边栏仍显示该任务；点击后提示“打开任务失败，请重试”。目标是在桌面本地删除提交后，立即移除所有 Agent 分组和任务活动视图中的对应预览，并防止旧异步结果恢复该条目。

## 原因

现有删除流程已经包含本地事务和通知：

1. `RemoteSessionDeletionClient` 通过既有领取、许可、身份及版本校验后调用 `SessionDeletionService.deleteRemote()`。
2. `SessionDeletionService.commit()` 在同一事务中保存删除回执并删除本地会话；提交后的 cleanup 由 `main.ts` 广播 `CoworkIpcChannel.SessionsChanged`，携带 `deletedSessionIds`。cleanup 重试也可重复发通知。
3. `coworkService` 已监听该字段，移除 Redux 中的会话、关闭被删除的当前会话，并使相关旧加载请求失效。
4. Agent 侧边栏通过 `useAgentSidebarState` 维护独立的 `taskPreviewsByAgentId` 分页缓存。原实现只从 Redux 合并新增/修改的会话，删除缓存仅由桌面删除按钮的回调触发，没有订阅远程删除通知。

因此，本地会话可以已删除、Redux 也已更新，但预览缓存中的条目仍可点击。源码检查和新增回归复现了这一原因；本次未取得用户这次操作的日志，不将截图单独作为远程删除事务成功的证明。

## 实现

- 在 `useAgentSidebarState` 订阅既有 `onSessionsChanged`，只消费明确的 `deletedSessionIds`，移除所有已加载 Agent 下匹配的任务。活动视图与普通分组共享该缓存，自动同步消失。
- 在当前 Hook 生命周期内记录确认删除的 ID；删除前发起的首次加载、重试和分页请求即使迟到，也过滤这些任务。Redux 后续合并同样过滤，保留其他任务和新任务。
- 桌面单条、批量删除复用同一移除入口；重复通知幂等。卸载返回 preload 提供的取消订阅函数，不影响 `coworkService` 的独立监听。
- 不依据 Redux 列表中的缺失推断删除：该列表可能只包含当前 Agent 或一页数据；其他 Agent 的合法缓存应保留。
- 收到普通变更通知、手机仅提交待删除申请、打开任务偶发失败时，不推断已删除，也不绕过既有执行许可或冲突校验。

## 兼容与发布

本次仅修改 LobsterAI 桌面渲染层，沿用现有 IPC 字段和删除协议；无服务端、Portal、Admin、手机 App 代码或数据库变更，无需 MySQL 迁移。已有手机和服务端可继续配合使用，需要发布包含本修复的桌面版本。

删除提交前的等待、失败、撤回和重新确认行为保持原协议；本修复不删除用户电脑上的产物文件。已关闭/重新挂载的侧边栏从本地数据库重新加载，无需持久化新的删除标记。

## 验证

新增 `useAgentSidebarState.deletion.test.ts` 的 8 项回归：

1. 删除仅存在于其他 Agent 预览、未载入 Redux 的任务。
2. 批量跨 Agent 删除、活动视图同步及重复通知。
3. 删除前发起的首屏请求晚到，不能恢复任务。
4. 删除前发起的分页请求晚到，过滤已删除 ID 并保留其余任务。
5. 旧 Redux 摘要不能恢复删除项，新任务仍正常合并。
6. 普通通知和 Redux 缺失不触发误删。
7. 桌面主动删除后旧刷新结果不能恢复任务。
8. 卸载取消删除事件监听。

验证记录：

- 使用旧 Hook 源码基线运行新增用例：7 项失败、1 项通过；修复后新增 8 项与原有 15 项共 23 项通过。测试使用确定性的 React 调度模拟，直接调用真实业务 Hook；不宣称为真实 React 挂载测试。
- `npm test -- src/renderer/components/agentSidebar/useAgentSidebarState.deletion.test.ts src/renderer/components/agentSidebar/useAgentSidebarState.test.ts` 通过。
- `npx tsc --noEmit`、变更 TypeScript 文件的严格 ESLint、`git diff --check` 通过。
- 另在 `/tmp/lobsterai-sidebar-deletion-smoke/` 创建隔离页面，直接打包当前源码 Hook，使用真实 React/React DOM/React Redux，仅替换 IPC 和数据夹具。浏览器验证：发出延迟分页请求后，删除 `main-2`、`main-8`、`app-1`；可见列表立即移除已加载目标；释放旧分页和旧 Redux 摘要后，三个目标均未恢复，其他任务及 `main-new` 保留。截图 `verified.png` 保存于该临时目录，Demo 未进入仓库。
- 未运行服务端测试，未启动连接真实账号的 Electron 实例，未删除用户任务；尚未进行手机与桌面真机联调。

真机验收：分别在主 Agent、自定义 Agent、已展开历史页及活动视图中删除任务；同时覆盖当前打开任务、非当前任务、桌面离线后重新上线，以及删除过程中正在请求下一页。桌面本地删除提交后应移除条目；当前详情按已有逻辑关闭，其他任务仍可正常打开。执行未获许可或失败时不得仅为隐藏报错而移除预览。
