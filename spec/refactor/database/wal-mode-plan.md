# WAL 模式开启方案

> 文件：`.sisyphus/plans/wal-mode-plan.md`  
> 更新：2026-04-03  
> 状态：待评估

---

## 一、背景与问题

### 当前持久化机制

`sql.js` 是纯 WebAssembly 实现的 SQLite，**不直接操作磁盘文件**。其数据库完全驻留在内存中，写入磁盘的方式是：

```typescript
// sqliteStore.ts L304-308
save() {
  const data = this.db.export();          // 序列化整个内存 DB → Uint8Array
  const buffer = Buffer.from(data);
  fs.writeFileSync(this.dbPath, buffer);  // 同步、全量覆盖写盘
}
```

读取时整文件加载进内存：

```typescript
// SqliteStore.create() L58-63
if (fs.existsSync(dbPath)) {
  const buffer = fs.readFileSync(dbPath);
  db = new SQL.Database(buffer);          // 整文件进内存
}
```

### 核心限制：WAL 在 sql.js 下无法生效

1. WAL 模式要求 SQLite 引擎持续维护 `.db-wal` 和 `.db-shm` 两个磁盘文件。  
2. `sql.js` 的 VFS 层运行在内存中，`export()` 输出的是 checkpoint 后的完整 DB 二进制，不产生 WAL 文件。  
3. 即使 `PRAGMA journal_mode=WAL` 执行成功，也只在当次内存连接有效；下次 `export()` → `readFileSync` 重新加载后，WAL 状态丢失，自动回退 DELETE 模式。

---

## 二、持久化层完整调用图

### 依赖注入链

```
main.ts (singleton SqliteStore)
  │  sqliteStore.getDatabase() + .getSaveFunction()
  ├─► CoworkStore(db, saveDb)        [main.ts:750]
  ├─► McpStore(db, saveDb)           [main.ts:1157]
  └─► IMGatewayManager(db, saveDb)   [main.ts:1337-1339]
          └─► IMStore(db, saveDb)    [imGatewayManager.ts:119]
```

所有持久化都通过单一 `SqliteStore` 实例，**无并行数据库连接**，无其他 `.sqlite` 文件直接 I/O。

### `saveDb()` 调用完整统计

经代码精确分析，共 **36 个写触发点**：

| 文件 | 调用次数 | 代表性触发场景 |
|------|---------|---------------|
| `src/main/coworkStore.ts` | **20 次** | session 创建/更新、消息写入、memory 操作（L578, 690, 697, 708, 713, 761, 857, 910, 932, 979, 1005, 1124, 1312, 1355, 1375, 1438, 1567, 1795, 1842, 1850） |
| `src/main/im/imStore.ts` | **12 次** | 平台 config 写入（`setConfigValue` L509）、IM session 映射创建/更新/删除（L1038, 1058, 1071, 1082, 1095）、migration（L90, 484, 651, 730, 855, 927） |
| `src/main/mcpStore.ts` | **4 次** | MCP 服务器增删改（L145, 175, 185, 198） |
| `sqliteStore.ts` 内部 | N 次 | `set()`/`delete()` kv 写入、`initializeTables()` 内 migration（L206, 211, 216, 239, 257, 282, 301, 341, 349） |

**热路径**（高频触发）：
- `IMStore.updateSessionLastActive`（L1058）：每条 IM 消息到来都触发
- `CoworkStore` 消息写入：每次 streaming chunk 写入都触发
- `SqliteStore.set()`：每次 kv 写入（含 token 刷新）

### 常量定义

```typescript
// src/main/appConstants.ts L3
export const DB_FILENAME = 'lobsterai.sqlite';
// 使用位置：sqliteStore.ts L45
```

---

## 三、`sqliteStore.ts` 代码问题清单

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| 1 | 每次写操作同步全量写盘，**阻塞 Electron 主进程** | `save()` L304-308 | 🔴 高 |
| 2 | `initializeTables()` migration 最多触发 **6 次独立 save()** | L206,211,216,239,257,282 | 🟡 中 |
| 3 | 无写节流，IM 高频消息场景下 `writeFileSync` 连续触发 | `IMStore.updateSessionLastActive` | 🔴 高 |
| 4 | `BEGIN TRANSACTION/COMMIT` 与外部 `save()` 逻辑不一致（事务提交后未立即持久化） | L430-456, L481-495 | 🟡 中 |
| 5 | `static sqlPromise` 跨测试实例有状态污染风险 | L36 | 🟢 低 |
| 6 | `getSaveFunction()` 每次调用创建新箭头函数（minor） | L358-360 | 🟢 低 |

