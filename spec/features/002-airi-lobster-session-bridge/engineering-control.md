# 工程控制记录

## 本轮目标

- 完成按 session 拉取 pending permission 列表
- 完成前端权威恢复与过期提示
- 对当前 Bridge 对接进行工程控制复查
- 准备本地 git 存档前的检查依据

## 已执行检查

- LobsterAI 编译
  - `npm run compile:electron`
- airi 类型检查
  - `pnpm -r -F @proj-airi/stage-web run typecheck`
  - `pnpm -r -F @proj-airi/stage-ui run typecheck`
- 文件编码检查
  - 本轮关键改动文件均为 `UTF8-no-BOM`
- 代码诊断检查
  - 关键改动文件 VS Code diagnostics 全部为 0

## 本轮实现摘要

- 服务端新增 `/api/agent/bridge/permission/list`
- 服务端 permission binding 现在保留 `toolName`、`toolInput`
- 前端恢复 pending permission 时优先拉取服务端列表并以服务端为准
- 若服务端无 pending request，则清除本地卡片并提示 expired / not_found 语义

## 合规结论

- 类型检查：通过
- 编译检查：通过
- 文件编码：通过
- 基础协议一致性：通过
- 本地恢复行为：通过

## 仍需收口的风险

- P0
  - 默认 key 仍存在
  - `Access-Control-Allow-Origin: *` 仍开放
  - 技能配置接口仍会直接读写敏感 `.env`
- P1
  - 权限回包仍缺一次性 capability
  - 服务端 pending permissions 仍为内存态，进程重启后丢失
  - temp 上传文件仍缺物理回收
- P2
  - `ChatArea.vue` 继续承载较多技能/权限 UI 逻辑
  - `lobster-bridge.ts` 请求样板仍可抽象
  - `hooks.ts` 与 bridge adapter 仍有进一步收口空间

## 代码质量判断

- 当前改动未发现明显无用函数或死分支新增
- 当前最大“屎山风险”不是单个坏函数，而是：
  - `ChatArea.vue` 逐渐堆积 bridge 管理逻辑
  - `agentApiServer.ts` endpoint 样板与 runner 生命周期逻辑重复
- 当前建议是“先止血再重构”，不建议本轮再做高风险大拆分

## 本地 git 存档建议

- 仅提交本轮 Bridge 相关文件
- 不纳入 `.trae/`、`airi.zip`、无关未追踪目录
- 提交前再次执行：
  - `git status --short`
  - `git diff --stat`

## 本地 git 存档结果

- LobsterAI 本地提交
  - `526ac7a feat: add agent bridge workflow`
- airi 本地提交
  - `105f68c6 feat: integrate lobster bridge into chat ui`
- 说明
  - 两个子仓库已完成本地提交
  - 各仓库仍存在与本轮 Bridge 工作无关的其他未提交改动，未纳入本次归档

## 下一步建议

- 收紧默认 key 与 CORS
- 引入权限一次性 capability
- 增加按 session 的服务端 pending permission 持久化
- 抽离 `ChatArea.vue` 的技能/权限逻辑
