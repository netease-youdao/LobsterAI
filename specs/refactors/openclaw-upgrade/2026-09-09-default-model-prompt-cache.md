# 默认模型变更与已有会话的 system 缓存隔离

## 范围

针对固定版本 `v2026.8.1`，移除 Runtime system 文本中的 `default_model`，保留
当前实际运行的 `model` 以及已有的模型身份说明。

同一 agent 的默认模型可由其他会话操作改变。即使已有会话继续使用自己的模型
override，原先每轮生成的 `default_model` 仍会改变 system，影响后续长历史的前缀复用。

本次不调整 `modelSelectionScope`、sticky model 行为、agent 默认配置、session
override、模型路由或共享记忆更新。

## 实现

补丁：`scripts/patches/v2026.8.1/openclaw-omit-default-model-from-system-prompt.patch`。

- 在上游 `src/agents/system-prompt.ts` 的统一 Runtime 渲染处省略该字段。
  内部 `runtimeInfo.defaultModel` 类型和配置读取保持兼容，仅改变模型接收的提示文本。
- 删除 `src/auto-reply/reply/session-reset-prompt.ts` 三种重置提示中要求比较
  `default_model` 的句子，避免提示词继续依赖已移除的字段。
- 增加真实 system 构造器与 OpenAI Completions 参数构造器的回归测试：默认模型
  改变、缺省时，完整请求保持相同；实际运行模型改变时，模型身份仍更新。
- 在补丁应用脚本中增加强校验，确保该字段及 reset 依赖确实被移除，且实际模型
  输出和回归测试存在。

选择统一渲染处是为了覆盖所有 provider。现有 `lobsterai-model-compat` 的
`transformSystemPrompt` 钩子只覆盖它接管的 provider，且只能处理拼接后的字符串；
为这一字段扩展 provider 接管范围、插件启用配置和文本解析，会增加适配范围。

## 验证

基于 `origin/feat/openclaw-v2026.8.1` 的 `13f833829`，在独立的 OpenClaw
`v2026.8.1` 验证 worktree 中执行，未改动开发者现有 sibling OpenClaw 工作区。

- 修改前：新增测试的 full/minimal 两个请求稳定性用例失败，diff 明确指向
  Runtime 中默认模型值变化；实际模型变更用例通过。
- 整套版本补丁：26 个全部应用成功；新补丁反向应用检查通过。
- 应用整套补丁后：system 默认模型回归 3 项、system prompt 133 项、embedded
  system prompt 6 项、相关 reset 路径 4 项通过，共 146 项。
- 上游变更文件的 Oxlint、Oxfmt 检查通过。
- `npm run compile:electron` 通过；补丁脚本语法检查和 diff 空白检查通过。

针对性测试命令，在应用本项目补丁后的 OpenClaw 源码目录执行：

```sh
node scripts/run-vitest.mjs src/agents/system-prompt-default-model.test.ts src/agents/system-prompt.test.ts src/agents/embedded-agent-runner/run/attempt-system-prompt.test.ts
node scripts/run-vitest.mjs src/auto-reply/reply/session-reset-prompt.test.ts src/auto-reply/reply/session-reset-prompt.runtime-model.test.ts -t 'includes the explicit|uses bootstrap-specific|uses limited bootstrap wording|resolves runtime model context once'
```

### Gateway 验证

使用真实源码 Gateway、独立临时状态目录、loopback HTTP，以及本地模拟 OpenAI
Completions 服务；禁用外部通道和插件，无真实供应商模型调用。

1. 会话 A 指定 `fixture/selected-model`，完成一次请求。
2. 修改默认配置为 `fixture/other-default-model`，确认 Gateway 热加载成功。
3. 会话 B 不指定模型，模拟服务实际收到 `other-default-model`。
4. 会话 A 再请求，实际模型仍是 `selected-model`；两次 A 请求的 system 内容完全相同，
   没有 `default_model=`，保留 `model=fixture/selected-model`。
5. 三次请求成功，Gateway 正常关闭。

禁用插件的验证环境在热加载时有一条 prepared chat metadata 不可用警告，HTTP
请求和上述断言均成功。未执行 Electron 图形界面回测或真实供应商缓存命中率回测。

### 已确认的基线失败

完整的上游 `session-reset-prompt.test.ts` 中，`appends current time line so agents
know the date` 在当前环境期望 `9:00 AM`，实际为 `09:00`。

恢复该生产模块为未经修改的固定版本代码后，同一用例仍以相同时间文本失败。
固定版本的 `resolveCronStyleNow()` 调用 `resolveUserTimeFormat(undefined)`，没有
采用该用例配置的 `timeFormat: "12"`。本次保留该基线问题，没有修改时间格式代码
或放宽断言；三个修改过的 reset 提示路径均已单独验证通过。

## 后续升级

升级 OpenClaw 时，重新检查 Runtime 渲染和 reset 提示；若上游已经保证默认配置
变化不会重写已有会话的 system，且不再依赖已移除字段，可移除此补丁。
验收应比较实际 provider 请求内容，不能仅凭内部缓存边界标记或平均命中率判断。
