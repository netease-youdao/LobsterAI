# LobsterAI C 端积分查询与充值 Web 系统设计

## 概述

独立的 C 端 Web 系统（lobsterai-portal），面向用户提供积分/套餐余额查询、模型定价查询、充值/购买套餐功能。用户从 Electron 客户端点击登录按钮打开浏览器，通过 URS OAuth 登录后使用。

## 决策记录

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 架构模式 | 轻量 SPA + 复用 Java 后端 API | 不引入新服务，前端独立部署 |
| 前端技术栈 | Vue3 + Ant Design Vue | C 端视觉体验好，团队熟悉 Vue |
| 项目位置 | 独立新仓库 lobsterai-portal | 独立部署、独立迭代 |
| 认证方式 | 复用 URS OAuth + JWT | 与客户端共用同一套认证体系 |

---

## 1. 系统架构

```
┌──────────────────────┐         ┌──────────────────────┐
│  LobsterAI           │         │  lobsterai-portal     │
│  Electron 客户端      │         │  Vue3 + Ant Design Vue│
│                      │         │  C 端用户 Web         │
│  点击「登录/充值」    │────────►│                      │
│  打开系统浏览器       │         │  - 积分余额           │
└──────────────────────┘         │  - 模型定价           │
                                 │  - 充值/购买套餐      │
                                 └──────────┬───────────┘
                                            │ JWT
                                            ▼
                                 ┌──────────────────────┐
                                 │  Java 后端            │
                                 │  Spring Boot + MySQL  │
                                 │                      │
                                 │  复用已有 API:        │
                                 │  - /api/auth/*        │
                                 │  - /api/user/quota    │
                                 │  - /api/plans         │
                                 │  - /api/orders/*      │
                                 │                      │
                                 │  新增 API:            │
                                 │  - /api/user/usage    │
                                 │  - /api/models/pricing│
                                 │  - /api/user/credits/ │
                                 │    summary            │
                                 └──────────────────────┘
```

**关键点**：
- `lobsterai-portal` 是独立仓库，纯前端 SPA，打包后部署到 CDN/Nginx
- 认证复用 URS OAuth 流程 — 用户在浏览器中完成 URS 登录，后端签发 JWT，Web 端存储 JWT 后调用 API
- Java 后端在已有设计文档的 API 基础上，新增 3 个 C 端专属接口

---

## 2. 积分计费模型

### 核心概念

| 概念 | 定义 | 示例 |
|------|------|------|
| 积分（配额点） | 系统内部结算单位，1 美元 = 500,000 积分 | 用户充值 ¥10 ≈ 获得 N 积分 |
| 模型倍率 | 模型 1 token 的积分单价 | Claude Sonnet: 输入 $3/M tokens → 倍率 1.5 |
| 补全倍率 | 输出单价 / 输入单价 | Claude Sonnet: $15/$3 = 补全倍率 5 |

### 计费公式

```
单次调用消耗积分 = (input_tokens × 模型倍率) + (output_tokens × 模型倍率 × 补全倍率)
```

### 示例：Claude Sonnet 一次对话

- 输入 1000 tokens，输出 500 tokens
- 模型倍率 = 1.5，补全倍率 = 5
- 消耗 = (1000 × 1.5) + (500 × 1.5 × 5) = 1500 + 3750 = **5250 积分**

### 数据库新增表

```sql
-- 模型定价表（管理后台可配置）
CREATE TABLE model_pricing (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    model_id VARCHAR(64) NOT NULL,        -- 如 claude-sonnet-4
    model_name VARCHAR(128),              -- 显示名称
    provider VARCHAR(32),                 -- anthropic / openai / deepseek 等
    model_rate DECIMAL(10,4) NOT NULL,    -- 模型倍率
    completion_rate DECIMAL(10,4) NOT NULL,-- 补全倍率
    status TINYINT DEFAULT 1,             -- 1:启用 0:停用
    created_at DATETIME,
    updated_at DATETIME,
    UNIQUE KEY uk_model (model_id)
);
```

### 与套餐的关系

```
API 请求 → 按公式计算本次消耗积分数
    │
    ├── 有套餐且额度未超 → 扣套餐额度（套餐额度用积分单位）
    │
    └── 套餐用完或无套餐 → 扣积分余额
```

原设计文档中 `plans` 表的 `quota_tokens` 字段改为 `quota_credits`（积分额度），套餐和积分统一使用积分单位。

---

## 3. 页面设计

### 页面结构

```
lobsterai-portal/
├── 登录页 /login          # URS OAuth 登录入口
├── 首页 /dashboard        # 积分概览 + 快捷操作
├── 模型定价 /pricing      # 各模型的倍率和单价展示
├── 充值 /recharge         # 套餐购买 + 积分包购买
└── 消费明细 /usage        # 积分消耗流水记录
```

### 各页面职责

**登录页 `/login`**
- URS OAuth 跳转入口，登录成功后回调获取 JWT
- 已登录用户自动跳转 `/dashboard`

**首页 `/dashboard`**
- 当前套餐状态卡片（套餐名称、有效期、剩余额度进度条）
- 积分余额卡片（当前余额、近 7 天消耗趋势小图）
- 快捷入口：充值、查看定价、消费明细

**模型定价 `/pricing`**
- 表格展示所有可用模型
- 列：模型名称、厂商、模型倍率、补全倍率、输入每千 token 消耗积分、输出每千 token 消耗积分
- 支持按厂商筛选
- 数据来源：`GET /api/models/pricing`

