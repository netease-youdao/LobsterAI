# SQLite 自动备份与恢复

更新日期：2026-04-20
状态：已实现

## 目的

本文档描述 LobsterAI 中 SQLite 自动备份与恢复功能的最终实现。目标是让后续维护者在不阅读早期设计稿和实施计划的前提下，也能快速理解当前代码的运行方式、数据布局、恢复流程、运行边界和测试覆盖。

## 范围

当前功能覆盖：

- 主 SQLite 数据库的周期性备份
- 数据库文件损坏或不可读时的启动恢复
- 启用自动备份后，启动阶段的健康检查
- 恢复前对损坏数据库文件的隔离保存
- 一个用于启用或关闭自动备份与恢复的用户设置项

当前功能不覆盖：

- 时间点级别的恢复
- 多快照保留
- UI 中手动选择某个备份进行恢复
- 备份加密
- 备份文件的云端同步

## 文件分布

核心实现文件：

- `src/main/libs/sqliteBackup/constants.ts`
- `src/main/libs/sqliteBackup/sqliteBackupManager.ts`
- `src/main/sqliteStore.ts`
- `src/main/main.ts`
- `src/renderer/components/Settings.tsx`
- `src/renderer/services/i18n.ts`

验证与辅助文件：

- `src/main/libs/sqliteBackup/sqliteBackupManager.test.ts`
- `src/main/libs/sqliteBackup/sqliteBackupRecovery.test.ts`
- `tests/sqlite-backup/README.md`
- `tests/sqlite-backup/generate-large-db.cjs`

## 运行模型

### 数据库打开路径

`SqliteStore.create()` 不再直接实例化 `better-sqlite3`，而是通过 `openSqliteDatabaseWithRecovery()` 打开主数据库。

打开流程：

1. 打开主数据库文件。
2. 应用推荐的 WAL 相关 pragma。
3. 如果 SQLite 抛出可恢复的启动错误，则尝试使用快照恢复。
4. 用恢复后的数据库文件重新打开，并再次应用 pragma。

当前被视为“可恢复启动错误”的情况主要是损坏相关错误，例如 `SQLITE_CORRUPT`、`SQLITE_NOTADB`，以及包含 malformed / not a database 等信息的错误消息。

### 健康检查路径

当 `app_config.sqliteAutoBackupEnabled === true` 时，`SqliteStore.create()` 会在数据库成功打开后额外执行一次 `PRAGMA quick_check`。

流程如下：

1. 通过带恢复能力的打开路径打开数据库。
2. 从 `kv` 表读取 `app_config`。
3. 如果开启了自动备份，则执行 `verifyDatabaseHealth()`。
4. 如果健康检查失败，则关闭当前数据库，恢复最新有效快照，并重新打开数据库。

这条路径比“启动时报错再恢复”更严格，因为它能捕获“数据库能打开，但健康检查已失败”的情况。

## 备份存储布局

所有备份文件都放在 Electron 的 `userData` 目录下。

```text
backups/sqlite/
  manifest.json
  snapshots/
    lobsterai-latest.sqlite
    lobsterai-latest.sqlite.previous
  quarantine/
    2026-04-20T13-14-15-016/
      lobsterai.sqlite
      lobsterai.sqlite-wal
      lobsterai.sqlite-shm
      restore-context.json
```

### 文件说明

- `manifest.json`：保留快照的元数据
- `snapshots/lobsterai-latest.sqlite`：当前发布中的快照文件
- `snapshots/lobsterai-latest.sqlite.previous`：发布中断时用于回退的旧快照
- `quarantine/<timestamp>/`：恢复前被移走的损坏线上数据库文件
- `restore-context.json`：记录本次恢复使用了哪个快照、恢复发生在何时

## 备份创建

备份创建由 `SqliteBackupManager.createBackup()` 实现。

### 备份机制

这里没有直接使用文件复制，而是使用 `better-sqlite3` 的在线备份 API。原因是应用运行在 WAL 模式下，备份必须基于 SQLite 的一致性快照，而不能简单复制主数据库文件。

流程如下：

1. 在 `snapshots/` 中创建一个临时快照路径。
2. 调用 `db.backup(tempFilePath, { progress })`。
3. 以只读方式打开临时快照文件。
4. 执行 `PRAGMA quick_check`。
5. 如果临时快照健康，则将其发布为 `lobsterai-latest.sqlite`。
6. 计算文件大小和 SHA-256。
7. 写入 `manifest.json`。

### progress 回调

备份进度回调每轮返回 `100` 页。这个值与 `better-sqlite3` 的默认推荐值一致，用来把备份工作拆成较小批次，避免一次性长时间占用事件循环。

### 发布策略

快照发布使用 swap 文件机制：

1. 先将当前已发布快照重命名为 `.previous`。
2. 再把临时快照重命名为正式快照路径。
3. 如果发布过程中失败，则尝试把 `.previous` 恢复回去。

这样做的目的是避免在重命名过程中出错时，把唯一保留的可用快照也破坏掉。

## 保留策略

当前实现的保留策略非常简单：

- 只保留一个逻辑快照
- `SQLITE_BACKUP_RETENTION_COUNT = 1`
- manifest 仍然使用数组结构，便于未来扩展到多快照而不用重做格式

由于当前发布文件名是固定的，因此旧快照删除逻辑主要是为后续扩展做准备。

## 恢复流程

恢复由 `SqliteBackupManager.restoreLatestBackup()` 实现。

### 恢复步骤

1. 读取 `manifest.json`。
2. 按时间从新到旧遍历快照。
3. 解析快照的实际可恢复路径。
4. 第一次尝试恢复前，先把当前线上数据库文件移动到隔离目录。
5. 将快照复制回线上数据库路径。
6. 删除线上残留的 `-wal` 和 `-shm` 文件。
7. 打开恢复后的数据库并执行 `PRAGMA integrity_check`。
8. 如果校验通过，则把该快照标记为 `restoreTested: true`。
9. 写入 `restore-context.json`。

