# Electron 端 - 订阅系统接入实现指导

**日期:** 2026-03-14
**依赖:** `2026-03-14-subscription-status-api.md`（API 接口参考）
**技术栈:** Electron 40 + React 18 + Redux Toolkit + TypeScript

---

## 一、总体改动概述

Electron 客户端不处理支付流程（支付在 Portal 完成），主要改动：
1. **authSlice 扩展**：quota 类型从"每日额度"改为"订阅积分"
2. **主进程 IPC**：`auth:getQuota` 接口适配新响应格式
3. **错误处理升级**：proxy 调用新增 40201/40202/40301 错误码处理
4. **积分展示更新**：LoginButton 组件展示套餐名称和剩余积分
5. **引导升级**：免费用户额度耗尽时引导打开 Portal 订阅页

---

## 二、改动文件清单

```
src/renderer/
├── store/slices/authSlice.ts        # 修改：UserQuota 类型扩展
├── services/api.ts                   # 修改：新增错误码处理
├── services/auth.ts                  # 修改：getQuota 响应适配
├── components/LoginButton.tsx        # 修改：积分展示逻辑
├── components/UpgradePrompt.tsx      # 新增：升级提示组件
├── utils/creditsFormat.ts            # 修改：适配新积分字段
└── types/auth.ts                     # 新增/修改：订阅相关类型

src/main/
└── main.ts                           # 修改：auth:getQuota IPC handler 适配
```

---

## 三、类型定义改动

### 3.1 UserQuota 类型扩展

**文件:** `src/renderer/store/slices/authSlice.ts`

```ts
// 旧类型
interface UserQuota {
  dailyCreditsLimit: number
  dailyCreditsUsed: number
  dailyCreditsRemaining: number
  planName?: string
}

// 新类型（向后兼容）
interface UserQuota {
  // 通用字段
  planName: string                     // "免费" | "Basic" | "Pro" | "Premium"
  subscriptionStatus: 'free' | 'active' | 'canceled' | 'expired' | 'suspended'

  // 免费用户
  freeCreditsTotal?: number            // 300（终身总额）
  freeCreditsUsed?: number
  freeCreditsRemaining?: number

  // 付费用户
  monthlyCreditsLimit?: number
  monthlyCreditsUsed?: number
  monthlyCreditsRemaining?: number
  currentPeriodEnd?: string            // "2026-04-01"

  // 兼容旧字段（过渡期保留）
  dailyCreditsLimit?: number
  dailyCreditsUsed?: number
  dailyCreditsRemaining?: number
}
```

---

## 四、authSlice 改动

**文件:** `src/renderer/store/slices/authSlice.ts`

### 4.1 新增 computed 属性

在 slice 中或通过 selector 函数提供便捷访问：

```ts
// selectors.ts 或直接在 authSlice 中
export const selectIsFreeUser = (state: RootState) =>
  state.auth.quota?.subscriptionStatus === 'free'

export const selectCreditsRemaining = (state: RootState) => {
  const q = state.auth.quota
  if (!q) return 0
  return q.subscriptionStatus === 'free'
    ? (q.freeCreditsRemaining ?? 0)
    : (q.monthlyCreditsRemaining ?? 0)
}

export const selectCreditsTotal = (state: RootState) => {
  const q = state.auth.quota
  if (!q) return 0
  return q.subscriptionStatus === 'free'
    ? (q.freeCreditsTotal ?? 300)
    : (q.monthlyCreditsLimit ?? 0)
}

export const selectIsQuotaExhausted = (state: RootState) =>
  selectCreditsRemaining(state) <= 0
```

### 4.2 updateQuota action

确保 `updateQuota` action 能接受新格式数据，不做字段过滤：

```ts
updateQuota: (state, action: PayloadAction<UserQuota>) => {
  state.quota = action.payload
}
```

---

## 五、主进程 auth:getQuota 适配

**文件:** `src/main/main.ts`（auth:getQuota handler 附近）

现有逻辑调用 `GET /api/user/quota`，响应格式已变。