---

## 四、方案选项

### 方案 A：维持现状（不开 WAL）

**适用前提：** 当前无明显性能问题，数据库文件 < 10MB。

**理由：** `sql.js` VFS 层不支持真正的 WAL，强行设置 `PRAGMA journal_mode=WAL` 只在当次连接有效，重启后回退。付出理解成本，无实际收益。

---

### 方案 B：批量刷盘（解决真实 I/O 问题）

**思路：** 脏标记 + 定时防抖，将 36 个高频写入合并为低频磁盘操作。仅改 `sqliteStore.ts` 一个文件，**不涉及任何 Store 类**。

**实现：**

```typescript
// sqliteStore.ts 改造（仅修改 save() + 新增 flush()）
private dirty = false;
private flushTimer: NodeJS.Timeout | null = null;

save(immediate = false) {
  if (immediate) {
    this.flush();
  } else {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 500);
    }
  }
}

private flush() {
  if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
  if (!this.dirty) return;
  this.dirty = false;
  const data = this.db.export();
  fs.writeFileSync(this.dbPath, Buffer.from(data));
}
```

在 `app.on('before-quit')` 中调用 `store.flush()` 防止进程退出时数据丢失。

**优点：** 改动极小（1 文件）；IM 高频写场景磁盘写次数可减少 90%+。  
**风险：** 进程意外崩溃最多丢失 500ms 内写入（对话记录、IM session 映射等）。

---

### 方案 C：迁移到 `better-sqlite3`（真正支持 WAL）

**思路：** 以原生 Node.js addon `better-sqlite3` 替换 `sql.js`，直接读写磁盘文件，WAL 完整支持。

#### 改动文件清单（精确）

| 文件 | 改动内容 | 改动量 |
|------|---------|--------|
| `src/main/sqliteStore.ts` | 去掉 WASM 加载、`SqliteStore.sqlPromise`、`save()`、`export()`、`getSaveFunction()`；改为同步构造；初始化 WAL PRAGMA | 大 |
| `src/main/coworkStore.ts` | 构造函数去掉 `saveDb` 参数；删除 **20 处** `this.saveDb()` 调用；`sql.js` API → `better-sqlite3` API | 大 |
| `src/main/im/imStore.ts` | 构造函数去掉 `saveDb` 参数；删除 **12 处** `this.saveDb()` 调用；API 适配 | 大 |
| `src/main/mcpStore.ts` | 构造函数去掉 `saveDb` 参数；删除 **4 处** `this.saveDb()` 调用；API 适配 | 中 |
| `src/main/im/imGatewayManager.ts` | 构造函数去掉 `saveDb` 参数透传 | 小 |
| `src/main/main.ts` | `SqliteStore.create()` 改为同步构造；`getDatabase()`/`getSaveFunction()` 调用点（L750, 1157, 1337-1339）更新 | 小 |
| `src/main/coworkStore.test.ts` | `initSqlJs()` → `new Database(':memory:')`；移除 `saveDb` 空函数 | 小 |
| `electron-builder` 配置 | 添加 `asarUnpack` for `better-sqlite3/*.node` | 小 |
| `package.json` | 添加 `postinstall: electron-rebuild`；`better-sqlite3` 依赖 | 小 |

**sqliteStore.ts 核心改造示例：**

```typescript
import Database from 'better-sqlite3';

export class SqliteStore {
  private db: ReturnType<typeof Database>;

  // 同步构造，无需 async create()
  constructor(userDataPath?: string) {
    const basePath = userDataPath ?? app.getPath('userData');
    const dbPath = path.join(basePath, DB_FILENAME);
    this.db = new Database(dbPath);           // 直接打开文件，无需 export/import
    this.db.pragma('journal_mode = WAL');     // 持久化，重启后保留
    this.db.pragma('synchronous = NORMAL');   // WAL 下 NORMAL 已足够安全
    this.db.pragma('cache_size = -8000');     // 8MB 页缓存（可选优化）
    this.initializeTables();
  }

  // getSaveFunction() 不再需要，返回空操作保持兼容（或直接删除）
  getSaveFunction(): () => void { return () => {}; }

  getDatabase() { return this.db; }
}
```