**充值 `/recharge`**
- 套餐选购区：Lite / Pro 套餐卡片，月付/年付切换
- 积分包购买区：多档积分包选择
- 点击购买后跳转微信/支付宝支付（或生成二维码）
- 订单创建走 `/api/orders/create`

**消费明细 `/usage`**
- 表格：时间、模型、输入 token、输出 token、消耗积分、扣费来源（套餐/积分）
- 支持按日期范围、模型筛选
- 分页加载
- 数据来源：`GET /api/user/usage`

### 导航布局

```
┌─────────────────────────────────────────────┐
│  Logo    首页  模型定价  充值    用户头像 ▼   │  ← 顶部导航栏
├─────────────────────────────────────────────┤
│                                             │
│              页面内容区域                     │
│                                             │
└─────────────────────────────────────────────┘
```

- 顶部水平导航栏
- 用户头像下拉菜单：消费明细、退出登录
- 移动端响应式适配

---

## 4. 新增后端 API

### 新增接口

```
# 模型定价查询（公开接口，无需登录）
GET /api/models/pricing
Response: {
  list: [
    {
      modelId: "claude-sonnet-4",
      modelName: "Claude Sonnet 4",
      provider: "anthropic",
      modelRate: 1.5,
      completionRate: 5,
      inputPer1k: 1.5,
      outputPer1k: 7.5
    }
  ]
}
查询参数: ?provider=anthropic  (可选，按厂商筛选)

# 用户消费明细（需登录）
GET /api/user/usage
Response: {
  list: [
    {
      id: 1,
      model: "claude-sonnet-4",
      inputTokens: 1000,
      outputTokens: 500,
      costCredits: 5250,
      source: "plan",
      createdAt: "2026-03-08T10:30:00"
    }
  ],
  total: 156,
  page: 1,
  pageSize: 20
}
查询参数: ?page=1&pageSize=20&model=claude-sonnet-4&startDate=2026-03-01&endDate=2026-03-08

# 用户积分概览（需登录，聚合查询）
GET /api/user/credits/summary
Response: {
  balance: 125000,
  plan: {
    name: "Pro",
    quotaCredits: 2500000,
    usedCredits: 800000,
    endDate: "2026-04-07"
  },
  recentUsage: [
    { date: "2026-03-08", credits: 12000 },
    { date: "2026-03-07", credits: 8500 }
  ]
}
```

### 复用已有 API

| 接口 | 用途 |
|------|------|
| `GET /api/auth/login` | 生成 URS 授权 URL |
| `GET /api/auth/callback` | OAuth 回调换 JWT |
| `POST /api/auth/refresh` | 刷新 token |
| `GET /api/user/profile` | 用户基本信息 |
| `GET /api/user/quota` | 套餐/积分余额（简版） |
| `GET /api/plans` | 可购买套餐列表 |
| `POST /api/orders/create` | 创建订单 |
| `POST /api/orders/pay/wechat` | 微信支付 |
| `POST /api/orders/pay/alipay` | 支付宝支付 |

---

## 5. 项目技术架构

### 技术栈

| 层面 | 选型 |
|------|------|
| 框架 | Vue 3 + TypeScript |
| UI 库 | Ant Design Vue 4.x |
| 状态管理 | Pinia |
| 路由 | Vue Router 4 |
| HTTP | Axios |
| 图表 | ECharts（消耗趋势图） |
| 构建 | Vite |
| 包管理 | pnpm |

### 项目结构

```
lobsterai-portal/
├── src/
│   ├── api/
│   │   ├── auth.ts             # 登录/登出/刷新
│   │   ├── user.ts             # 用户信息/积分/消费明细
│   │   ├── models.ts           # 模型定价查询
│   │   ├── orders.ts           # 订单/充值
│   │   └── request.ts          # Axios 实例（JWT 拦截器）
│   ├── views/
│   │   ├── Login.vue           # 登录页
│   │   ├── Dashboard.vue       # 首页概览
│   │   ├── Pricing.vue         # 模型定价
│   │   ├── Recharge.vue        # 充值/购买
│   │   └── Usage.vue           # 消费明细
│   ├── components/
│   │   ├── CreditCard.vue      # 积分余额卡片
│   │   ├── PlanCard.vue        # 套餐状态卡片
│   │   ├── UsageTrend.vue      # 消耗趋势图
│   │   └── Layout.vue          # 顶部导航布局
│   ├── stores/
│   │   ├── auth.ts             # 用户认证状态
│   │   └── user.ts             # 用户积分/套餐数据
│   ├── router/
│   │   └── index.ts            # 路由定义 + 登录守卫
│   ├── utils/
│   │   └── credits.ts          # 积分计算工具函数
│   ├── App.vue
│   └── main.ts
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── .env.production             # API 地址配置
```

### 核心机制

**JWT 拦截器**（`request.ts`）：
- 请求拦截：自动附加 `Authorization: Bearer <token>`
- 响应拦截：401 时尝试 refresh token，失败则跳转登录页

**路由守卫**：
- `/login` 和 `/pricing` 无需登录
- 其余页面需要 JWT，未登录跳转 `/login`

**部署**：
- Vite 打包为静态文件，部署到 CDN 或 Nginx
- Nginx 配置 `try_files` 支持 SPA history 模式路由