**改动要点:**
- 服务端响应的 `data` 直接透传给 renderer 即可
- 新响应已包含 `planName`、`subscriptionStatus` 等字段
- 如需兼容旧版服务端，检查 `data.subscriptionStatus` 是否存在：

```ts
ipcMain.handle('auth:getQuota', async () => {
  const token = await getAccessToken()
  const res = await fetch(`${serverBaseUrl}/api/user/quota`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  const json = await res.json()
  if (json.code === 0) {
    const data = json.data
    // 兼容：如果服务端还未升级，保留旧字段
    if (!data.subscriptionStatus) {
      data.subscriptionStatus = 'free'
      data.planName = '免费'
    }
    return { success: true, quota: data }
  }
  return { success: false }
})
```

同理，`auth:getUser` handler 返回的 quota 部分也要适配。

---

## 六、api.ts 错误处理升级

**文件:** `src/renderer/services/api.ts`

### 6.1 新增错误码常量

```ts
// 订阅相关错误码
const QUOTA_ERROR_CODES = {
  FREE_QUOTA_EXCEEDED: 40201,    // 免费额度已用完
  MONTHLY_QUOTA_EXCEEDED: 40202, // 本月积分已用完
  MODEL_ACCESS_DENIED: 40301,    // 当前套餐不支持该模型
  QUOTA_EXCEEDED: 40200,         // 旧版兼容
} as const
```

### 6.2 chatWithProxy 错误处理改动

现有逻辑中 `status === 402` 触发 `QUOTA_EXHAUSTED`。改为更精确的处理：

```ts
// 在 proxy SSE 错误事件处理中
if (errorData?.error?.code) {
  const code = errorData.error.code
  switch (code) {
    case 40201:
      throw new ApiError('FREE_QUOTA_EXCEEDED', 402,
        '免费额度已用完，请升级套餐')
    case 40202:
      throw new ApiError('MONTHLY_QUOTA_EXCEEDED', 402,
        '本月积分已用完')
    case 40301:
      throw new ApiError('MODEL_ACCESS_DENIED', 403,
        '当前套餐不支持该模型，请升级套餐')
    default:
      throw new ApiError(errorData.error.message, code)
  }
}
```

### 6.3 SSE error 事件解析

服务端现在会通过 SSE `event: error` 发送错误。确保 SSE 解析器能识别 `event` 字段：

```ts
// 解析 SSE 事件时
if (event.event === 'error') {
  const errorPayload = JSON.parse(event.data)
  // errorPayload.error.code 包含具体错误码
  // errorPayload.error.message 包含中文错误消息
}
```

---

## 七、LoginButton.tsx 积分展示更新

**文件:** `src/renderer/components/LoginButton.tsx`

### 7.1 展示逻辑改动

```tsx
import { useSelector } from 'react-redux'
import { selectIsFreeUser, selectCreditsRemaining, selectCreditsTotal } from '@/store/slices/authSlice'
import { formatCreditsCompact, quotaPercent } from '@/utils/creditsFormat'

function QuotaDisplay() {
  const quota = useSelector((state: RootState) => state.auth.quota)
  const isFree = useSelector(selectIsFreeUser)
  const remaining = useSelector(selectCreditsRemaining)
  const total = useSelector(selectCreditsTotal)

  if (!quota) return null

  return (
    <div className="quota-display">
      <span className="plan-badge">
        {quota.planName}
      </span>
      <div className="credits-bar">
        <div
          className="credits-bar-fill"
          style={{ width: `${quotaPercent(total - remaining, total)}%` }}
        />
      </div>
      <span className="credits-text">
        {isFree
          ? `${formatCreditsCompact(remaining)} / ${formatCreditsCompact(total)}`
          : `本月剩余 ${formatCreditsCompact(remaining)}`
        }
      </span>
    </div>
  )
}
```

### 7.2 套餐名称标签样式

根据 `planName` 显示不同颜色的标签：

```tsx
const planBadgeColor: Record<string, string> = {
  '免费': '#8c8c8c',
  'Basic': '#1890ff',
  'Pro': '#722ed1',
  'Premium': '#faad14',
}
```

---

## 八、UpgradePrompt 组件（新增）