**Electron 打包注意事项：**

`better-sqlite3` 是原生 C++ addon，需为目标 Electron 版本重新编译：

```json
// package.json
{
  "scripts": {
    "postinstall": "electron-rebuild -f -w better-sqlite3"
  },
  "build": {
    "asarUnpack": ["**/node_modules/better-sqlite3/**"]
  }
}
```

**Windows 中文路径问题：**  
当前 `sql.js` 有专门注释说明用 `fs.readFileSync` 绕过 Emscripten 对中文路径的 hang 问题。`better-sqlite3` 底层通过 `sqlite3_open16`（UTF-16）打开文件，Windows 上 Unicode 路径支持更完整，理论上不受影响，但**需在中文路径环境下实测验证**。

**优点：** 彻底解决 I/O 放大问题；WAL 原子写保证崩溃安全；API 更简洁；同步 API 消除异步初始化复杂性。  
**风险：** 改动 7 个文件，共 36 处 `saveDb()` 调用需逐一清理；需跨平台（macOS/Win/Linux）验证 native addon；Windows 中文路径需实测。

---

## 五、方案对比

| | 方案 A（维持现状） | 方案 B（批量刷盘） | 方案 C（better-sqlite3 + WAL） |
|---|---|---|---|
| **WAL 支持** | ❌ 不可行 | ❌ 不适用 | ✅ 完整 + 持久化 |
| **修改文件数** | 0 | 1 | 7 |
| **saveDb 清理** | 0 | 0 | 36 处 |
| **I/O 性能** | 无改善 | 中（减少 90%+ 写次数） | 高（增量 WAL 写） |
| **崩溃安全性** | 高（即时写盘） | 中（最多丢 500ms） | 高（WAL 原子性） |
| **跨平台风险** | 无 | 无 | 需验证 native addon + 中文路径 |
| **打包复杂度** | 无 | 无 | electron-rebuild + asarUnpack |
| **async 初始化** | 保留 | 保留 | 消除（同步构造） |

---

## 六、建议

**目标是"开启 WAL 减少锁竞争/提高并发读性能"** → 选 **方案 C**，唯一真正有效，评估改动风险后实施。

**目标是"减少 IM/Cowork 高频写导致的 I/O 压力"** → 选 **方案 B**，1 个文件搞定，风险极低。

**当前无明显性能问题，预防性探索** → 选 **方案 A**，`sql.js` 架构下 WAL 无意义，维持现状。

---

## 七、方案 C 实施任务列表（若选择）

- [ ] 安装依赖：`npm install better-sqlite3` + `npm install -D @types/better-sqlite3 electron-rebuild`
- [ ] 改造 `src/main/sqliteStore.ts`：同步构造、WAL PRAGMA、移除 WASM 加载、移除 `save()`/`export()` 机制
- [ ] 改造 `src/main/coworkStore.ts`：移除 `saveDb` 参数 + 20 处调用，适配 better-sqlite3 API
- [ ] 改造 `src/main/im/imStore.ts`：移除 `saveDb` 参数 + 12 处调用，适配 API
- [ ] 改造 `src/main/mcpStore.ts`：移除 `saveDb` 参数 + 4 处调用，适配 API
- [ ] 改造 `src/main/im/imGatewayManager.ts`：移除 `saveDb` 参数透传
- [ ] 改造 `src/main/main.ts`：同步化 SqliteStore 构造，清理 `getSaveFunction()` 调用
- [ ] 更新 `electron-builder` 配置：`asarUnpack` for `better-sqlite3`
- [ ] 更新 `package.json`：`postinstall` + 依赖声明
- [ ] 更新测试文件：`coworkStore.test.ts` 等 8 个测试文件替换 `initSqlJs()`
- [ ] 跨平台验证：macOS / Windows（含中文用户名路径）/ Linux
- [ ] 运行 `npm test` 全量测试通过