如果某个快照恢复后校验失败，管理器会记录 warning，删除本次失败恢复出来的文件，并继续尝试下一个候选快照。

### 隔离行为

恢复前会尽量移动以下文件：

- `lobsterai.sqlite`
- `lobsterai.sqlite-wal`
- `lobsterai.sqlite-shm`

这样既能保留故障现场，也能避免恢复时直接覆盖原始损坏文件。

### `.previous` 回退

如果 `snapshots/lobsterai-latest.sqlite` 不存在，但 `snapshots/lobsterai-latest.sqlite.previous` 还在，则恢复逻辑会使用 `.previous`。这用于处理“备份发布中途被打断”的场景。

## 周期性备份循环

周期调度由主进程负责，而不是由 `SqliteStore` 自己维护。

### 启动行为

在 `initApp()` 中：

1. 创建单例 `SqliteBackupManager`。
2. 读取 `app_config.sqliteAutoBackupEnabled`。
3. 如果已启用，则启动周期备份循环。

### 配置变更行为

应用会监听 `app_config` 变化：

- 当设置从 `false` 变为 `true` 时，启动循环
- 当设置从 `true` 变为 `false` 时，停止循环

### 调度规则

`shouldCreatePeriodicBackup()` 在以下情况返回 `true`：

- 启用了强制启动备份环境变量
- 当前没有任何保留快照
- 当前保留快照文件丢失
- 最新快照已超过设定时间间隔

当前间隔为：

- `SQLITE_BACKUP_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000`
- 实际周期：每 3 天一次

支持的覆盖环境变量：

- `LOBSTERAI_SQLITE_BACKUP_ALWAYS_ON_STARTUP=1`
- 启动时无论快照年龄如何，都强制立即执行一次备份

## 设置项接入

Renderer 暴露了一个设置开关，底层对应 `app_config.sqliteAutoBackupEnabled`。

用户可见文案：

- 中文：`启用自动备份与恢复`
- 英文：`Enable Auto Backup and Recovery`

这个设置控制的是“自动备份”以及“启动阶段健康检查失败后的恢复”。

需要注意的是，更底层的 `openSqliteDatabaseWithRecovery()` 启动损坏恢复路径依然存在，因为当数据库根本无法打开时，必须先做这层恢复，应用才有机会继续启动。

## Manifest 格式

`manifest.json` 目前存储：

- `version`
- `updatedAt`
- `snapshots[]`

每条快照记录包含：

- `id`
- `fileName`
- `createdAt`
- `trigger`
- `sizeBytes`
- `checksumSha256`
- `quickCheck`
- `sourceUserVersion`
- `sourceSchemaVersion`
- `restoreTested`

当前 manifest 版本为 `1`。

## WAL 与 PRAGMA 选择

主数据库打开后会设置以下 pragma：

- `journal_mode = WAL`
- `synchronous = NORMAL`
- `cache_size = -8000`
- `wal_autocheckpoint = 1000`

原因如下：

- WAL 更适合当前应用的运行写入模型
- 在 WAL 模式下，`NORMAL` 是当前这套配置的目标同步级别
- 备份通过 SQLite 官方 backup API 创建，因此在 WAL 模式下仍能得到一致性快照

## 日志策略

实现遵守主进程日志规范：

- 生命周期事件使用 `console.log`
- 可恢复异常使用 `console.warn`
- 失败使用 `console.error`
- 高频备份进度使用 `console.debug`

这样可以避免把每轮 page 级别进度刷到 info 日志里。

## 测试覆盖

当前自动化测试覆盖了：

- 备份目录路径构造
- manifest 保留逻辑
- 备份创建
- 备份周期判定
- 健康检查行为
- 从损坏线上数据库恢复
- 启动打开路径上的自动恢复
- 发布中断时通过 `.previous` 回退恢复

另外，`tests/sqlite-backup/` 下提供了生成大数据库的辅助脚本和说明文档，便于手动验证。

## 已知限制

- 只支持保留一个快照
- 恢复策略仅支持“恢复最新有效快照”，没有 UI 让用户选择历史快照
- 备份元数据写入是文件级操作，并不与主数据库事务绑定
- 隔离目录中的历史损坏文件目前不会自动清理
- 备份创建和启动健康检查使用 `quick_check`，而恢复完成后的最终验证使用更严格的 `integrity_check`
- 设置开关只控制自动行为，数据库根本无法打开时的底层恢复路径仍然始终存在

## 后续扩展时需要保持的约束

如果后续要扩展该功能，建议保持以下不变量：

- 不能把未经校验的快照直接替换为线上数据库
- 恢复前必须先隔离当前线上文件
- `.previous` 必须继续作为发布中断恢复协议的一部分
- 备份创建必须继续兼容 WAL 模式
- 不要在紧密备份循环里加入 info 级别日志

当前可以相对安全扩展的方向包括：

- 多快照保留
- 手动恢复 UI
- 隔离目录清理策略
- 更丰富的恢复元数据
- 在设置页展示备份状态与诊断信息

## 建议阅读顺序

如果后续维护者想快速理解这套实现，建议按以下顺序阅读：

1. `src/main/libs/sqliteBackup/constants.ts`
2. `src/main/libs/sqliteBackup/sqliteBackupManager.ts`
3. `src/main/sqliteStore.ts`
4. `src/main/main.ts`
5. `src/main/libs/sqliteBackup/sqliteBackupRecovery.test.ts`

这个顺序基本对应运行时从配置、到恢复、到调度、到验证的路径。