**文件:** `src/renderer/components/UpgradePrompt.tsx`

当用户遇到 40201/40202/40301 错误时，展示升级提示：

```tsx
interface UpgradePromptProps {
  errorCode: number
  onClose: () => void
}

function UpgradePrompt({ errorCode, onClose }: UpgradePromptProps) {
  const messages: Record<number, { title: string; desc: string }> = {
    40201: {
      title: '免费额度已用完',
      desc: '升级套餐获取更多积分，解锁全部模型'
    },
    40202: {
      title: '本月积分已用完',
      desc: '下月积分将自动重置，或升级更高套餐'
    },
    40301: {
      title: '模型权限不足',
      desc: '当前套餐不支持该模型，升级后可使用全部模型'
    },
  }

  const msg = messages[errorCode] ?? { title: '额度不足', desc: '' }

  function openUpgradePage() {
    // 打开系统浏览器跳转 Portal 定价页
    window.electron.shell.openExternal(
      'https://lobsterai.youdao.com/pricing'
    )
  }

  return (
    <div className="upgrade-prompt">
      <h3>{msg.title}</h3>
      <p>{msg.desc}</p>
      <button onClick={openUpgradePage}>升级套餐</button>
      <button onClick={onClose}>关闭</button>
    </div>
  )
}
```

---

## 九、creditsFormat.ts 适配

**文件:** `src/renderer/utils/creditsFormat.ts`

现有的 `formatCreditsCompact` 和 `quotaPercent` 函数入参是数字，无需改动。
调用方需要改为传入正确的字段：

```ts
// 旧调用
quotaPercent(quota.dailyCreditsUsed, quota.dailyCreditsLimit)

// 新调用
const used = quota.subscriptionStatus === 'free'
  ? (quota.freeCreditsUsed ?? 0)
  : (quota.monthlyCreditsUsed ?? 0)
const total = quota.subscriptionStatus === 'free'
  ? (quota.freeCreditsTotal ?? 300)
  : (quota.monthlyCreditsLimit ?? 0)
quotaPercent(used, total)
```

---

## 十、CoworkSessionDetail 错误处理

**文件:** `src/renderer/components/cowork/CoworkSessionDetail.tsx`

在 Cowork 会话的错误回调中，识别新错误码并展示 UpgradePrompt：

```tsx
const [upgradeError, setUpgradeError] = useState<number | null>(null)

// 在 stream error handler 中
if ([40201, 40202, 40301].includes(error.statusCode)) {
  setUpgradeError(error.statusCode)
  return  // 不展示通用 ErrorMessage
}

// 在 JSX 中
{upgradeError && (
  <UpgradePrompt
    errorCode={upgradeError}
    onClose={() => setUpgradeError(null)}
  />
)}
```

---

## 十一、实现优先级

1. **P0 - UserQuota 类型 + authSlice selectors**（数据层基础）
2. **P0 - 主进程 auth:getQuota 适配**（确保 quota 数据正确传递）
3. **P0 - api.ts 错误码处理**（40201/40202/40301）
4. **P1 - LoginButton 积分展示更新**（展示套餐名 + 新积分格式）
5. **P1 - UpgradePrompt 组件**（引导升级）
6. **P2 - creditsFormat 调用点更新**（全局搜索 `dailyCredits` 替换）

---

## 十二、注意事项

1. **积分模型变更**：免费用户是 **300 终身总额**，不是每日限额。UI 文案需要相应调整
2. **订阅管理在 Portal**：Electron 不做支付流程，用户点"升级"时打开系统浏览器跳转 Portal
3. **向后兼容**：保留对旧版 `dailyCreditsLimit`/`dailyCreditsUsed` 的兼容，通过检查 `subscriptionStatus` 字段是否存在判断服务端版本
4. **402 → 细分错误码**：旧版统一返回 402，新版通过 SSE error event 返回具体 code。优先解析 error event 中的 code，fallback 到 HTTP status
5. **Token 无变化**：JWT 认证流程完全不变，只是 quota 响应格式变了
6. **测试要点**：分别测试免费用户（无 planId）和付费用户（有 planId）的 quota 展示和错误处理
